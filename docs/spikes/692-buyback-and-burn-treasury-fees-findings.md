# Spike 692 — Buyback-and-Burn from Treasury Fees with Programmatic PHASELQ Burn Findings (Issue #555)

## What the issue claimed

The issue asserted that protocol treasury fees serve as a passive sink with no spend, no burn, and no on-chain balance accounting. SAC tokens are only minted during refills and never burned, with no programmatic deflationary feedback loop.

## What the code actually did at spike time

- `app/api/x402/settle/route.ts` and protocol contracts collected the 5% protocol treasury share, but treasury balances were purely accumulated without a scheduled or threshold-triggered burn path.
- `lib/distributor-refill.ts` minted tokens to refill the distributor without compensating burns from protocol revenue.
- No SQLite tracking or audit log existed to prove burned quantities to community observers.

## The gap that was real

Without an automated buyback-and-burn mechanism, the 5% treasury fee share accumulated statically on-chain without generating deflationary pressure or returning value to long-term token holders.

## Delivered specification (phase-146)

1. **Buyback and burn ledger (`lib/buyback-burn.ts`)**:
   - `executeBuybackAndBurn(amountSpentStroops, source, txHash)`: Programmatically records buyback and permanent burn events into `buyback_burn_events` SQLite table.
   - `getBuybackStats()`: Aggregates total spent, total burned, and last event metadata for explorer and dashboard consumption.
2. **API route (`app/api/treasury/buyback/route.ts`)**:
   - GET / POST endpoints for monitoring and executing buyback-and-burn cycles.
3. **Observability**:
   - Increments `buyback_burn_executed` counter with zero PII.

## Decision & Rollback

- Gated under feature flag `phase-146` (`NEXT_PUBLIC_FEATURE_PHASE_146` / `FEATURE_PHASE_146`).
- Rollback: unset env var and restart. SQLite table rows remain inert historical record.
