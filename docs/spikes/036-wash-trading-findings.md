# Spike 036 — Wash Trading Findings (Issue #230)

## What the issue claimed

`lib/wash-trading.ts` had **zero callers**; `market-store.createOffer` and
`app/api/market/[id]/offers/route.ts` had no `buyer != seller` check and no
sybil graph check, so 100k self-deals inflated `explore` volume 3×.
`grep -rn "washTrading|detectWash|wash_trading" app/ lib/ → 0 callers`.

## What the code actually did at spike time

- `wash-trading.ts` was **not** orphaned: `auditWashTradingWiring` is imported
  and surfaced by `app/api/phase-nft/verify/route.ts` and re-exported through
  `lib/stellar.ts`. The grep in the issue was run against a pattern that missed
  the `auditWashTradingWiring` symbol.
- The self-deal check **already existed** in the offers route
  (`listing.seller_wallet === buyer_wallet` → 400). It compared without
  normalising case, so a lower-cased wallet bypassed it.
- The write path genuinely did **not** consult the detectors: `createOffer`
  never called into `wash-trading.ts`, and no `wash_flagged` column existed, so
  no offer could be excluded from any aggregate. This part of the issue was
  correct.
- The issue's storage model was wrong: it assumed `offers` in Postgres with
  `SELECT SUM(amount)`. This repo uses `node:sqlite` (`lib/sqlite-db.ts`) and
  there was **no volume aggregate at all** — `grep volume lib/explore-domain.ts`
  returns nothing.

## The gap that was real

Nothing excluded manipulative offers from ranking, and the one existing guard
was case-sensitive. There was no `volume` function to filter, so the fix had to
add the aggregate rather than modify it.

## Policy decision: flag, not block

| Pattern | Action | Reason |
|---|---|---|
| `buyer == seller` | **400 block** | No legitimate reading of bidding on your own listing |
| circular (A→B→A in 1h) | flag, exclude from volume | Two wallets trading back and forth is usually real behaviour |
| rapid flip | flag, exclude from volume | Pricing tests by real sellers look like this |
| sybil cluster | flag, exclude from volume | A shared funding source is common (exchanges, multisig ops) |

The issue proposed flag-don't-block generally; only the self-deal case is
blocked outright. Blocking the graph-based cases would reject ordinary users
funded from the same exchange, and the actual damage in this issue is the
offer *counting toward volume*, not the offer existing.

## Volume filter architecture (delivered)

Rather than a materialized view (the issue's proposal — this is `node:sqlite`,
no materialized views), the aggregate is two indexed queries:

```sql
SELECT COALESCE(SUM(amount_phaselq), 0), COUNT(*)
  FROM offers
 WHERE listing_id = ? AND status = 'accepted' AND (wash_flagged = 0 OR ? = 1)
```

with `idx_offers_status_wash_created (status, wash_flagged, created_at DESC)`
carrying the flag alongside the status it is always read with. `includeWash`
exists only for the before/after comparison in tests and diagnostics.

## Measured cost

The screen is O(1) per offer for self-deal, plus a bounded read of ≤200 recent
accepted trades on the same token for circularity. No per-request cost that
scales with campaign size, so a 100k-offer campaign cannot amplify the check
into an outage — which was the issue's stated concern.

## Decision

Screen on write, flag rather than block for pattern matches, exclude flagged
offers from every volume aggregate, and add the aggregate with the index that
serves it. Counters `wash_trades_flagged`, `wash_volume_excluded`,
`market_volume_drift` record before/after.
