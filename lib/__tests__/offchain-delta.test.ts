import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { computeDeltaHash, buildOnChainStub, parseOnChainStub, storeOffchainDelta, fetchOffchainDelta, clearDeltaMemoryStore } from "@/lib/offchain-delta"

describe("phase-122 off-chain delta", () => {
  beforeEach(() => {
    clearDeltaMemoryStore()
    process.env.FEATURE_PHASE_122 = "1"
  })

  it("hash is deterministic", () => {
    const payload = { name: "Test", image: "ipfs://..." }
    const h1 = computeDeltaHash(payload)
    const h2 = computeDeltaHash(payload)
    assert.equal(h1, h2)
    assert.equal(h1.length, 64)
  })

  it("stub round-trips", () => {
    const stub = buildOnChainStub(42, "a".repeat(64))
    assert.equal(stub, "delta:42:aaaaaaaa")
    const parsed = parseOnChainStub(stub)
    assert.equal(parsed?.tokenId, 42)
    assert.equal(parsed?.hashPrefix, "aaaaaaaa")
  })

  it("rejects invalid stub", () => {
    assert.equal(parseOnChainStub("delta:0:abc"), null)
    assert.equal(parseOnChainStub("not-a-stub"), null)
  })

  it("stores and fetches delta", async () => {
    const contractId = "C" + "A".repeat(55)
    const tokenId = 7
    const payload = { name: "Artifact #7", description: "Large metadata..." }
    const stored = await storeOffchainDelta(contractId, tokenId, payload)
    assert.equal(stored.ok, true)
    if (stored.ok) assert.equal(stored.hash.length, 64)
    const fetched = await fetchOffchainDelta(contractId, tokenId)
    assert.equal(fetched.ok, true)
    if (fetched.ok) assert.deepEqual(fetched.data, payload)
  })

  it("detects hash mismatch", async () => {
    const contractId = "C" + "B".repeat(55)
    await storeOffchainDelta(contractId, 1, { a: 1 })
    const res = await fetchOffchainDelta(contractId, 1, { expectedHash: "f".repeat(64) })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.code, "HASH_MISMATCH")
  })

  it("respects flag disabled", async () => {
    process.env.FEATURE_PHASE_122 = "0"
    const res = await storeOffchainDelta("C" + "A".repeat(55), 1, {})
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.code, "FLAG_DISABLED")
    process.env.FEATURE_PHASE_122 = "1"
  })
})
