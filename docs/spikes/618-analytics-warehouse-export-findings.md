# Spike 618: Analytics Warehouse Export with Parquet and NDJSON, Schema-Versioned and Redacted

**Issue**: #481
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-180` (`NEXT_PUBLIC_FEATURE_PHASE_180` / `FEATURE_PHASE_180`)
**Precedents Analyzed**: world NDJSON streaming (phase-112), moderation audit export with role redaction, Article 20 checksummed bundles, log-pipeline redaction

## Context & Motivation

PHASE had export paths for individual domains (portability bundles, moderation audits, tax CSV, world markdown) but no aggregate analytics extract, no columnar format for warehouse loaders, and no single schema version consumers could pin. Analysts were left scraping sidecars. The repo also had zero Parquet support and no data-frame dependency.

## Key Architectural Decisions

1. **Flat row model (`lib/analytics-warehouse.ts`)**:
   - One shape for every source: `table` (`counter` | `health` | `volume`), `ts` (epoch ms), `metric`, `value`, `status`, `wallet_fingerprint`.
   - Collectors: security-counter snapshot, distributor health history, and wash-excluded accepted-offer volume from SQLite (the same `wash_flagged = 0` filter `lib/wash-screening.ts` uses so warehouse volume matches explore-ranking volume).

2. **One manifest, two formats**:
   - NDJSON: manifest line first (`schema`, `version`, `row_count`, `tables`, `checksum`), then one row per line — the shape `streamWorldExportNdjson` established.
   - Parquet: `hyparquet-writer` (the repo's first data-format dependency, chosen over hand-rolling Thrift page encoding) writes typed columns with the same manifest in `key_value_metadata` (`phase.schema_version`, `phase.checksum`, `phase.redacted`).
   - The checksum (`warehouseRowsChecksum`) hashes rows only, so it is reproducible regardless of format; it is mirrored in the `X-Warehouse-Checksum` response header.

3. **Redaction is unconditional**:
   - Exports never contain raw `G...` addresses or `S...` seeds: `redactWarehouseRow` fingerprints wallet fields and rewrites wallet/secret-looking text inside metric and status (idempotent — already-fingerprinted values pass through unchanged).
   - `GET /api/analytics/export?format=ndjson|parquet` is admin-keyed (`checkAdminKey`, fail-closed) and returns `Content-Disposition` downloads.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_180` / `FEATURE_PHASE_180` or set to `0`. The export route returns `404`; no stored warehouse state exists — collectors read live sources only.
