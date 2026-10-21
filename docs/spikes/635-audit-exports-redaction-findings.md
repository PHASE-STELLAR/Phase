# Spike 635: Audit Exports for Moderators and Regulators with Redaction and Role-Gating

**Issue**: #497
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-168` (`NEXT_PUBLIC_FEATURE_PHASE_168` / `FEATURE_PHASE_168`)
**Key Surfaces**: `lib/moderation-audit-export.ts`, `lib/redaction.ts`, `app/api/moderation/export/route.ts`

## Context & Motivation

Phase's moderation audit trail (`lib/moderation-audit.ts`) recorded actions (`takedown`, `restore`) with raw moderator wallets and signatures directly into `.data/signal-moderation-audit.json`. Reads through `GET /api/signals/[id]/moderate` were constrained to single signals, lacked pagination and date-range querying, required admin keys without distinction between internal operational staff and external regulatory oversight, and lacked multi-format downloads (NDJSON streaming, CSV). Most critically, there was no capability to export a compliance bundle with cryptographically pseudonymized wallet identities and stripped signatures for external regulators.

## Key Architectural Decisions

1. **Role-Based Audit Views (`AuditExportRole`)**:
   - `moderator`: Full internal operational audit trail including raw moderator wallet addresses and cryptographic signatures. Authorized via `PHASE_ADMIN_KEY` or `PHASE_MODERATOR_KEY`.
   - `regulator`: External oversight view. Wallets are cryptographically fingerprinted into deterministic masks (`GABC...WXYZ (fp: <hash>)`), raw cryptographic signatures are scrubbed, and reason fields are sanitized of internal secrets. Authorized via `PHASE_REGULATOR_TOKEN`.

2. **Multi-Format Serialization**:
   - **JSON**: Full hierarchical response with export metadata and filter echoes.
   - **NDJSON**: Streamable newline-delimited JSON events for high-volume ingest pipelines.
   - **CSV**: RFC 4180 compliant comma-separated values table with proper string escaping (`""`), suited for spreadsheet inspection and legal filing.

3. **Query Filters & Pagination**:
   - Supports timestamp ranges (`from`, `to`), action filtering (`takedown`, `restore`), target signal filtering, and bounded cursor-based pagination (default 100, max 1000 records).

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_168` / `FEATURE_PHASE_168` or set to `0`. The export endpoint returns `404`, and existing moderation audit records on disk remain unchanged.
