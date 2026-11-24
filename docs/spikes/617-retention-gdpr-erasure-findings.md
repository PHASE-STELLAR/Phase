# Spike 617: Data Retention and GDPR Erasure Pipeline with TTL Sweeps and Wallet Deletion

**Issue**: #480
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-179` (`NEXT_PUBLIC_FEATURE_PHASE_179` / `FEATURE_PHASE_179`)
**Precedents Analyzed**: Article 20 portability export (phase-167), legal-hold deny-delete (phase-169), generation-job TTL prunes, SEP-10 sessions

## Context & Motivation

GDPR Article 20 (portability) shipped in spike 634, but Article 17 (erasure) did not exist: nothing deleted a wallet's records across stores, and no scheduled sweep expired time-shaped data — SEP-10 sessions, consumed challenges and notifications accumulated until something else rewrote them. Deletion also had to coexist with the phase-169 legal hold, which exists precisely to block destructive operations during investigations.

## Key Architectural Decisions

1. **Two halves, one flag (`lib/retention-erasure.ts`)**:
   - **TTL sweeps** — `sweepByTimestamp` (pure, fail-safe: records without a parseable timestamp are kept), `sweepAuthSessions` (expired SEP-10 sessions in seconds or ms, consumed challenges past 24h), `sweepNotificationStore` (90-day notifications, dry wallet buckets removed), orchestrated by `runRetentionSweeps()`.
   - **Wallet erasure** — `executeWalletErasure()` walks five registered domains (`notifications`, `age_declarations`, `follows`, `push_subscriptions`, `auth_sessions`), counts removed records per domain, and appends a receipt to `gdpr-erasure-log.json`.

2. **Legal hold gates every erasure**:
   - `assertNoLegalHold("wallet", …)` runs before any write; a hit throws `LEGAL_HOLD_ACTIVE` (HTTP 423 via the route) and increments `gdpr_erasure_blocked` — held data survives the attempt verbatim.

3. **Receipts are minimized**:
   - The receipt stores `wallet_fingerprint` (`fingerprintWallet()`), never the raw address; the log is capped at 1000 receipts and versioned `phase-gdpr-article-17-erasure` / `1.0.0`.

4. **Deliberate exclusions**:
   - The terms-consent ledger is NOT erased: consent records prove the legal basis kept under Art. 17(3)(b); withdrawal is recorded, not shredded.
   - SQLite tables (signals, replies, listings, offers, tax events) are a documented partial slice — erasure covers JSON sidecars only.

5. **Cron**: `GET /api/cron/retention-sweep` runs daily at 03:15 UTC behind `validateCronAuth`, the preview cron fence and the phase-171 restore marker (sweeping mid-restore would fight the restore write).

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_179` / `FEATURE_PHASE_179` or set to `0`. The erasure route and sweep cron return `404`; stored receipts stay inert.
