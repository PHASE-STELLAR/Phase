/**
 * Spike 604 (issue #468) parity check between two SQLite files.
 *
 * Exercises the same `compareSources` the Postgres rehearsal will use, so a
 * restored backup or a re-created database can be checked table by table
 * (count, per-column value, type coercion, checksum).
 *
 * Usage:
 *   npx tsx scripts/db-parity.ts <left.sqlite3> <right.sqlite3>
 */
import { DatabaseSync } from "node:sqlite";

process.env.FEATURE_PHASE_172 = "1";

async function main() {
  const [leftPath, rightPath] = process.argv.slice(2);
  if (!leftPath || !rightPath) {
    console.error("usage: db-parity.ts <left.sqlite3> <right.sqlite3>");
    process.exit(2);
  }
  const { compareSources, sqliteParitySource } = await import("../lib/db-parity");
  const left = new DatabaseSync(leftPath, { readOnly: true });
  const right = new DatabaseSync(rightPath, { readOnly: true });
  const report = compareSources(sqliteParitySource(left), sqliteParitySource(right));
  left.close();
  right.close();
  for (const t of report.tables) {
    console.log(`${t.match ? "ok  " : "DIFF"} ${t.table} (${t.leftCount} vs ${t.rightCount})`);
  }
  for (const t of report.missingTables) console.log(`MISS ${t}`);
  process.exit(report.ok ? 0 : 1);
}

void main();
