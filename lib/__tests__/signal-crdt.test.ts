import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"
import { createSignal, getSignal, type Signal } from "@/lib/signal-store"
import {
  applySignalLoreUpdate,
  captureSignalLoreEdit,
  createSignalLoreDoc,
  decodeSignalLoreUpdate,
  encodeSignalLoreDoc,
  encodeSignalLoreStateVector,
  mergeSignalLoreUpdates,
  readSignalLore,
  seedSignalLore,
  signalLoreConverges,
  signalLoreIsUpToDate,
  type SignalLoreField,
  type SignalLoreSnapshot,
} from "@/lib/signal-crdt"
import {
  COMPACT_AFTER_UPDATES,
  SignalCrdtError,
  getSignalLoreDraftStats,
  isSignalCrdtEnabled,
  mergeSignalLoreUpdate,
  readSignalLoreDraft,
  resetSignalLoreDraft,
} from "@/lib/signal-crdt-store"
import {
  getSignalVersionMetric,
  recordSignalCrdtCommit,
  recordSignalVersionConflict,
  resetSignalVersionMetrics,
  snapshotSignalVersionMetrics,
} from "@/lib/signal-version-metrics"

/** Issue #207 asks for 50 concurrent writers on one signal. */
const CONCURRENT_WRITERS = 50

let dataDir: string
let previousDataDir: string | undefined
let previousFlag: string | undefined

beforeEach(async () => {
  // getDb() caches its connection process-wide, so it has to be dropped before
  // the new data dir is picked up — otherwise every test shares one database.
  resetDbForTests();
  resetSignalVersionMetrics();
  dataDir = await mkdtemp(path.join(tmpdir(), "phase-signal-crdt-"));
  previousDataDir = process.env.PHASE_SERVER_DATA_DIR;
  process.env.PHASE_SERVER_DATA_DIR = dataDir;
  previousFlag = process.env.FEATURE_PHASE_141;
  process.env.FEATURE_PHASE_141 = "1";
});

