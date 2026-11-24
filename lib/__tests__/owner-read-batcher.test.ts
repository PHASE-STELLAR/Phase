import { describe, it, beforeEach, afterEach } from "vitest"
import * as assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mgetStoreRecords, mgetStores, updateStore } from "@/lib/json-store"
import {
  benchmarkOwnerReads,
  createOwnerReadBatcher,
  isOwnerReadBatchingEnabled,
  ownerReadBatchingRollbackNote,
} from "@/lib/owner-read-batcher"
import { setCachedExploreOwners, clearExploreOwnersCache } from "@/lib/explore-owners-cache"
import { resetSecurityCounters } from "@/lib/security-counters"

function enable(on: boolean) {
  const key = "NEXT_PUBLIC_FEATURE_PHASE_210"
  if (on) process.env[key] = "1"
  else delete process.env[key]
}

let dataDir: string
let savedDataDir: string | undefined

beforeEach(() => {
  enable(true)
  clearExploreOwnersCache()
  resetSecurityCounters()
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-owner-batch-"))
  savedDataDir = process.env.PHASE_SERVER_DATA_DIR
  process.env.PHASE_SERVER_DATA_DIR = dataDir
})

afterEach(() => {
  enable(false)
  clearExploreOwnersCache()
  if (savedDataDir === undefined) delete process.env.PHASE_SERVER_DATA_DIR
  else process.env.PHASE_SERVER_DATA_DIR = savedDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("phase-210 owner read batching", () => {
  it("mget reads many records from one sidecar in a single read", async () => {
    await updateStore<Record<string, string>>("ownerIndex", (store) => {
      store["1"] = "GONE"
      store["2"] = "GTWO"
    })
    const records = await mgetStoreRecords<string>("ownerIndex", ["1", "2", "3"], () => ({}))
    assert.deepEqual(records, { 1: "GONE", 2: "GTWO" })
    const stores = await mgetStores(["ownerIndex", "ownerIndex"], () => ({}))
    assert.equal(stores.size, 1)
  })

  it("collapses N owner reads into chunked batch calls", async () => {
    const batches: number[][] = []
    let perTokenCalls = 0
    const batcher = createOwnerReadBatcher({
      loadOne: async (id) => {
        perTokenCalls += 1
        return `G${id}`
      },
      loadOwnerBatch: async (ids) => {
        batches.push([...ids])
        return ids.map((id) => `G${id}`)
      },
      maxBatchSize: 3,
      useIndex: false,
      useSidecar: false,
    })
    const ids = Array.from({ length: 7 }, (_, i) => i + 1)
    const results = await batcher.loadMany(ids)
    assert.deepEqual(results, ids.map((id) => `G${id}`))
    assert.deepEqual(batches, [[1, 2, 3], [4, 5, 6], [7]])
    assert.equal(perTokenCalls, 0)
  })

  it("index pushdown and sidecar mget answer before the RPC batch", async () => {
    await updateStore<Record<string, string>>("ownerIndex", (store) => {
      store["2"] = "GSIDECAR"
    })
    setCachedExploreOwners("contract", 5, [
      { id: 1, owner: "GINDEX" },
      { id: 3, owner: "GINDEX3" },
    ])
    let rpcIds: number[] = []
    const batcher = createOwnerReadBatcher({
      loadOne: async () => null,
      loadOwnerBatch: async (ids) => {
        rpcIds = [...ids]
        return ids.map(() => null)
      },
      useIndex: true,
      useSidecar: true,
    })
    await batcher.loadMany([1, 2, 3, 4])
    assert.deepEqual(rpcIds, [4])
  })

  it("stale-on-error keeps individual failures isolated", async () => {
    const batcher = createOwnerReadBatcher({
      loadOne: async () => "GFRESH",
      loadOwnerBatch: async () => {
        throw new Error("rpc down")
      },
      useIndex: false,
      useSidecar: false,
    })
    const results = await batcher.loadMany([1, 2])
    assert.equal(results.length, 2)
    assert.ok(results.every((r) => r instanceof Error))
    // The unbatched fallback still serves a fresh value.
    enable(false)
    assert.equal(await batcher.load(1), "GFRESH")
  })

  it("benchmark shows a lower RPC count than the unbatched path", async () => {
    const result = await benchmarkOwnerReads({
      tokenIds: [1, 2, 3, 4, 5, 6],
      loadOne: async (id) => `G${id}`,
      loadOwnerBatch: async (ids) => ids.map((id) => `G${id}`),
      maxBatchSize: 3,
      useIndex: false,
      useSidecar: false,
    })
    assert.equal(result.unbatchedRpcCalls, 6)
    assert.equal(result.batchedRpcCalls, 2)
    assert.equal(result.identicalResults, true)
  })

  it("flag off is the original per-token path", () => {
    enable(false)
    let calls = 0
    const batcher = createOwnerReadBatcher({
      loadOne: async (id) => {
        calls += 1
        return `G${id}`
      },
      loadOwnerBatch: async (ids) => {
        throw new Error("must not batch")
      },
    })
    return batcher.loadMany([1, 2, 3]).then((results) => {
      assert.equal(calls, 3)
      assert.deepEqual(results, ["G1", "G2", "G3"])
      assert.equal(isOwnerReadBatchingEnabled(), false)
      assert.ok(ownerReadBatchingRollbackNote().includes("phase-210"))
    })
  })
})
