import { describe, it, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  createBatchLoader,
  isOwnerBatchLoaderEnabled,
  ownerBatchLoaderRollbackNote,
} from "@/lib/owner-batch-loader"

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_159 = "1"
    process.env.FEATURE_PHASE_159 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_159
    delete process.env.FEATURE_PHASE_159
  }
}

describe("phase-159 owner batch loader", () => {
  beforeEach(() => enable(true))

  it("coalesces same-tick loads into a single batch call", async () => {
    const batches: number[][] = []
    const loader = createBatchLoader<number, string>(async (keys) => {
      batches.push([...keys])
      return keys.map((k) => `owner-${k}`)
    })

    const results = await Promise.all([loader.load(1), loader.load(2), loader.load(3)])
    assert.deepEqual(results, ["owner-1", "owner-2", "owner-3"])
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0], [1, 2, 3])
  })

  it("deduplicates repeated keys within a tick", async () => {
    const batches: number[][] = []
    const loader = createBatchLoader<number, string>(async (keys) => {
      batches.push([...keys])
      return keys.map((k) => `owner-${k}`)
    })

    const [a, b] = await Promise.all([loader.load(7), loader.load(7)])
    assert.equal(a, "owner-7")
    assert.equal(b, "owner-7")
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0], [7])
  })

  it("chunks by maxBatchSize", async () => {
    const batches: number[][] = []
    const loader = createBatchLoader<number, number>(
      async (keys) => {
        batches.push([...keys])
        return keys.map((k) => k * 10)
      },
      { maxBatchSize: 2 },
    )

    const results = await loader.loadMany([1, 2, 3, 4, 5])
    assert.deepEqual(results, [10, 20, 30, 40, 50])
    assert.equal(batches.length, 3)
  })

  it("memoizes resolved values across ticks", async () => {
    let calls = 0
    const loader = createBatchLoader<number, number>(async (keys) => {
      calls += 1
      return keys.map((k) => k)
    })
    await loader.load(1)
    await loader.load(1)
    assert.equal(calls, 1)

    loader.clearAll()
    await loader.load(1)
    assert.equal(calls, 2)
  })

  it("rejects a key when batchFn returns an Error at its position", async () => {
    const loader = createBatchLoader<number, string>(async (keys) =>
      keys.map((k) => (k === 2 ? new Error("missing") : `owner-${k}`)),
    )
    const results = await loader.loadMany([1, 2, 3])
    assert.equal(results[0], "owner-1")
    assert.ok(results[1] instanceof Error)
    assert.equal(results[2], "owner-3")
  })

  it("reflects the phase-159 flag and exposes a rollback note", () => {
    assert.equal(isOwnerBatchLoaderEnabled(), true)
    enable(false)
    assert.equal(isOwnerBatchLoaderEnabled(), false)
    assert.match(ownerBatchLoaderRollbackNote(), /phase-159/)
  })
})
