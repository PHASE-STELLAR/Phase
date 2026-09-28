/**
 * Explore owners-scan cache — phase-135
 *
 * `app/api/explore/route.ts` scans `owner_of(id)` for every token up to
 * `PHASE_EXPLORE_SCAN_CAP` on every request. Under load or an RPC hiccup this
 * is slow and can fail the whole page (500). This module caches the raw
 * (id, owner) scan result per (contractId, scanCap) so repeat requests skip
 * the scan, and a scan failure can degrade to the last-known-good result
 * instead of failing the request.
 *
 * Feature flag: phase-135 (shared with `lib/wallet-nft-index-cache.ts` — same
 * initiative, same rollback story). Rollback: unset flag → route falls back
 * to scanning on every request with no stale-on-error degrade.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

export type ExploreOwner = { id: number; owner: string }

export type ExploreOwnersCacheEntry = {
  owners: ExploreOwner[]
  cachedAt: number
}

const MAX_ENTRIES = 20
const DEFAULT_FRESH_MS = 30_000

const store = new Map<string, ExploreOwnersCacheEntry>()

function cacheKey(contractId: string, scanCap: number): string {
  return `${contractId}:${scanCap}`
}

export function isExploreOwnersCacheEnabled(): boolean {
  return isFeatureEnabled("phase-135")
}

export function isExploreOwnersEntryFresh(entry: ExploreOwnersCacheEntry, freshMs = DEFAULT_FRESH_MS): boolean {
  return Date.now() - entry.cachedAt < freshMs
}

export function getCachedExploreOwners(contractId: string, scanCap: number): ExploreOwnersCacheEntry | null {
  const key = cacheKey(contractId, scanCap)
  const entry = store.get(key)
  if (!entry) return null
  store.delete(key)
  store.set(key, entry)
  return entry
}

export function setCachedExploreOwners(contractId: string, scanCap: number, owners: ExploreOwner[]): void {
  const key = cacheKey(contractId, scanCap)
  store.delete(key)
  store.set(key, { owners: [...owners], cachedAt: Date.now() })
  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value
    if (oldestKey === undefined) break
    store.delete(oldestKey)
  }
}

export function clearExploreOwnersCache(): void {
  store.clear()
}
