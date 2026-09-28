/**
 * Wallet NFT index cache — phase-135
 *
 * Spike #40: when Mercury Classic isn't configured (or fails), the wallet NFT
 * route falls back to a brute-force Soroban RPC scan (up to thousands of
 * `owner_of` simulations), which is slow and occasionally 503s under load.
 * This module caches the last-known-good token-id index per (contract,
 * wallet) so repeat lookups are served in-memory, and so a live-scan failure
 * can degrade to stale cached data instead of surfacing a 503.
 *
 * Feature flag: phase-135 (NEXT_PUBLIC_FEATURE_PHASE_135 / FEATURE_PHASE_135)
 * Rollback: unset flag → route falls back to its pre-phase-135 behavior
 * exactly (no cache, no stale-on-error degrade, no diagnostics logging).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

export type WalletNftIndexEntry = {
  tokenIds: number[]
  indexedVia: string
  cachedAt: number
}

const MAX_ENTRIES = 500
const DEFAULT_FRESH_MS = 60_000

// Map iteration order is insertion order — re-inserting on read/write gives
// us cheap LRU semantics without a dedicated linked list.
const store = new Map<string, WalletNftIndexEntry>()

function cacheKey(contractId: string, address: string): string {
  return `${contractId}:${address.trim().toUpperCase()}`
}

export function isWalletNftIndexCacheEnabled(): boolean {
  return isFeatureEnabled("phase-135")
}

export function isWalletNftIndexEntryFresh(entry: WalletNftIndexEntry, freshMs = DEFAULT_FRESH_MS): boolean {
  return Date.now() - entry.cachedAt < freshMs
}

export function getCachedWalletNftIndex(contractId: string, address: string): WalletNftIndexEntry | null {
  const key = cacheKey(contractId, address)
  const entry = store.get(key)
  if (!entry) return null
  store.delete(key)
  store.set(key, entry) // touch: mark as most-recently-used
  return entry
}

export function setCachedWalletNftIndex(
  contractId: string,
  address: string,
  tokenIds: number[],
  indexedVia: string,
): void {
  const key = cacheKey(contractId, address)
  store.delete(key)
  store.set(key, { tokenIds: [...tokenIds], indexedVia, cachedAt: Date.now() })
  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value
    if (oldestKey === undefined) break
    store.delete(oldestKey)
  }
}

export function clearWalletNftIndexCache(): void {
  store.clear()
}

export function walletNftIndexCacheStats(): { size: number; maxEntries: number } {
  return { size: store.size, maxEntries: MAX_ENTRIES }
}

/** Best-effort diagnostics: how the index was resolved and how long it took. */
export function logWalletNftIndexScan(params: {
  contractId: string
  address: string
  indexedVia: string
  durationMs: number
  tokenCount: number
  cacheHit: boolean
}): void {
  console.info(
    `[phase-135] wallet-nft-index via=${params.indexedVia} cacheHit=${params.cacheHit} ` +
      `tokens=${params.tokenCount} durationMs=${params.durationMs} ` +
      `contract=${params.contractId.slice(0, 8)}… wallet=${params.address.slice(0, 6)}…`,
  )
}
