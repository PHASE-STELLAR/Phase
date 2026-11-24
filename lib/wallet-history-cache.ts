/**
 * Wallet timeline index-cache — spike 629 (phase-173).
 *
 * Mirrors the phase-135 cache triple (`lib/wallet-nft-index-cache.ts`):
 * in-memory LRU-by-reinsertion with a freshness window and stale-on-error
 * degradation. Serves the per-wallet Horizon timeline so the Chamber's 12s
 * polling cadence and UI refetches never fan out into unbounded
 * `transactions?account=` / `effects?account=` reads.
 *
 * Feature flag: phase-173 (rides the same flag as the timeline itself).
 * Rollback: unset flag → `isWalletHistoryCacheEnabled()` false → the route
 * skips cache reads/writes entirely and behaves as a direct Horizon proxy.
 */

import { isFeatureEnabled } from "@/lib/feature-flags";
import type { WalletHistoryCacheEntry } from "@/lib/types/wallet-history";

const MAX_ENTRIES = 300;
export const DEFAULT_FRESH_MS = 30_000;

// Map iteration order is insertion order — re-inserting on read/write gives
// cheap LRU semantics without a dedicated linked list.
const store = new Map<string, WalletHistoryCacheEntry>();

export function isWalletHistoryCacheEnabled(): boolean {
  return isFeatureEnabled("phase-173");
}

export function isWalletHistoryCacheEntryFresh(
  entry: WalletHistoryCacheEntry,
  freshMs: number = DEFAULT_FRESH_MS,
  now: number = Date.now(),
): boolean {
  return now - entry.cached_at < freshMs;
}

function cacheKey(wallet: string, cursor: string | null): string {
  return `${wallet.trim().toUpperCase()}:${cursor ?? "first"}`;
}

export function getCachedWalletHistory(
  wallet: string,
  cursor: string | null,
): WalletHistoryCacheEntry | null {
  const key = cacheKey(wallet, cursor);
  const entry = store.get(key);
  if (!entry) return null;
  store.delete(key);
  store.set(key, entry); // touch: mark most-recently-used
  return entry;
}

export function setCachedWalletHistory(
  wallet: string,
  cursor: string | null,
  events: WalletHistoryCacheEntry["events"],
  next_cursor: string | null,
): void {
  const key = cacheKey(wallet, cursor);
  store.delete(key);
  store.set(key, { events: [...events], next_cursor, cached_at: Date.now() });
  // Evict oldest entries once over capacity.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function clearWalletHistoryCache(): void {
  store.clear();
}

export function walletHistoryCacheStats(): {
  entries: number;
  max_entries: number;
  fresh_ms: number;
} {
  return { entries: store.size, max_entries: MAX_ENTRIES, fresh_ms: DEFAULT_FRESH_MS };
}
