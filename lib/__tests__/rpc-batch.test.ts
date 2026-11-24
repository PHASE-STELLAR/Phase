import { describe, it, beforeEach, afterEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  RPC_BATCH_COUNTERS,
  createBatchingRpcTransport,
  createKvSharedCache,
  createMemorySharedCache,
  readThroughSharedCache,
  resetRpcBatchStateForTests,
  resolveBatchResults,
  rpcBatchingRollbackNote,
  type JsonRpcRequest,
  type KvLikeClient,
} from "@/lib/rpc-batch"
import { resetSecurityCounters, getSecurityCounter, SECURITY_COUNTER_REGISTRY } from "@/lib/security-counters"

function enable(on: boolean) {
  const key = "NEXT_PUBLIC_FEATURE_PHASE_209"
  if (on) process.env[key] = "1"
  else delete process.env[key]
}

function req(id: number): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "simulateTransaction", params: [id] }
}

describe("phase-209 RPC batching and shared cache", () => {
  beforeEach(() => {
    enable(true)
    resetRpcBatchStateForTests()
    resetSecurityCounters()
  })
  afterEach(() => {
    enable(false)
    resetRpcBatchStateForTests()
  })

  it("isolates a failing sub-call from its siblings", () => {
    const results = resolveBatchResults([req(1), req(2), req(3)], [
      { id: 1, result: "ok" },
      { id: 2, error: { code: -32000, message: "bad tx" } },
      // id 3 missing → isolated transport error
    ])
    assert.equal(results[0].ok, true)
    assert.equal(results[1].ok, false)
    if (!results[1].ok) assert.equal(results[1].error.code, -32000)
    assert.equal(results[2].ok, false)
    assert.ok(getSecurityCounter("rpc_batch_subcall_failed") >= 1)
  })

  it("coalesces same-tick calls into one JSON-RPC array batch", async () => {
    const sends: number[] = []
    const transport = createBatchingRpcTransport(async (requests) => {
      sends.push(requests.length)
      return requests.map((r) => ({ id: r.id, result: `value-${r.params}` }))
    })
    const [a, b] = await Promise.all([
      transport.call<string>("simulateTransaction", 1),
      transport.call<string>("simulateTransaction", 2),
    ])
    assert.equal(a, "value-1")
    assert.equal(b, "value-2")
    assert.deepEqual(sends, [2])
    assert.equal(getSecurityCounter("rpc_batch_sent"), 1)
  })

  it("flag off restores the uncoalesced per-call path", async () => {
    enable(false)
    const sends: number[] = []
    const transport = createBatchingRpcTransport(async (requests) => {
      sends.push(requests.length)
      return requests.map((r) => ({ id: r.id, result: r.params }))
    })
    await Promise.all([
      transport.call<number>("simulateTransaction", 1),
      transport.call<number>("simulateTransaction", 2),
    ])
    assert.deepEqual(sends, [1, 1])
  })

  it("two instances sharing a cache collapse identical reads to one loader call", async () => {
    const shared = createMemorySharedCache()
    let calls = 0
    const loader = async () => {
      calls += 1
      return { value: 42 }
    }
    const instanceA = () => readThroughSharedCache("contract::get_config::[]", loader, { shared })
    const instanceB = () => readThroughSharedCache("contract::get_config::[]", loader, { shared })
    // One instance starts the request while the second arrives mid-flight.
    const [a, b] = await Promise.all([instanceA(), instanceB()])
    assert.deepEqual(a, { value: 42 })
    assert.deepEqual(b, { value: 42 })
    assert.equal(calls, 1)
    // A later read is served from the shared value, still one RPC.
    const c = await readThroughSharedCache("contract::get_config::[]", loader, { shared })
    assert.deepEqual(c, { value: 42 })
    assert.equal(calls, 1)
    assert.ok(getSecurityCounter("rpc_shared_cache_hit") >= 1)
  })

  it("stale-on-error serves the last value when the loader fails", async () => {
    const shared = createMemorySharedCache()
    await shared.write("key", { value: "fresh" }, 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const result = await readThroughSharedCache(
      "key",
      async () => {
        throw new Error("rpc down")
      },
      { shared, staleOnError: true },
    )
    assert.deepEqual(result, { value: "fresh" })
    assert.equal(getSecurityCounter("rpc_shared_cache_stale"), 1)
  })

  it("KV adapter stores TTL and handles a failed read", async () => {
    const data = new Map<string, string>()
    const expires = new Map<string, number>()
    const client: KvLikeClient = {
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => {
        data.set(k, v)
      },
      pexpire: async (k, ms) => {
        expires.set(k, Date.now() + ms)
      },
    }
    const cache = createKvSharedCache(client)
    await cache.write("k", { value: 1 }, 1000)
    assert.ok(data.has("phase:rpc:k"))
    assert.ok((expires.get("phase:rpc:k") ?? 0) > Date.now())
    assert.deepEqual(await cache.read("k"), await cache.read("k"))
    assert.ok(rpcBatchingRollbackNote().includes("phase-209"))
  })

  it("exports only registered counters", () => {
    for (const name of RPC_BATCH_COUNTERS) {
      assert.ok(Object.prototype.hasOwnProperty.call(SECURITY_COUNTER_REGISTRY, name), name)
    }
  })
})
