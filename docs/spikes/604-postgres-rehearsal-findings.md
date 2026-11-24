# Spike 604 — SQLite to Postgres Migration Rehearsal with Dual-Write, Parity and Rollback Findings (Issue #468)

## What the issue claimed / what the code did

- `lib/sqlite-db.ts` owns the schema with additive `ALTER TABLE`; no Postgres dialect and no `DATABASE_URL`.
- The only migration precedent is a one-shot JSON→SQLite `INSERT OR REPLACE` with a count-parity exit and no checksum or down-migration.
- Callers rely on synchronous `DatabaseSync`, `BEGIN IMMEDIATE`, and `WHERE id=? AND version=?` CAS.
- Count parity cannot see REAL vs NUMERIC, integer flags vs BOOLEAN, or BIGINT returned as a string.

## Delivered slice (phase-172)

- **Dialect** (`lib/db-parity.ts`): `?`→`$n`, type map (integer flags stay `BIGINT`), generated `CREATE TABLE`, and an explicit `ON CONFLICT` upsert replacing `INSERT OR REPLACE`; identifiers are validated.
- **Parity**: per declared column type. Postgres-style string numerics and booleans are accepted for numeric columns; a TEXT column returning a number is reported as `type_coercion`; per-table order-independent checksum; missing/extra rows by primary key.
- **Dual-write**: primary (SQLite) first and the crash winner; a primary failure never reaches the secondary. The secondary is bounded (in-flight cap 5) and timed out (1.5 s); failures, timeouts and shed writes go to a drift log and never throw, so pool exhaustion degrades to SQLite-only. Rollback is `setMode("primary-only")`.
- **Tests**: `perTestSchemaName` gives each test its own schema on a shared Postgres.

## Affected files: changed or explicitly ruled out

| File | Status |
|---|---|
| `lib/sqlite-db.ts` | Used unchanged (`getDb`, schema); read through `sqliteParitySource`. |
| `package.json` | Changed: `db:parity`. |
| `PROJECT_ARCHITECTURE.md`, `docs/TECHNICAL.md` | Changed. |
| `lib/signal-store.ts`, `lib/market-store.ts`, `lib/signal-crdt-store.ts`, `lib/json-store.ts`, `lib/server-data-paths.ts`, `lib/wallet-nft-index-cache.ts`, `lib/explore-owners-cache.ts` | Ruled out: moving their CAS loops to an async driver is the dominant risk and is a separate change; this slice must not touch production write paths. |
| `scripts/migrate-json-to-sqlite.ts` | Ruled out: the Postgres loader reuses the same parity check in a follow-up. |
| `lib/__tests__/{signal-store-concurrency,json-store-concurrency,signal-crdt,collection-offer-book,royalty-split}.test.ts` | Ruled out: they run against SQLite and keep doing so; per-test schemas apply once a Postgres adapter exists. |
| `tsconfig.json` | Ruled out: `scripts/` stays excluded; the new scripts are exercised by the drill. |

## Rollback

Unset `FEATURE_PHASE_172` and restart: `primary-only`; SQLite stays authoritative.

## Follow-ups

This is a partial slice. The issue's acceptance criteria that need a live testnet or hosted environment (end-to-end transaction proof, kill-the-primary resilience demo) are not claimed here; see `docs/TECHNICAL.md` for what the unit tests do cover.
