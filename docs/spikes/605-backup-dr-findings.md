# Spike 605 — Backup and Disaster-Recovery Drills for Sidecars, SQLite and the Secrets Map Findings (Issue #469)

## What the issue claimed / what the code did

- ~40 sidecar keys and `phase.sqlite3` had no snapshot or export code.
- Each sidecar write is atomic (tmp+rename) but the set is not; a copy of a WAL database is not a consistent image.
- On Vercel the data root is `os.tmpdir()`, so a cold start can wipe claims, follows, jobs and distributor health.
- A restore running while `executeDistributorRefill` fires could double-spend.

## Delivered slice (phase-171)

- **Consistency**: `createSnapshot` holds every sidecar lock in sorted order (no lock-order deadlock) and takes the database with `VACUUM INTO`, a transactionally consistent copy with no WAL/SHM. A corrupt sidecar fails the snapshot instead of shipping.
- **Verification**: manifest with sha256, size and per-table row counts; `verifySnapshot` also parses JSON and runs `integrity_check` and `foreign_key_check` (the migration script only skips dangling FKs with a warning).
- **Restore**: verified first; stale WAL/SHM removed; tmp+rename; `.restore-in-progress` marker makes `/api/cron/faucet-health` answer `503` + `Retry-After: 60` (marker stale after 10 min so a crashed restore cannot wedge the cron).
- **Secrets**: never in a snapshot. AES-256-GCM envelope with a scrypt key; wrong passphrase and tampering are indistinguishable and never echo plaintext; `diffSecretsMap` reports rotation drift by name.
- **Drill**: `npm run backup:drill` snapshots, verifies, restores into a scratch directory and proves SQLite parity.

## Affected files: changed or explicitly ruled out

| File | Status |
|---|---|
| `lib/server-data-paths.ts` | Changed: root and key table exported. |
| `lib/sqlite-db.ts`, `lib/json-store.ts` | Used unchanged: `getDb` and `withFileLock` provide the consistency points. |
| `app/api/cron/faucet-health/route.ts` | Changed: restore-marker gate. |
| `lib/signal-store.ts`, `lib/market-store.ts`, `lib/follow-store.ts`, `lib/notification-store.ts`, `lib/quest-snapshot.ts`, `lib/distributor-health-store.ts`, `lib/x402-dead-letter.ts`, `lib/generation-job-store.ts` | Ruled out: they are covered through the shared file table and database; per-store export formats are not needed for a byte-level snapshot. |
| `scripts/migrate-json-to-sqlite.ts` | Ruled out: it only reads legacy JSON. |
| `scripts/check-secret-rotation.ts` | Ruled out: rotation metadata is separate; drift is checked by `diffSecretsMap`. |
| `app/api/world/[collection_id]/export/route.ts` | Ruled out: lore export is a user feature, not ops-state backup. |
| `lib/api-observability.ts` | Ruled out: snapshot code logs nothing, so no secret can reach the log sink. |
| `vercel.json` | Ruled out deliberately: a cron writing into `os.tmpdir()` would be false safety. A scheduled snapshot needs off-box storage first. |

## Rollback

Unset `FEATURE_PHASE_171` and restart: entry points throw `FLAG_DISABLED`; snapshots on disk are inert.

## Follow-ups

This is a partial slice. The issue's acceptance criteria that need a live testnet or hosted environment (end-to-end transaction proof, kill-the-primary resilience demo) are not claimed here; see `docs/TECHNICAL.md` for what the unit tests do cover.
