# Spike 611: Funnel Analytics v2 with Retention Cohorts: Day-N, Wallet-Age Bands and Quest Cohorts

**Issue**: #474
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-177` (`NEXT_PUBLIC_FEATURE_PHASE_177` / `FEATURE_PHASE_177`)
**Key Surfaces**: `lib/funnel-retention.ts`, `lib/referral-quest.ts`, `lib/horizon-bulkhead.ts`, `lib/sybil-resistance.ts`, `lib/notification-store.ts`, `app/api/notifications/route.ts`, `lib/quest-snapshot.ts`, `lib/quest-streak.ts`, `lib/achievement-store.ts`, `lib/quest-registry.ts`

## Context & Motivation

V1 faucet funnel analytics (`computeClaimFunnel`) provided only coarse per-stage counts and basic step-to-step conversion without any temporal dimension. There was no time-to-convert tracking, no cohort key, and zero retention joining against `faucet-claims.json` (`genesisAt`, `dailyAt`, `quests`). Furthermore, referral claims in `lib/referral-quest.ts` used raw, unlocked file I/O that suffered from race conditions under concurrent requests. Sybil feature vectors gated participation but never labeled cohort behavior.

## Key Architectural Decisions

1. **Day-N Retention Cohorts (`lib/funnel-retention.ts`)**:
   Tracks Day-1, Day-3, Day-7, Day-14, and Day-30 retention by joining user activity timestamps from SQLite `analytics_events`, `faucet-claims.json`, and achievement unlock history against each user's cohort origin (`genesisAt` / first touch).
2. **Time-to-Convert Distribution**:
   Measures mean, median (p50), 90th percentile (p90), min, and max transition latencies between critical funnel milestones (`viewed -> wallet_connected -> claim_started -> claim_confirmed`).
3. **Wallet-Age Bands & Bulkhead Protection (`lib/horizon-bulkhead.ts`)**:
   Classifies wallets into `<24h`, `1-7d`, `7-30d`, and `>30d` age bands. To avoid saturating Horizon with RPC requests during large cohort scans, queries run through `withHorizonBulkhead` and cache in-memory with a 10-minute TTL.
4. **Sybil-Weighted Cohort Analytics (`lib/sybil-resistance.ts`)**:
   Enriches retention cohorts with sybil risk scores (`trusted`, `caution`, `suspect`), allowing operators to evaluate organic user retention separately from sybil botting waves.
5. **Race-Safe Referral Store (`lib/referral-quest.ts`)**:
   Migrated from raw `readFile`/`writeFile` to `updateStore` from `lib/json-store.ts`, ensuring all referral code generations and claim attributions execute within atomic, file-locked critical sections.
6. **Query API**:
   Exposed `GET /api/notifications?retention=1` returning structured Day-N cohorts, time-to-convert metrics, and sybil-weighted retention rates.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_177` / `FEATURE_PHASE_177` or set to `0`. Retention endpoints return 404 and reporting reverts to v1 `computeClaimFunnel`. Referral locking remains active for race safety.
