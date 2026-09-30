/**
 * Issue #207 spike: Yjs CRDT merging vs the version+CAS store that
 * `lib/signal-store.ts` already uses, at the 50-concurrent-editors load the
 * issue specifies.
 *
 * Both arms run the identical workload — 50 writers, each editing from the
 * *same* starting state without seeing the others. The number that matters is
 * not wall-clock, it is how much of each writer's text survived.
 *
 *   npx vitest run lib/__tests__/signal-crdt-benchmark.test.ts
 *
 * This lives as a test rather than a `scripts/` CLI because the scripts package
 * is a separate ESM scope and cannot link the app's TypeScript modules; vitest
 * already resolves them. It also means the spike stays honest in CI.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"
import { createSignal, editSignal, SignalEditError } from "@/lib/signal-store"
import {
  applySignalLoreUpdate,
  captureSignalLoreEdit,
  createSignalLoreDoc,
  mergeSignalLoreUpdates,
  readSignalLore,
} from "@/lib/signal-crdt"
import { mergeSignalLoreUpdate, readSignalLoreDraft } from "@/lib/signal-crdt-store"
import { getSignalVersionMetric } from "@/lib/signal-version-metrics"

const WRITERS = 50
const BODY_CHARS = 600
// Bracketed so `editSignal`'s .trim() cannot strip the marker and so
// (w1) is not a substring of (w10).
const TOKEN = (i: number) => ` (w${i})`

let dataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  resetDbForTests();
  dataDir = await mkdtemp(path.join(tmpdir(), "phase-crdt-bench-"));
  previousDataDir = process.env.PHASE_SERVER_DATA_DIR;
  process.env.PHASE_SERVER_DATA_DIR = dataDir;
  process.env.FEATURE_PHASE_141 = "1";
  process.env.FEATURE_PHASE_82 = "1";
});

afterAll(async () => {
  resetDbForTests();
  if (previousDataDir === undefined) delete process.env.PHASE_SERVER_DATA_DIR;
  else process.env.PHASE_SERVER_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe(`issue #207 spike: ${WRITERS} concurrent editors`, () => {
  it("keeps every writer's text under CRDT and clobbers it under CAS", async () => {
    const crdt = await runCrdtArm();
    const cas = await runCasArm();

    console.log(
      `\n  ${"strategy".padEnd(30)} ${"preserved".padEnd(11)} ${"wall clock".padEnd(12)} detail` +
        `\n  ${"Yjs CRDT (phase-141)".padEnd(30)} ${`${crdt.preserved}/${WRITERS}`.padEnd(11)} ` +
        `${`${crdt.mergeMs.toFixed(1)} ms`.padEnd(12)} ${crdt.detail}` +
        `\n  ${"version + CAS (current)".padEnd(30)} ${`${cas.preserved}/${WRITERS}`.padEnd(11)} ` +
        `${`${cas.mergeMs.toFixed(1)} ms`.padEnd(12)} ${cas.detail}\n`,
    );

    // The defect the issue reports: only one writer's text survives CAS.
    expect(cas.preserved).toBe(1);
    expect(cas.conflicts).toBe(WRITERS - 1);

    // The fix: the CRDT draft loses nothing and never trips the version guard.
    expect(crdt.preserved).toBe(WRITERS);
    expect(crdt.concurrentMerges).toBe(WRITERS);
    expect(crdt.versionConflicts).toBe(0);
    expect(cas.versionConflicts).toBeGreaterThanOrEqual(WRITERS - 1);
  }, 120_000);
});

type ArmResult = {
  mergeMs: number;
  preserved: number;
  conflicts: number;
  concurrentMerges: number;
  versionConflicts: number;
  detail: string;
};

async function runCrdtArm(): Promise<ArmResult> {
  const signal = await seedSignal();
  const draft = await readSignalLoreDraft(signal.id);

  const conflictsBefore = getSignalVersionMetric("signal_version_conflicts");
  const start = performance.now();
  let concurrentMerges = 0;
  for (let i = 0; i < WRITERS; i++) {
    const doc = createSignalLoreDoc();
    applySignalLoreUpdate(doc, draft.update);
    const update = captureSignalLoreEdit(doc, "body", `${readSignalLore(doc).body}${TOKEN(i)}`);
    if (!update) continue;
    const merged = await mergeSignalLoreUpdate(signal.id, update, syntheticWallet(i));
    if (merged.concurrent) concurrentMerges++;
  }
  const mergeMs = performance.now() - start;

  const final = await readSignalLoreDraft(signal.id);
  return {
    mergeMs,
    preserved: countTokens(final.snapshot.body),
    conflicts: 0,
    concurrentMerges,
    versionConflicts: getSignalVersionMetric("signal_version_conflicts") - conflictsBefore,
    detail: `${final.updateCount} updates folded into one snapshot, 0 rejected`,
  };
}

async function runCasArm(): Promise<ArmResult> {
  const signal = await seedSignal();

  // All 50 writers load the signal at the same moment, so they all hold version
  // 1 and the same base text. That shared read is what makes this a concurrency
  // test rather than 50 sequential edits.
  const base = await getDb()
    .prepare("SELECT body, version FROM signals WHERE id = ?")
    .get(signal.id) as { body: string; version: number };
  let committed = 0;
  let conflicts = 0;

  const conflictsBefore = getSignalVersionMetric("signal_version_conflicts");
  const start = performance.now();
  for (let i = 0; i < WRITERS; i++) {
    try {
      await editSignal(
        signal.id,
        signal.author_wallet,
        { body: `${base.body}${TOKEN(i)}` },
        base.version,
      );
      committed++;
    } catch (error) {
      if (error instanceof SignalEditError && error.code === "CONFLICT") conflicts++;
      else throw error;
    }
  }
  const mergeMs = performance.now() - start;

  const final = await getDb()
    .prepare("SELECT body FROM signals WHERE id = ?")
    .get(signal.id) as { body: string };
  return {
    mergeMs,
    preserved: countTokens(final.body),
    conflicts,
    concurrentMerges: 0,
    versionConflicts: getSignalVersionMetric("signal_version_conflicts") - conflictsBefore,
    detail: `${committed} committed, ${conflicts} rejected with 409, 0 retries attempted`,
  };
}

function countTokens(body: string): number {
  let found = 0;
  for (let i = 0; i < WRITERS; i++) if (body.includes(TOKEN(i))) found++;
  return found;
}

function syntheticWallet(i: number): string {
  return `G${String(i).padStart(55, "A")}`;
}

async function seedSignal() {
  return createSignal({
    author_wallet: syntheticWallet(999),
    author_display: "benchmark",
    channel: "general",
    title: "Benchmark",
    body: "x".repeat(BODY_CHARS),
    upvotes: [],
    signature: "sig",
  });
}
