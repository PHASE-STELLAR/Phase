# Spike 696 — Prediction Markets on Drop Outcomes with Resolve-to-Creator Bonus Findings (Issue #559)

## What the issue claimed

The issue noted that drop milestones, collector goals, and secondary floor thresholds had no community forecasting mechanisms, and creators lacked incentive alignment mechanisms to resolve markets transparently upon drop completion.

## What the code actually did at spike time

- Marketplace and drop routes tracked static collection listings and mint counts without community speculation or prediction interfaces.
- No market prediction engine, outcome share issuance, or creator resolution bonus accounting existed.
- SQLite had no schema for prediction markets or trader outcome positions.

## The gap that was real

Drop events lacked native prediction market infrastructure where collectors can stake on milestones (e.g., sold-out within 24 hours, floor target reached) with automated payout pools and creator resolution incentives.

## Delivered specification (phase-149)

1. **Prediction market engine (`lib/prediction-markets.ts`)**:
   - Supports YES / NO binary outcome shares.
   - Proportional share pricing based on pool reserves (`reserveYes`, `reserveNo`).
   - Resolution with creator bonus fee (default 5% cut to creator when market is resolved).
   - Position staking, share accounting, and payout calculation (`payout = (shares / winningShares) * distributablePool`).
2. **Persistence (`lib/sqlite-db.ts`)**:
   - `prediction_markets` table tracking question, creator, outcome reserves, status, and resolution details.
   - `prediction_positions` table tracking user shares and claim status.
3. **API endpoint (`app/api/predictions/route.ts`)**:
   - GET: Query active markets or specific market state and price quotes.
   - POST: Create market, place bet/stake, resolve market (creator only), and claim winnings.

## Decision & Rollback

- Gated under feature flag `phase-149` (`NEXT_PUBLIC_FEATURE_PHASE_149` / `FEATURE_PHASE_149`).
- Rollback: unset env var and restart. Prediction state in SQLite remains inert.
