# Spike 693 — Staked Forge-Fee Discounts with Tiered PHASELQ Lock and Fee Tiers Findings (Issue #556)

## What the issue claimed

The issue stated that forge pricing relies on a single global required amount (`REQUIRED_AMOUNT`), settlement charges the full fixed fee without evaluating staking tier, and no discount parameter is factored into payment verification or transaction building.

## What the code actually did at spike time

- `lib/forge/payment-verifier.ts` and `app/api/x402/verify/route.ts` checked against a flat fee requirement.
- Users with significant staked or locked balances paid identical generation and settlement fees to zero-stake wallets.
- No discount tier ladder was defined to incentivize holding and locking tokens.

## The gap that was real

High-volume creators and loyal ecosystem participants had no economic incentive to stake larger balances of PHASELQ for creation workflows.

## Delivered specification (phase-147)

1. **Tiered discount ladder (`lib/staked-forge-discounts.ts`)**:
   - Tier 0 (Standard, 0 locked): 0% discount.
   - Tier 1 (Bronze, 10+ PHASELQ locked): 10% discount (1000 bps).
   - Tier 2 (Silver, 50+ PHASELQ locked): 25% discount (2500 bps).
   - Tier 3 (Gold, 200+ PHASELQ locked): 50% discount (5000 bps).
   - Tier 4 (Obsidian, 1000+ PHASELQ locked): 75% discount (7500 bps).
2. **Discount calculation (`calculateDiscountedForgeFee`)**:
   - Derives `originalFee`, `discountedFee`, and `discountApplied`.
3. **API endpoint (`app/api/x402/tier-discount/route.ts`)**:
   - GET / POST to evaluate and quote discounted fees for prospective creators.
4. **Observability**:
   - Increments closed counter `staked_fee_discount_applied`.

## Decision & Rollback

- Gated under feature flag `phase-147` (`NEXT_PUBLIC_FEATURE_PHASE_147` / `FEATURE_PHASE_147`).
- Rollback: unset env var and restart. System reverts to standard flat fees.
