/**
 * Spike 605 (issue #469) disaster-recovery drill.
 *
 * Snapshots the live data root, verifies it, restores it into a scratch
 * directory, and proves SQLite parity between source and restore. Never writes
 * into the live data root and never prints secrets.
 *
 * Usage:
 *   npx tsx scripts/backup-drill.ts [snapshot-dir]
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.FEATURE_PHASE_171 = "1";
process.env.FEATURE_PHASE_172 = "1";

async function main() {
  const { createSnapshot, restoreSnapshot, verifySnapshot } = await import("../lib/backup-snapshot");
  const { compareSources, sqliteParitySource } = await import("../lib/db-parity");
  const { getDb } = await import("../lib/sqlite-db");

  const snapDir = process.argv[2] ?? (await mkdtemp(path.join(tmpdir(), "phase-drill-snap-")));
  const restoreDir = await mkdtemp(path.join(tmpdir(), "phase-drill-restore-"));

  const manifest = await createSnapshot(snapDir);
  console.log(`snapshot: ${manifest.files.length} sidecar(s), ${Object.keys(manifest.sqlite?.tables ?? {}).length} table(s) -> ${snapDir}`);

  const verification = await verifySnapshot(snapDir);
  if (!verification.ok) {
    console.error("verify FAILED:", verification.problems);
    process.exit(1);
  }
  console.log("verify: ok");

  await restoreSnapshot(snapDir, restoreDir);
  const restored = new DatabaseSync(path.join(restoreDir, "phase.sqlite3"), { readOnly: true });
  const parity = compareSources(sqliteParitySource(getDb()), sqliteParitySource(restored));
  restored.close();
  if (!parity.ok) {
    console.error("parity FAILED:", JSON.stringify(parity.tables.filter((t) => !t.match)));
    process.exit(1);
  }
  console.log(`parity: ok across ${parity.tables.length} table(s); restored into ${restoreDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