afterEach(async () => {
  resetDbForTests();
  if (previousFlag === undefined) delete process.env.FEATURE_PHASE_141;
  else process.env.FEATURE_PHASE_141 = previousFlag;
  if (previousDataDir === undefined) delete process.env.PHASE_SERVER_DATA_DIR;
  else process.env.PHASE_SERVER_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

function seedSignal(title = "Signal title", body = "Signal body"): Promise<Signal> {
  return createSignal({
    author_wallet: Keypair.random().publicKey(),
    author_display: "author",
    channel: "general",
    title,
    body,
    upvotes: [],
    signature: "sig",
  });
}

/** The store does not validate wallet shape (the route does), so keep this cheap. */
function syntheticWallet(i: number): string {
  return `G${String(i).padStart(55, "A")}`;
}

/**
 * A replica that co-authors the draft offline: it boots from the given base
 * state, applies its own edits without seeing anyone else's, and returns the
 * Yjs update it would publish.
 */
function replica(
  base: string,
  edits: (current: SignalLoreSnapshot) => Array<[SignalLoreField, string]>,
): string {
  const doc = createSignalLoreDoc();
  applySignalLoreUpdate(doc, base);
  const collected: string[] = [];
  for (const [field, next] of edits(readSignalLore(doc))) {
    const update = captureSignalLoreEdit(doc, field, next);
    if (update) collected.push(update);
  }
  return mergeSignalLoreUpdates(collected);
}

describe("phase-141 CRDT document model", () => {
  it("seeds from committed lore and renders it back", () => {
    const doc = createSignalLoreDoc();
    seedSignalLore(doc, { title: "Hello", body: "World" });
    expect(readSignalLore(doc)).toEqual({ title: "Hello", body: "World" });
  });

  it("refuses to seed over content a peer already wrote", () => {
    const doc = createSignalLoreDoc();
    seedSignalLore(doc, { title: "Hello", body: "World" });
    seedSignalLore(doc, { title: "Ignored", body: "Ignored too" });
    expect(readSignalLore(doc)).toEqual({ title: "Hello", body: "World" });
  });

  it("emits no update when the text is unchanged", () => {
    const doc = createSignalLoreDoc();
    seedSignalLore(doc, { title: "Same", body: "Same" });
    expect(captureSignalLoreEdit(doc, "title", "Same")).toBeNull();
  });

  it("keeps both authors' concurrent appends instead of one overwriting the other", () => {
    const base = createSignalLoreDoc();
    seedSignalLore(base, { title: "T", body: "draft" });
    const baseUpdate = encodeSignalLoreDoc(base);

    const leftUpdate = replica(baseUpdate, () => [["body", "draft + left"]]);
    const rightUpdate = replica(baseUpdate, () => [["body", "draft + right"]]);

    // Each side holds the shared base plus its own delta, then receives the
    // other's delta — the real server/replica shape. A delta is only meaningful
    // against the operations that precede it, so the base has to be present.
    const leftMerged = createSignalLoreDoc();
    applySignalLoreUpdate(leftMerged, baseUpdate);
    applySignalLoreUpdate(leftMerged, leftUpdate);
    applySignalLoreUpdate(leftMerged, rightUpdate);

    const rightMerged = createSignalLoreDoc();
    applySignalLoreUpdate(rightMerged, baseUpdate);
    applySignalLoreUpdate(rightMerged, rightUpdate);
    applySignalLoreUpdate(rightMerged, leftUpdate);

    // Both authors' words survive, and the merge did not depend on arrival order.
    const body = readSignalLore(leftMerged).body;
    expect(body).toContain("draft");
    expect(body).toContain("left");
    expect(body).toContain("right");
    expect(signalLoreConverges(leftMerged, rightMerged)).toBe(true);
  });

  it("is order-independent and idempotent, unlike last-writer-wins", () => {
    const base = createSignalLoreDoc();
    seedSignalLore(base, { title: "T", body: "start" });
    const baseUpdate = encodeSignalLoreDoc(base);
    const a = replica(baseUpdate, () => [["body", "start a"]]);
    const b = replica(baseUpdate, () => [["body", "start b"]]);

    const ab = createSignalLoreDoc();
    applySignalLoreUpdate(ab, mergeSignalLoreUpdates([a, b]));
    const ba = createSignalLoreDoc();
    applySignalLoreUpdate(ba, mergeSignalLoreUpdates([b, a]));
    expect(readSignalLore(ab)).toEqual(readSignalLore(ba));

    // Re-submitting one writer's update twice must not duplicate their edit —
    // the property a last-writer-wins store cannot offer.
    const twice = createSignalLoreDoc();
    applySignalLoreUpdate(twice, a);
    applySignalLoreUpdate(twice, a);
    applySignalLoreUpdate(twice, b);
    expect(readSignalLore(twice)).toEqual(readSignalLore(ab));
  });

  it("reports a replica that is missing operations from an update", () => {
    const base = createSignalLoreDoc();
    seedSignalLore(base, { title: "T", body: "start" });
    const baseUpdate = encodeSignalLoreDoc(base);
    const update = replica(baseUpdate, () => [["body", "moved on"]]);
    const bytes = decodeSignalLoreUpdate(update);

    // Same base, but the edit has not arrived yet.
    const behind = createSignalLoreDoc();
    applySignalLoreUpdate(behind, baseUpdate);
    expect(signalLoreIsUpToDate(behind, bytes)).toBe(false);
    applySignalLoreUpdate(behind, update);
    expect(signalLoreIsUpToDate(behind, bytes)).toBe(true);
  });
});

describe(`phase-141 no lost writes across ${CONCURRENT_WRITERS} concurrent writers`, () => {
  it("converges every co-author's edit into one draft", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);

    // Every writer boots from the same v1 draft and appends its own token without
    // seeing anyone else's work — the lost-update setup from the issue.
    const updates = Array.from({ length: CONCURRENT_WRITERS }, (_, i) =>
      replica(draft.update, (current) => [["body", `${current.body} ·w${i}`]]),
    );

    for (const [i, update] of updates.entries()) {
      await mergeSignalLoreUpdate(signal.id, update, syntheticWallet(i));
    }

    const merged = await readSignalLoreDraft(signal.id);
    expect(merged.snapshot.title).toBe("Shared title");
    for (let i = 0; i < CONCURRENT_WRITERS; i++) {
      expect(merged.snapshot.body).toContain(`·w${i}`);
    }
    expect(merged.updateCount).toBe(CONCURRENT_WRITERS);
    expect(getSignalVersionMetric("signal_crdt_merges")).toBe(CONCURRENT_WRITERS);
    expect(getSignalVersionMetric("signal_version_conflicts")).toBe(0);
  });

  it("loses nothing when the updates arrive in a different order", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);
    const updates = Array.from({ length: CONCURRENT_WRITERS }, (_, i) =>
      replica(draft.update, (current) => [["title", `${current.title} [t${i}]`]]),
    );

    for (const [i, update] of [...updates].reverse().entries()) {
      await mergeSignalLoreUpdate(signal.id, update, syntheticWallet(i));
    }

    const merged = await readSignalLoreDraft(signal.id);
    for (let i = 0; i < CONCURRENT_WRITERS; i++) {
      expect(merged.snapshot.title).toContain(`[t${i}]`);
    }
  });

  it("treats a resubmitted update as a no-op, not a duplicated edit", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);
    const update = replica(draft.update, (current) => [["body", `${current.body} once`]]);

    const first = await mergeSignalLoreUpdate(signal.id, update, syntheticWallet(0));
    expect(first.concurrent).toBe(true);
    const second = await mergeSignalLoreUpdate(signal.id, update, syntheticWallet(0));
    // The server already had these operations, so nothing new arrived…
    expect(second.concurrent).toBe(false);
    // …and the rendered draft is byte-identical.
    expect(second.draft.snapshot).toEqual(first.draft.snapshot);
    // The update is still recorded for attribution, so the count moves.
    expect(second.draft.updateCount).toBe(first.draft.updateCount + 1);
  });

  it("brings a late replica fully up to date from a state-vector diff", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);
    const updates = Array.from({ length: 10 }, (_, i) =>
      replica(draft.update, (current) => [["body", `${current.body} ·w${i}`]]),
    );
    for (const [i, update] of updates.entries()) {
      await mergeSignalLoreUpdate(signal.id, update, syntheticWallet(i));
    }

    // A replica that only ever loaded the base state.
    const late = createSignalLoreDoc();
    applySignalLoreUpdate(late, draft.update);
    expect(signalLoreIsUpToDate(late, decodeSignalLoreUpdate(updates[0]!))).toBe(false);

    const sync = await readSignalLoreDraft(signal.id, encodeSignalLoreStateVector(late));
    applySignalLoreUpdate(late, sync.update);

    const server = await readSignalLoreDraft(signal.id);
    const serverDoc = createSignalLoreDoc();
    applySignalLoreUpdate(serverDoc, server.update);
    expect(readSignalLore(late)).toEqual(server.snapshot);
    expect(signalLoreConverges(late, serverDoc)).toBe(true);
  });
});

