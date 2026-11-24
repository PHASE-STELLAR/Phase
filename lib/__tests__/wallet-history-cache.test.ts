/**
 * Spike 629 (#492, phase-173) — wallet timeline index-cache tests.
 *
 * Mirrors the phase-135 cache pattern (bounded Map, freshness window, LRU-by-
 * reinsertion). The module-level store is shared, so tests use distinct
 * wallet/cursor keys and reset between cases.
 *
 * NOTE: Written but NOT executed as part of the spike (no test runs allowed).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FRESH_MS,
  clearWalletHistoryCache,
  getCachedWalletHistory,
  isWalletHistoryCacheEnabled,
  isWalletHistoryCacheEntryFresh,
  setCachedWalletHistory,
  walletHistoryCacheStats,
} from "@/lib/wallet-history-cache";
import type { TimelineEvent } from "@/lib/types/wallet-history";

const event = (id: string): TimelineEvent => ({
  id,
  kind: "payment",
  direction: "in",
  type: "account_credited",
  occurred_at: "2026-01-01T00:00:00Z",
});

const originalFlag = process.env.FEATURE_PHASE_173;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.FEATURE_PHASE_173;
  else process.env.FEATURE_PHASE_173 = originalFlag;
});

describe("wallet timeline cache (Spike 629)", () => {
  beforeEach(() => {
    clearWalletHistoryCache();
    process.env.FEATURE_PHASE_173 = "1";
  });

  it("round-trips events and next_cursor per wallet+cursor key", () => {
    setCachedWalletHistory("GWALLET", null, [event("e1")], "500");
    const hit = getCachedWalletHistory("GWALLET", null);
    expect(hit?.events.map((e) => e.id)).toEqual(["e1"]);
    expect(hit?.next_cursor).toBe("500");
  });

  it("normalizes wallet case and treats cursors as distinct pages", () => {
    setCachedWalletHistory("gwallet", null, [event("first")], "100");
    setCachedWalletHistory("GWALLET", "100", [event("second")], "200");

    expect(getCachedWalletHistory("GWALLET", null)?.events[0]?.id).toBe("first");
    expect(getCachedWalletHistory("GWALLET", "100")?.events[0]?.id).toBe("second");
    expect(getCachedWalletHistory("GWALLET", "999")).toBeNull();
  });

  it("returns null for an unknown wallet", () => {
    expect(getCachedWalletHistory("GUNKNOWN", null)).toBeNull();
  });

  it("overwrites an existing entry for the same key (and does not grow)", () => {
    setCachedWalletHistory("GWALLET", null, [event("old")], "1");
    setCachedWalletHistory("GWALLET", null, [event("new")], "2");
    expect(getCachedWalletHistory("GWALLET", null)?.events[0]?.id).toBe("new");
    expect(walletHistoryCacheStats().entries).toBe(1);
  });

  it("reports freshness relative to the 30s window", () => {
    setCachedWalletHistory("GWALLET", null, [event("e")], "1");
    const entry = getCachedWalletHistory("GWALLET", null);
    expect(entry).not.toBeNull();
    if (!entry) return;
    expect(isWalletHistoryCacheEntryFresh(entry)).toBe(true);
    expect(isWalletHistoryCacheEntryFresh(entry, DEFAULT_FRESH_MS, entry.cached_at + 30_001)).toBe(false);
  });

  it("stays bounded: evicts oldest entries beyond the 300 cap", () => {
    for (let i = 0; i < 310; i++) {
      setCachedWalletHistory(`GFILL${i}`, null, [event(`e${i}`)], null);
    }
    const stats = walletHistoryCacheStats();
    expect(stats.max_entries).toBe(300);
    expect(stats.entries).toBeLessThanOrEqual(300);
    // The first-inserted entry was evicted; the last is still present.
    expect(getCachedWalletHistory("GFILL0", null)).toBeNull();
    expect(getCachedWalletHistory("GFILL309", null)).not.toBeNull();
  });

  it("re-touches entries on read so hot pages are not evicted first", () => {
    for (let i = 0; i < 300; i++) {
      setCachedWalletHistory(`GHOT${i}`, null, [event(`e${i}`)], null);
    }
    // Read the oldest, then overflow the cache by one entry.
    expect(getCachedWalletHistory("GHOT0", null)).not.toBeNull();
    setCachedWalletHistory("GNEW", null, [event("enew")], null);

    expect(getCachedWalletHistory("GHOT0", null)).not.toBeNull();
    expect(getCachedWalletHistory("GHOT1", null)).toBeNull();
    expect(getCachedWalletHistory("GNEW", null)).not.toBeNull();
  });

  it("clears fully on demand (rollback/diagnostic path)", () => {
    setCachedWalletHistory("GWALLET", null, [event("e")], "1");
    clearWalletHistoryCache();
    expect(getCachedWalletHistory("GWALLET", null)).toBeNull();
    expect(walletHistoryCacheStats().entries).toBe(0);
  });
});

describe("isWalletHistoryCacheEnabled — flag gate (Spike 629 rollback)", () => {
  beforeEach(() => {
    clearWalletHistoryCache();
  });

  it("is off when phase-173 is unset", () => {
    delete process.env.FEATURE_PHASE_173;
    expect(isWalletHistoryCacheEnabled()).toBe(false);
  });

  it("is on when FEATURE_PHASE_173=1", () => {
    process.env.FEATURE_PHASE_173 = "1";
    expect(isWalletHistoryCacheEnabled()).toBe(true);
  });
});
