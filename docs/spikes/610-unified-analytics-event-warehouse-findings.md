# Spike 610: Unified Analytics Event Warehouse Across Faucet, Claim, Notifications, Forge, and Push Funnels

**Issue**: #473
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-176` (`NEXT_PUBLIC_FEATURE_PHASE_176` / `FEATURE_PHASE_176`)
**Key Surfaces**: `lib/analytics-warehouse.ts`, `lib/sqlite-db.ts`, `lib/server-data-paths.ts`, `lib/notification-store.ts`, `app/api/notifications/route.ts`, `lib/api-observability.ts`, `app/api/faucet/route.ts`, `lib/push-notifications.ts`, `lib/achievement-store.ts`, `lib/quest-registry.ts`, `lib/generation-job-store.ts`, `app/api/forge-agent/route.ts`, `app/api/agent/forge/route.ts`, `app/api/jobs/[txHash]/route.ts`, `app/api/webhooks/nanobanana/route.ts`

## Context & Motivation

Prior to this spike, event tracking in PHASE existed in three isolated, disconnected pockets:
1. **Faucet funnel 5k-ring sidecar**: Kept only the last 5,000 happy-path stages (`viewed -> wallet_connected -> claim_started -> claim_signed -> claim_confirmed` + `claim_failed`) in an unindexed JSON sidecar with purely in-memory aggregation.
2. **Notification store point state**: Maintained point state capped at 50 notifications per wallet with zero delivery lifecycle events or drop-off tracking.
3. **Observability console logs**: Emitted per-request `correlationId` lines with unbounded JSON metadata, with no persistent indexing or join key connecting anonymous web traffic to on-chain wallet actions.

Crucially, the faucet claim lifecycle (pending 8-min TTL, 4x1s poll, 202/409/502 responses) emitted zero funnel events, rendering abandoned or timed-out claims completely invisible to operators.

## Key Architectural Decisions

1. **SQLite WAL Persistence & Deduplication Key Idempotency (`lib/sqlite-db.ts`, `lib/analytics-warehouse.ts`)**:
   Introduced `analytics_events` table indexed by `surface`, `stage`, `wallet`, `session_id`, `correlation_id`, `ts`, and a unique `dedupe_key` (`SHA256(surface:stage:subject:minuteBucket)`). Duplicate polling attempts and retry requests execute `INSERT OR IGNORE`, ensuring event ingestion is strictly idempotent without ballooning storage or skewing metrics.

2. **Session Stitching (`analytics_session_stitching`)**:
   Anonymous top-of-funnel events (e.g., `"viewed"`) carry a client-generated `session_id`. When the visitor subsequently connects a wallet, the session mapping is recorded, and all preceding anonymous events are joined to the authenticated wallet. Funnel and retention metrics calculate true conversion from first anonymous touchpoint to confirmed on-chain mint.

3. **Cross-Surface Lifecycle Event Sourcing**:
   - **Faucet & Claim**: Emits `claim_pending`, `claim_polling`, `claim_status_202`, `claim_status_409`, `claim_status_502`, `claim_confirmed`, and `claim_failed` stages during both immediate execution and serverless resume cycles.
   - **Notifications**: Emits `notification_created`, `notification_read`, and `all_read` events alongside push notifications `push_dispatched` and `push_failed`.
   - **Observability**: Enforces bounded closed-label metadata and captures request completion/failure metrics.
   - **Forge & AI Agents**: Emits `forge_started`, `forge_paid`, `forge_polling`, `forge_completed`, `webhook_received`, and `agent_forge_settled`.
   - **Quests & Achievements**: Records `quest_evaluated` and `achievement_unlocked` events.

4. **Bounded Closed-Label Metadata Sanitization (`sanitizeAnalyticsMetadata`)**:
   To prevent uncontrolled storage growth and accidental PII/secret leaks, metadata payloads are sanitized: keys are capped at 25, string values are truncated to 256 characters, and sensitive keys (`authorization`, `cookie`, `secret`, `token`, `password`, `admin_secret_key`) are strictly redacted.

5. **Backward-Compatible 5k-Ring Migration**:
   On initialization, `migrateLegacyFunnelEvents()` reads `faucet-funnel-events.json` and inserts existing ring events into SQLite with `INSERT OR IGNORE`, ensuring historical faucet funnel metrics are retained seamlessly without data loss.

6. **Unified Analytics API & GDPR Article 20 Portability**:
   `GET /api/notifications?warehouse=1&surface=faucet` provides stage-by-stage counts, drop-offs, conversion rates, and average time-to-convert (ms). `exportAnalyticsForWallet(wallet)` generates comprehensive data portability export packages conforming to GDPR Article 20.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_176` / `FEATURE_PHASE_176` or set to `0`. Writing halts safely; existing rows in `analytics_events` remain inert on disk; API routes fall back to pre-phase-176 behavior.