describe("phase-141 store durability and cross-instance safety", () => {
  it("merges every update when two connections race on the same file", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);
    const updates = Array.from({ length: CONCURRENT_WRITERS }, (_, i) =>
      replica(draft.update, (current) => [["body", `${current.body} ·x${i}`]]),
    );

    // Two independent handles stand in for two Vercel instances: they share
    // nothing but the database file, and each takes the write lock itself.
    const other = new DatabaseSync(serverDataJsonPath("sqliteDb"));
    other.exec("PRAGMA journal_mode = WAL;");
    other.exec("PRAGMA foreign_keys = ON;");
    try {
      for (const [i, update] of updates.entries()) {
        const conn = i % 2 === 0 ? getDb() : other;
        await mergeSignalLoreUpdate(signal.id, update, syntheticWallet(i), { conn });
      }
    } finally {
      other.close();
    }

    const merged = await readSignalLoreDraft(signal.id);
    for (let i = 0; i < CONCURRENT_WRITERS; i++) {
      expect(merged.snapshot.body).toContain(`·x${i}`);
    }
  });

  it("persists the merged draft across a reconnect", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);
    await mergeSignalLoreUpdate(
      signal.id,
      replica(draft.update, (current) => [["body", `${current.body} durable`]]),
      syntheticWallet(0),
    );

    resetDbForTests();
    const reopened = await readSignalLoreDraft(signal.id);
    expect(reopened.snapshot).toEqual({ title: "Shared title", body: "shared body durable" });
  });

  it("reseeds the draft from committed lore after a commit clears it", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);
    await mergeSignalLoreUpdate(
      signal.id,
      replica(draft.update, (current) => [["body", `${current.body} scratch`]]),
      syntheticWallet(0),
    );

    await resetSignalLoreDraft(signal.id);
    const reseeded = await readSignalLoreDraft(signal.id);
    expect(reseeded.snapshot).toEqual({ title: "Shared title", body: "shared body" });
    expect(reseeded.updateCount).toBe(0);
  });

  it("compacts the update tail without losing anything", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);
    const total = COMPACT_AFTER_UPDATES + 5;
    for (let i = 0; i < total; i++) {
      await mergeSignalLoreUpdate(
        signal.id,
        replica(draft.update, (current) => [["body", `${current.body} ${i}`]]),
        syntheticWallet(i),
      );
    }

    const stats = getSignalLoreDraftStats(signal.id);
    expect(stats.updateCount).toBe(total);
    expect(stats.tailRows).toBeLessThanOrEqual(COMPACT_AFTER_UPDATES);

    // Compaction dropped redundant rows, not state: the snapshot still renders
    // every single edit.
    const merged = await readSignalLoreDraft(signal.id);
    for (let i = 0; i < total; i++) {
      expect(merged.snapshot.body).toContain(` ${i}`);
    }
  });

  it("never writes the signal row — the draft is scratch state", async () => {
    const signal = await seedSignal("Shared title", "shared body");
    const draft = await readSignalLoreDraft(signal.id);
    await mergeSignalLoreUpdate(
      signal.id,
      replica(draft.update, (current) => [["body", `${current.body} scratch`]]),
      syntheticWallet(0),
    );

    const stored = await getSignal(signal.id);
    expect(stored?.body).toBe("shared body");
    expect(stored?.version).toBe(1);
  });
});

