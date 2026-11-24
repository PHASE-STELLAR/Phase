# Spike 695 — Bonding Curves for Open Editions with Supply-Priced Minting Findings (Issue #558)

## What the issue claimed

The issue noted that artifact and collection prices were flat (set once at creation and returned verbatim), supply caps were constant, and open edition minting lacked dynamic continuous pricing mechanisms that scale with organic demand.

## What the code actually did at spike time

- `lib/market-store.ts` and `app/api/market/route.ts` supported fixed listing and offer prices only.
- Open editions minted at flat costs, creating either front-running rushes or flat, uninspired pricing curves.
- No reserve accumulator or mathematical bonding curve existed in SQLite.

## The gap that was real

Open edition drops lacked a native, transparent pricing curve to reward early collectors and scale edition mint costs smoothly as popularity increases.

## Delivered specification (phase-148)

1. **Continuous bonding curve model (`lib/bonding-curve.ts`)**:
   - Linear pricing curve: `price(s) = basePrice + s * slope`.
   - Batch mint cost formula: `totalPrice = k * basePrice + slope * (k*s + k*(k-1)/2)`.
   - Batch burn refund formula: `totalRefund = k * basePrice + slope * (k*(s-k) + k*(k-1)/2)`.
2. **State & Reserve storage (`lib/sqlite-db.ts`)**:
   - `bonding_curve_editions` table storing `base_price_stroops`, `slope_stroops`, `current_supply`, `max_supply`, and `reserve_stroops`.
3. **API endpoint (`app/api/market/bonding-curve/route.ts`)**:
   - GET: Real-time unit price, total price quote, next unit price, and reserve statistics.
   - POST: Commit mint / burn and update supply and reserve.

## Decision & Rollback

- Gated under feature flag `phase-148` (`NEXT_PUBLIC_FEATURE_PHASE_148` / `FEATURE_PHASE_148`).
- Rollback: unset env var and restart. Curve state in SQLite remains inert.
