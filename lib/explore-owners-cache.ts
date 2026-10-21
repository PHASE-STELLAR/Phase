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

export function exploreOwnersCacheStats(): { size: number; maxEntries: number } {
  return { size: store.size, maxEntries: MAX_ENTRIES }
}

/**
 * phase-142: owner lookup for a known set of token ids, served from whichever
 * cached scan is freshest. The curator needs owners only for its shortlist (to
 * cap any one owner's share of a show), so it must not trigger the explore
 * route's full owner_of scan; ids missing here are fetched individually by the
 * caller. Entries older than `maxAgeMs` are ignored — an owner cap enforced
 * against a stale owner is not enforced.
 */
export function lookupCachedOwners(tokenIds: readonly number[], maxAgeMs = 10 * 60_000): Map<number, string> {
  const wanted = new Set(tokenIds)
  const out = new Map<number, string>()
  const now = Date.now()
  const entries = [...store.values()]
    .filter((e) => now - e.cachedAt < maxAgeMs)
    .sort((a, b) => b.cachedAt - a.cachedAt)
  for (const entry of entries) {
    for (const { id, owner } of entry.owners) {
      if (wanted.has(id) && !out.has(id)) out.set(id, owner)
    }
    if (out.size === wanted.size) break
  }
  return out
}
