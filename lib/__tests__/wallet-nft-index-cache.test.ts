import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import {
  getCachedWalletNftIndex,
  setCachedWalletNftIndex,
  isWalletNftIndexEntryFresh,
  clearWalletNftIndexCache,
  walletNftIndexCacheStats,
} from "@/lib/wallet-nft-index-cache"

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
})
