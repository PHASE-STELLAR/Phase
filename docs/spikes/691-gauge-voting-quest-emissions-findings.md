# Spike 691 — Gauge Voting for Emissions with ve-Weight Directing Quest Budgets Findings (Issue #554)

## What the issue claimed

The issue noted that quest rewards are statically admin-fixed per quest without community voting, epochs, or per-collection budget apportionment. Faucet emission and distributor refill emit fixed amounts without governance direction, lacking a ve-weighted gauge mechanism to direct weekly quest budgets across collections.

## What the code actually did at spike time

- `lib/quest-registry.ts` and `app/api/admin/quests/route.ts` used static reward amounts stored in JSON sidecars.
- Distributor emission thresholds were fixed constants in `app/api/cron/faucet-health/route.ts`.
- There was no voting mechanism or epoch-based emission aggregator for collection quests.

## The gap that was real

Collection creators and communities could not signal priority or direct protocol liquidity incentives toward the highest-value quest arcs and narrative worlds.

## Delivered specification (phase-145)

1. **Gauge vote mechanism (`lib/gauge-voting.ts`)**:
   - Weekly epochs: `epoch = Math.floor(now / (7 * 86400 * 1000))`.
   - `castGaugeVote(wallet, votes)`: Voters allocate percentage weights across collections (sum <= 100%).
   - Effective vote power = `wallet_ve_weight * (weight_pct / 100)`.
2. **Epoch aggregation & budget distribution**:
   - `distributeEpochEmissions(epoch, totalBudgetStroops)`: Apportions total emission pool pro-rata across collections based on total ve-weight on each gauge.
   - `getCollectionQuestBudget(collectionId, epoch)`: Returns the calculated budget and gauge weight.
3. **Storage (`lib/sqlite-db.ts`)**:
   - `gauge_votes` and `gauge_epoch_aggregates` SQLite tables with indexed queries.
4. **API route (`app/api/governance/gauge/route.ts`)**:
   - GET / POST for voting, viewing aggregates, and emission distribution.

## Decision & Rollback

- Gated under feature flag `phase-145` (`NEXT_PUBLIC_FEATURE_PHASE_145` / `FEATURE_PHASE_145`).
- Rollback: unset env var and restart. `gauge_votes` rows remain inert on disk.
