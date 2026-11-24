import { describe, it, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  getCachedWalletNftIndex,
  setCachedWalletNftIndex,
  isWalletNftIndexEntryFresh,
  clearWalletNftIndexCache,
  walletNftIndexCacheStats,
  invalidateCachedWalletNftIndex,
  processNftIndexSubscriptionEvent,
} from "@/lib/wallet-nft-index-cache"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const CONTRACT = "CAZKRXQWXKM4UNDB5FY4XVMWDKKZJ2EFKMNFCFH3WC7SHE7RCO7HOR6L"
const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBFQN2"

describe("phase-135 wallet NFT index cache", () => {
  beforeEach(() => clearWalletNftIndexCache())

  it("returns null for a miss and the stored entry for a hit", () => {
    assert.equal(getCachedWalletNftIndex(CONTRACT, WALLET_A), null)
    setCachedWalletNftIndex(CONTRACT, WALLET_A, [1, 2, 3], "mercury-classic")
    const entry = getCachedWalletNftIndex(CONTRACT, WALLET_A)
    assert.ok(entry)
    assert.deepEqual(entry!.tokenIds, [1, 2, 3])
    assert.equal(entry!.indexedVia, "mercury-classic")
  })

  it("is case-insensitive and contract-scoped", () => {
    setCachedWalletNftIndex(CONTRACT, WALLET_A, [1], "mercury-classic")
    assert.ok(getCachedWalletNftIndex(CONTRACT, WALLET_A.toLowerCase()))
    assert.equal(getCachedWalletNftIndex("C" + "A".repeat(55), WALLET_A), null)
  })

  it("treats a freshly-written entry as fresh and an old one as stale", () => {
    setCachedWalletNftIndex(CONTRACT, WALLET_A, [1], "soroban-rpc")
    const entry = getCachedWalletNftIndex(CONTRACT, WALLET_A)!
    assert.ok(isWalletNftIndexEntryFresh(entry))
    const aged = { ...entry, cachedAt: Date.now() - 120_000 }
    assert.equal(isWalletNftIndexEntryFresh(aged, 60_000), false)
  })

  it("evicts the least-recently-used entry once over capacity", () => {
    const maxEntries = walletNftIndexCacheStats().maxEntries
    for (let i = 0; i < maxEntries; i++) {
      setCachedWalletNftIndex(CONTRACT, `WALLET_${i}`, [i], "mercury-classic")
    }
    assert.equal(walletNftIndexCacheStats().size, maxEntries)
    // One more insert should evict the oldest (WALLET_0).
    setCachedWalletNftIndex(CONTRACT, "WALLET_OVERFLOW", [999], "mercury-classic")
    assert.equal(walletNftIndexCacheStats().size, maxEntries)
    assert.equal(getCachedWalletNftIndex(CONTRACT, "WALLET_0"), null)
    assert.ok(getCachedWalletNftIndex(CONTRACT, "WALLET_OVERFLOW"))
  })

  it("keeps separate wallets independent", () => {
    setCachedWalletNftIndex(CONTRACT, WALLET_A, [1, 2], "mercury-classic")
    setCachedWalletNftIndex(CONTRACT, WALLET_B, [3], "soroban-rpc")
    assert.deepEqual(getCachedWalletNftIndex(CONTRACT, WALLET_A)!.tokenIds, [1, 2])
    assert.deepEqual(getCachedWalletNftIndex(CONTRACT, WALLET_B)!.tokenIds, [3])
  })

  it("invalidates the correct wallet entry and updates security counter", () => {
    resetSecurityCounters()
    setCachedWalletNftIndex(CONTRACT, WALLET_A, [1, 2], "mercury-classic")
    setCachedWalletNftIndex(CONTRACT, WALLET_B, [3], "soroban-rpc")

    const removed = invalidateCachedWalletNftIndex(CONTRACT, WALLET_A)
    assert.equal(removed, true)
    assert.equal(getCachedWalletNftIndex(CONTRACT, WALLET_A), null)
    assert.ok(getCachedWalletNftIndex(CONTRACT, WALLET_B))
    assert.equal(getSecurityCounter("nft_index_invalidated"), 1)
  })

  it("processes subscription events, invalidating affected entries or rejecting malformed events", () => {
    process.env.FEATURE_PHASE_241 = "1"
    resetSecurityCounters()
    setCachedWalletNftIndex(CONTRACT, WALLET_A, [10], "mercury-classic")
    setCachedWalletNftIndex(CONTRACT, WALLET_B, [20], "mercury-classic")

    // Valid transfer event: affects WALLET_A and WALLET_B
    const res = processNftIndexSubscriptionEvent({
      contractId: CONTRACT,
      type: "transfer",
      from: WALLET_A,
      to: WALLET_B,
      tokenId: 10,
    })
    assert.equal(res.ok, true)
    assert.equal(res.invalidatedCount, 2)
    assert.equal(getCachedWalletNftIndex(CONTRACT, WALLET_A), null)
    assert.equal(getCachedWalletNftIndex(CONTRACT, WALLET_B), null)

    // Malformed event: fails closed, increments nft_index_event_malformed
    const malformed = processNftIndexSubscriptionEvent({ contractId: "", type: "invalid_type" })
    assert.equal(malformed.ok, false)
    assert.equal(getSecurityCounter("nft_index_event_malformed"), 1)

    // Flag off = no subscription processing
    delete process.env.FEATURE_PHASE_241
    setCachedWalletNftIndex(CONTRACT, WALLET_A, [10], "mercury-classic")
    const disabled = processNftIndexSubscriptionEvent({
      contractId: CONTRACT,
      type: "mint",
      recipient: WALLET_A,
    })
    assert.equal(disabled.ok, false)
    assert.ok(getCachedWalletNftIndex(CONTRACT, WALLET_A))
  })
})
