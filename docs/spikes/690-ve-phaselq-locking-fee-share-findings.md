# Spike 690 — ve-PHASELQ Locking with Time-Locked Weight Plus Fee Share Findings (Issue #553)

## What the issue claimed

The issue stated that the protocol hardcodes a 95/5 fee split (95% creator, 5% treasury) with no accounting of who earned the treasury share, no lock primitive exists in storage (only UserPhase, TokenOwner, X402Payment, Collection keys), off-chain balances only check liquid balances, and rewards offer no time-weighted governance vesting.

## What the code actually did at spike time

- Contract and protocol routes recorded payments with 5% treasury allocation, but treasury proceeds accumulated unsegregated without distribution to long-term token lockers.
- `lib/distributor-ledger.ts` tracked spendable vs reserve balances only for auto-refill solvency, with no governance lock segregation.
- No SQLite schema or service existed to track escrow lock durations, decay curves, or accrued fee checkpoints.

## The gap that was real

Without ve-locking mechanisms, short-term speculators held equal influence to long-term participants, and the 5% protocol treasury fee stream lacked a programmatic distribution mechanism to reward aligned ecosystem participants.

## Delivered specification (phase-144)

1. **ve-Lock model (`lib/ve-phaselq.ts`)**:
   - Time-decaying weight: `weight = amount * (weeks / 208)` (max lock 4 years / 208 weeks).
   - Minimum lock: 1 week; maximum lock: 208 weeks.
   - Operations: `createOrUpdateVeLock`, `withdrawVeLock`, `readVeLock`.
2. **Fee accumulator & pro-rata distribution**:
   - `distributeTreasuryFees(epochId, feeStroops)`: Records total fees arriving in each epoch and computes `fee_per_weight = feeStroops / totalVeWeight`.
   - `calculateClaimableFees(wallet)`: Multiplies user's active ve-weight by historical epoch fee-per-weight deltas since `last_claim_epoch`.
   - `claimFees(wallet)`: Settles accrued fees and advances checkpoint.
3. **Storage (`lib/sqlite-db.ts`)**:
   - `ve_locks` table and `ve_fee_distribution` table with atomic WAL updates.
4. **API route (`app/api/governance/ve-lock/route.ts`)**:
   - GET / POST for locking, status queries, fee claims, and distributions.

## Decision & Rollback

- Gated behind feature flag `phase-144` (`NEXT_PUBLIC_FEATURE_PHASE_144` / `FEATURE_PHASE_144`).
- Rollback: unset env var and restart. `ve_locks` and `ve_fee_distribution` SQLite rows remain inert.
