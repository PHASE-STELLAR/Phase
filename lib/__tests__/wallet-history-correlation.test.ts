/**
 * Spike 629 (#492, phase-173) — settle ↔ forge correlation tests.
 *
 * `correlateTimelineEvents` is pure; `buildTimelineLookups` is tested with the
 * settlement and generation-job stores mocked so no disk stores load.
 *
 * NOTE: Written but NOT executed as part of the spike (no test runs allowed).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTimelineLookups,
  correlateTimelineEvents,
  emptyTimelineLookups,
} from "@/lib/wallet-history";
import type { TimelineEvent } from "@/lib/types/wallet-history";

const isSettlementUsed = vi.fn();
const getGenerationJobByTxHash = vi.fn();

vi.mock("@/lib/settlement-store", () => ({
  isSettlementUsed: (...args: unknown[]) => isSettlementUsed(...args),
}));
vi.mock("@/lib/generation-job-store", () => ({
  getGenerationJobByTxHash: (...args: unknown[]) => getGenerationJobByTxHash(...args),
}));

const event = (over: Partial<TimelineEvent> & { id: string }): TimelineEvent => ({
  kind: "payment",
  direction: "in",
  type: "account_credited",
  occurred_at: "2026-01-01T00:00:00Z",
  ...over,
});

beforeEach(() => {
  isSettlementUsed.mockReset();
  getGenerationJobByTxHash.mockReset();
});

describe("correlateTimelineEvents — pure annotation (Spike 629)", () => {
  it("marks a settled transaction as a settle event", () => {
    const lookups = emptyTimelineLookups();
    lookups.settledTxHashes.add("hash-settled");

    const out = correlateTimelineEvents(
      [event({ id: "tx:1", kind: "tx", type: "payment", tx_hash: "hash-settled" })],
      lookups,
    );
    expect(out[0]?.kind).toBe("settle");
    expect(out[0]?.correlation).toEqual({
      kind: "settle",
      tx_hash: "hash-settled",
      settled: true,
    });
  });

  it("annotates a forge invoice payment with job id/status/collection", () => {
    const lookups = emptyTimelineLookups();
    lookups.settledTxHashes.add("hash-forge");
    lookups.forgeJobsByTxHash.set("hash-forge", {
      id: "job-1",
      status: "processing",
      collectionId: 5,
    });

    const out = correlateTimelineEvents(
      [event({ id: "effect:1", tx_hash: "hash-forge" })],
      lookups,
    );
    expect(out[0]?.kind).toBe("forge");
    expect(out[0]?.correlation).toEqual({
      kind: "forge-settle",
      tx_hash: "hash-forge",
      settled: true,
      forge_job_id: "job-1",
      forge_job_status: "processing",
      collection_id: 5,
    });
  });

  it("leaves uncorrelated events untouched (no store hit, no annotation)", () => {
    const input = [event({ id: "effect:2", tx_hash: "hash-unknown" })];
    const out = correlateTimelineEvents(input, emptyTimelineLookups());
    expect(out[0]).toEqual(input[0]);
    expect(out[0]?.correlation).toBeUndefined();
  });

  it("leaves events without a tx_hash untouched", () => {
    const input = [event({ id: "effect:3" })];
    const out = correlateTimelineEvents(input, emptyTimelineLookups());
    expect(out[0]).toEqual(input[0]);
  });

  it("does not mutate the input array", () => {
    const lookups = emptyTimelineLookups();
    lookups.settledTxHashes.add("hash-immut");
    const input = [event({ id: "tx:9", kind: "tx", type: "payment", tx_hash: "hash-immut" })];
    const snapshot = structuredClone(input);
    correlateTimelineEvents(input, lookups);
    expect(input).toEqual(snapshot);
  });
});

describe("buildTimelineLookups — store joins (Spike 629)", () => {
  it("collects settled hashes and forge jobs for the given tx hashes", async () => {
    isSettlementUsed.mockImplementation(async (h: string) => h === "hash-a");
    getGenerationJobByTxHash.mockImplementation(async (h: string) =>
      h === "hash-b" ? { id: "job-b", status: "done", collectionId: 2 } : null,
    );

    const lookups = await buildTimelineLookups(["hash-a", "hash-b", "hash-c"]);
    expect(lookups.settledTxHashes).toEqual(new Set(["hash-a"]));
    expect(lookups.forgeJobsByTxHash.get("hash-b")).toEqual({
      id: "job-b",
      status: "done",
      collectionId: 2,
    });
    expect(isSettlementUsed).toHaveBeenCalledTimes(3);
    expect(getGenerationJobByTxHash).toHaveBeenCalledTimes(3);
  });

  it("skips store lookups when there are no hashes", async () => {
    const lookups = await buildTimelineLookups([]);
    expect(lookups.settledTxHashes.size).toBe(0);
    expect(isSettlementUsed).not.toHaveBeenCalled();
  });

  it("filters out null/undefined hash entries defensively", async () => {
    const lookups = await buildTimelineLookups([
      "hash-ok",
      undefined as unknown as string,
      null as unknown as string,
    ]);
    expect(isSettlementUsed).toHaveBeenCalledTimes(1);
    expect(isSettlementUsed).toHaveBeenCalledWith("hash-ok");
    expect(lookups.settledTxHashes.has("hash-ok")).toBe(false); // mock returned undefined → falsy
  });

  it("degrades to uncorrelated output when a store read rejects", async () => {
    isSettlementUsed.mockRejectedValue(new Error("disk unavailable"));
    getGenerationJobByTxHash.mockRejectedValue(new Error("disk unavailable"));

    const lookups = await buildTimelineLookups(["hash-x"]);
    // Individual failures are swallowed per-hash; the page still renders.
    expect(lookups.settledTxHashes.size).toBe(0);
    expect(lookups.forgeJobsByTxHash.size).toBe(0);
  });
});