describe("phase-141 flag gating and validation", () => {
  it("refuses to serve a draft when the flag is off", async () => {
    process.env.FEATURE_PHASE_141 = "0";
    expect(isSignalCrdtEnabled()).toBe(false);
    const signal = await seedSignal();
    await expect(readSignalLoreDraft(signal.id)).rejects.toBeInstanceOf(SignalCrdtError);
    await expect(
      mergeSignalLoreUpdate(signal.id, "AA==", syntheticWallet(0)),
    ).rejects.toMatchObject({ code: "FLAG_DISABLED" });
  });

  it("rejects a missing signal, an empty update, and non-base64", async () => {
    const signal = await seedSignal();
    await expect(
      mergeSignalLoreUpdate("does-not-exist", "AA==", syntheticWallet(0)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mergeSignalLoreUpdate(signal.id, "", syntheticWallet(0))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      mergeSignalLoreUpdate(signal.id, "!!! not base64 !!!", syntheticWallet(0)),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects an oversized update rather than folding unbounded state in", async () => {
    const signal = await seedSignal();
    await expect(
      mergeSignalLoreUpdate(signal.id, "A".repeat(300_000), syntheticWallet(0)),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("issue #207 signal_version_conflicts metric", () => {
  it("counts conflicts per surface and never labels by signal id or wallet", () => {
    recordSignalVersionConflict("edit");
    recordSignalVersionConflict("edit", { retried: true });
    recordSignalVersionConflict("put");

    const snapshot = snapshotSignalVersionMetrics();
    expect(snapshot.signal_version_conflicts).toBe(3);
    expect(snapshot.bySurface.edit).toBe(2);
    expect(snapshot.bySurface.put).toBe(1);
    expect(snapshot.bySurface.reply).toBe(0);
    // A retried CAS is user-visible contention; a plain one is not.
    expect(snapshot.signal_version_conflict_retries).toBe(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/G[A-Z2-7]{20,}/);
  });

  it("tracks CRDT commit outcomes", () => {
    recordSignalCrdtCommit("committed");
    recordSignalCrdtCommit("conflicted");
    recordSignalCrdtCommit("conflicted");
    const snapshot = snapshotSignalVersionMetrics();
    expect(snapshot.signal_crdt_commits).toBe(3);
    expect(snapshot.signal_crdt_commits_conflicted).toBe(2);
    expect(snapshot.crdtCommitsByOutcome.conflicted).toBe(2);
  });

  it("resets to zero", () => {
    recordSignalVersionConflict("reply");
    resetSignalVersionMetrics();
    expect(snapshotSignalVersionMetrics().signal_version_conflicts).toBe(0);
  });
});
