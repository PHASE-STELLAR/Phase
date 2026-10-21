# Spike 616: Leaderboard Integrity — Anti-Farm Scoring with Decay and Sybil Discount

**Issue**: #479
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-178` (`NEXT_PUBLIC_FEATURE_PHASE_178` / `FEATURE_PHASE_178`)
**Precedents Analyzed**: sybil trust bands (phase-145), wash-trade detectors (phase-77), pricing half-life decay, quest-arc farmable caps

## Context & Motivation

PHASE had no leaderboard, and any naive points table would have been gameable three ways at once: burst campaigns (post a year of points in an hour), counterparty concentration (ring-trading one partner), and fresh sybil wallets farming at full value. Existing anti-abuse modules scored wallets (`lib/sybil-resistance.ts`) and flagged wash patterns (`lib/wash-trading.ts`), but nothing fed those signals into a ranking, and nothing decayed stale activity.

## Key Architectural Decisions

1. **Pure multiplicative scoring (`lib/leaderboard-integrity.ts`)**:
   - `finalScore = decayedPoints × farmPenalty × sybilDiscount`, every stage unit-testable with an explicit `now`.
   - Decay is exponential half-life (`0.5 ** (age / 7d)`), matching `lib/pricing-oracle.ts`'s wash discount so table behavior is consistent across modules.

2. **Anti-farm signals with a floor**:
   - Three rules — `event_burst` (×0.5), `counterparty_concentration` (×0.6), `point_velocity` (×0.7) — multiply down but stop at `farmPenaltyFloor` (0.15): the goal is to compress campaign ROI, not to make one rule irreversible.

3. **Sybil discount from existing bands**:
   - Callers pass the band produced by `scoreWalletHistory()`; `trusted` keeps 100%, `caution` 70%, `suspect` 35%. A missing band resolves to `caution`, so an unscored wallet can never score at trusted rate.

4. **Storage and routes**:
   - Entries live in the `leaderboard-entries.json` sidecar (registered in `lib/server-data-paths.ts`).
   - `GET /api/leaderboard?limit=` returns the ranked top list; `POST /api/leaderboard` is admin-keyed and scores before persisting so malformed events never reach the store.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_178` / `FEATURE_PHASE_178` or set to `0`. Routes return `404`; `leaderboard-entries.json` stays inert — no migration to reverse.
