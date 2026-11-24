/**
 * Spike 629 (#492, phase-173) — Horizon timeline parsing/merge/cursor tests.
 *
 * Pure unit tests over `lib/wallet-history.ts` (no network, no disk stores —
 * settlement/generation-job stores are mocked).
 *
 * NOTE: Written but NOT executed as part of the spike (no test runs allowed).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HORIZON_HISTORY_URL,
  WalletHistoryError,
  classifyEffectType,
  getWalletTimeline,
  isValidStellarAddress,
  mergeTimelineStreams,
  minPagingToken,
  parseHorizonEffectRecords,
  parseHorizonTransactionRecords,
} from "@/lib/wallet-history";
import { clearWalletHistoryCache } from "@/lib/wallet-history-cache";
import type { TimelineEvent } from "@/lib/types/wallet-history";

vi.mock("@/lib/settlement-store", () => ({
  isSettlementUsed: vi.fn(async () => false),
}));
vi.mock("@/lib/generation-job-store", () => ({
  getGenerationJobByTxHash: vi.fn(async () => null),
}));

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2"; // 56 chars

const event = (over: Partial<TimelineEvent> & { id: string }): TimelineEvent => ({
  kind: "payment",
  direction: "in",
  type: "account_credited",
  occurred_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("isValidStellarAddress (Spike 629)", () => {
  it("accepts a G… 56-char base32 account", () => {
    expect(isValidStellarAddress(WALLET)).toBe(true);
  });

  it("rejects short/long/non-G input", () => {
    expect(isValidStellarAddress("GSHORT")).toBe(false);
    expect(isValidStellarAddress(`S${WALLET.slice(1)}`)).toBe(false);
    expect(isValidStellarAddress(`${WALLET}A`)).toBe(false);
    expect(isValidStellarAddress("")).toBe(false);
  });
});

describe("classifyEffectType (Spike 629)", () => {
  it("maps Horizon effect types to timeline kinds", () => {
    expect(classifyEffectType("account_credited")).toBe("payment");
    expect(classifyEffectType("account_debited")).toBe("payment");
    expect(classifyEffectType("trade")).toBe("trade");
    expect(classifyEffectType("trade_non_native")).toBe("trade");
    expect(classifyEffectType("trustline_created")).toBe("trustline");
    expect(classifyEffectType("account_created")).toBe("account");
    expect(classifyEffectType("data_created")).toBe("other");
    expect(classifyEffectType("sequence_changed")).toBe("other");
    expect(classifyEffectType("mystery")).toBe("other");
  });
});

describe("parseHorizonEffectRecords (Spike 629)", () => {
  it("prefixes ids, classifies, and extracts amount/asset/counterparty", () => {
    const [parsed] = parseHorizonEffectRecords(
      [
        {
          id: "001",
          type: "account_credited",
          amount: "25.5",
          asset_type: "native",
          buyer: "COUNTERPARTY",
          transaction_hash: "hash-1",
          created_at: "2026-02-02T00:00:00Z",
        },
      ],
      WALLET,
    );
    expect(parsed?.id).toBe("effect:001");
    expect(parsed?.kind).toBe("payment");
    expect(parsed?.direction).toBe("in");
    expect(parsed?.amount).toBe("25.5");
    expect(parsed?.asset).toBe("XLM");
    expect(parsed?.counterparty).toBe("COUNTERPARTY");
    expect(parsed?.tx_hash).toBe("hash-1");
  });

  it("does not list the wallet itself as its own counterparty", () => {
    const [parsed] = parseHorizonEffectRecords(
      [{ id: "002", type: "account_debited", amount: "1", buyer: WALLET }],
      WALLET,
    );
    expect(parsed?.counterparty).toBeUndefined();
  });

  it("skips records without an id", () => {
    expect(parseHorizonEffectRecords([{ type: "trade" }], WALLET)).toHaveLength(0);
  });
});

describe("parseHorizonTransactionRecords (Spike 629)", () => {
  it("derives direction from the source account and keeps failures", () => {
    const out = parseHorizonTransactionRecords(
      [
        {
          id: "txid-1",
          source_account: WALLET,
          successful: false,
          fee_paid: "100",
          memo: "phase",
          ledger: 7,
          transaction_hash: "hash-2",
          created_at: "2026-03-03T00:00:00Z",
        },
      ],
      WALLET,
    );
    expect(out[0]?.id).toBe("tx:txid-1");
    expect(out[0]?.direction).toBe("out");
    expect(out[0]?.failed).toBe(true);
    expect(out[0]?.type).toBe("tx_failed");
    expect(out[0]?.memo).toBe("phase");
    expect(out[0]?.ledger).toBe(7);
  });

  it("marks inbound transactions with the source as counterparty", () => {
    const [parsed] = parseHorizonTransactionRecords(
      [{ id: "txid-2", source_account: "SOMEONEELSE", successful: true }],
      WALLET,
    );
    expect(parsed?.direction).toBe("in");
    expect(parsed?.counterparty).toBe("SOMEONEELSE");
    expect(parsed?.failed).toBe(false);
  });
});

describe("mergeTimelineStreams — effects-first merge (Spike 629 requirement)", () => {
  it("drops a transaction already covered by an effect with the same hash", () => {
    const tx = event({ id: "tx:1", kind: "tx", type: "payment", tx_hash: "same-hash" });
    const effect = event({ id: "effect:1", tx_hash: "same-hash" });
    const merged = mergeTimelineStreams([tx], [effect]);
    expect(merged.map((e) => e.id)).toEqual(["effect:1"]);
  });

  it("keeps failed transactions (they produce no effects)", () => {
    const failed = event({
      id: "tx:2",
      kind: "tx",
      type: "tx_failed",
      tx_hash: "orphan-hash",
      failed: true,
    });
    const merged = mergeTimelineStreams([failed], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.failed).toBe(true);
  });

  it("keeps transactions with no hash (cannot be linked — graceful degradation)", () => {
    const tx = event({ id: "tx:3", kind: "tx", type: "tx", tx_hash: undefined });
    expect(mergeTimelineStreams([tx], [])).toHaveLength(1);
  });

  it("orders newest-first and dedupes by id", () => {
    const older = event({ id: "effect:a", occurred_at: "2026-01-01T00:00:00Z" });
    const newer = event({ id: "effect:b", occurred_at: "2026-01-02T00:00:00Z" });
    const dup = event({ id: "effect:b", occurred_at: "2026-01-02T00:00:00Z" });
    const merged = mergeTimelineStreams([], [older, newer, dup]);
    expect(merged.map((e) => e.id)).toEqual(["effect:b", "effect:a"]);
  });

  it("breaks timestamp ties by ledger (highest first)", () => {
    const low = event({ id: "effect:l1", ledger: 100 });
    const high = event({ id: "effect:l2", ledger: 200 });
    const merged = mergeTimelineStreams([], [low, high]);
    expect(merged.map((e) => e.id)).toEqual(["effect:l2", "effect:l1"]);
  });
});

describe("minPagingToken — gap-free cursor (Spike 629 requirement)", () => {
  it("returns the smaller of the two stream tails so no page boundary is skipped", () => {
    expect(minPagingToken("900", "100")).toBe("100");
    expect(minPagingToken("100", "900")).toBe("100");
    expect(minPagingToken("42", "42")).toBe("42");
  });

  it("handles zero-padded tokens via BigInt", () => {
    expect(minPagingToken("0900", "100")).toBe("100");
  });

  it("returns the non-null tail when one stream is empty", () => {
    expect(minPagingToken(null, "55")).toBe("55");
    expect(minPagingToken("55", null)).toBe("55");
    expect(minPagingToken(null, null)).toBeNull();
  });
});

describe("getWalletTimeline — flag gate and degrade paths (Spike 629)", () => {
  const originalFlag = process.env.FEATURE_PHASE_173;
  const originalPublicFlag = process.env.NEXT_PUBLIC_FEATURE_PHASE_173;
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearWalletHistoryCache();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFlag === undefined) delete process.env.FEATURE_PHASE_173;
    else process.env.FEATURE_PHASE_173 = originalFlag;
    if (originalPublicFlag === undefined) delete process.env.NEXT_PUBLIC_FEATURE_PHASE_173;
    else process.env.NEXT_PUBLIC_FEATURE_PHASE_173 = originalPublicFlag;
  });

  const horizonReply = (records: Array<Record<string, unknown>>) => ({
    ok: true,
    status: 200,
    json: async () => ({ _embedded: { records } }),
  });

  it("throws FLAG_DISABLED when phase-173 is off (rollback path)", async () => {
    delete process.env.FEATURE_PHASE_173;
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_173;
    await expect(getWalletTimeline(WALLET)).rejects.toMatchObject({
      name: "WalletHistoryError",
      code: "FLAG_DISABLED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws INVALID_ADDRESS for malformed accounts", async () => {
    process.env.FEATURE_PHASE_173 = "1";
    await expect(getWalletTimeline("not-an-address")).rejects.toMatchObject({
      code: "INVALID_ADDRESS",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merges both Horizon streams and serves a 'miss' page with shared cursor", async () => {
    process.env.FEATURE_PHASE_173 = "1";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/transactions?")) {
        return horizonReply([
          {
            id: "txid-9",
            source_account: WALLET,
            successful: false,
            paging_token: "900",
            transaction_hash: "failed-hash",
            created_at: "2026-04-04T00:00:00Z",
          },
        ]);
      }
      return horizonReply([
        {
          id: "009",
          type: "account_credited",
          amount: "3",
          asset_type: "native",
          paging_token: "100",
          transaction_hash: "effect-hash",
          created_at: "2026-04-04T00:00:01Z",
        },
      ]);
    });

    const page = await getWalletTimeline(WALLET);
    expect(page.address).toBe(WALLET);
    expect(page.cache).toBe("miss");
    // Both records survive: the failed tx has no effect; the effect stands alone.
    expect(page.events.map((e) => e.id).sort()).toEqual(["effect:009", "tx:txid-9"]);
    // Gap-free cursor = smaller of both tails (100 from the effects stream).
    expect(page.next_cursor).toBe("100");
    // Both Horizon reads went through the shared bulkhead URL.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith(`${HORIZON_HISTORY_URL}/accounts/${WALLET}/transactions?`))).toBe(true);
    expect(urls.some((u) => u.startsWith(`${HORIZON_HISTORY_URL}/accounts/${WALLET}/effects?`))).toBe(true);
  });

  it("serves stale cache instead of failing when Horizon errors (stale-on-error)", async () => {
    process.env.FEATURE_PHASE_173 = "1";
    const { setCachedWalletHistory } = await import("@/lib/wallet-history-cache");
    setCachedWalletHistory(WALLET, null, [event({ id: "effect:cached" })], "1");
    fetchMock.mockRejectedValue(new Error("Horizon down"));

    const page = await getWalletTimeline(WALLET);
    expect(page.cache).toBe("stale");
    expect(page.events.map((e) => e.id)).toEqual(["effect:cached"]);
  });

  it("maps a Horizon 429 to HORIZON_RATE_LIMITED when no cache exists", async () => {
    process.env.FEATURE_PHASE_173 = "1";
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    await expect(getWalletTimeline(WALLET)).rejects.toBeInstanceOf(WalletHistoryError);
    await expect(getWalletTimeline(WALLET)).rejects.toMatchObject({
      code: "HORIZON_RATE_LIMITED",
    });
  });

  it("serves a fresh cache page without touching Horizon", async () => {
    process.env.FEATURE_PHASE_173 = "1";
    const { setCachedWalletHistory } = await import("@/lib/wallet-history-cache");
    setCachedWalletHistory(WALLET, null, [event({ id: "effect:fresh" })], "7");

    const page = await getWalletTimeline(WALLET);
    expect(page.cache).toBe("fresh");
    expect(page.next_cursor).toBe("7");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
