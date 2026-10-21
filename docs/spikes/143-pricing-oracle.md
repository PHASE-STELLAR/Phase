# Spike 143 — Pricing oracle (phase-143)

## What the issue claimed, checked against the code

| Claim | Verified |
|---|---|
| Market POST takes a user price with no suggestion or comp check | Yes |
| `getListings` only sorts; no per-collection aggregate | Yes |
| Offer book aggregates pending offers only; no sold-price history | Yes — and pending offers past `expires_at` are only *reported* expired (`rowToOffer`), never written |
| Wash flags exist but no aggregate consumes them for pricing | Yes — `wash_flagged` is consumed only by volume sums |
| Royalty split is pure bps math | Yes — `computeRoyaltySplit` |
| No accept time on offers | **Also true, not in the issue** — only `created_at`, up to 48h before the sale. Added `decided_at`. |

## Design

**Sales are accepted offers.** `royalty_payouts` holds the same sale again
(keyed by `offer_id`), so comps are read from `offers` only — summing both
would count every secondary sale twice.

Each comp's weight is `wash × recency`, after exclusions:

- **self** — the requesting seller on either side of a comp contributes 0. This
  is the pumping defence: your own sales cannot move your own suggestion.
- **wash** — `washCompWeight` in `lib/wash-screening.ts`: 0 if flagged; halved
  per repeat sale between the same two wallets in the window (each passed the
  per-offer circular screen alone, but a pair trading back and forth is how a
  price is walked up one legitimate-looking sale at a time).
- **recency** — `0.5^(age / 14d)` from `decided_at`.
- **outliers** — outside `[median/4, median×4]` dropped.

Suggestion = weighted median; band = weighted p25/p75; a level is used only
with ≥3 surviving comps (token → collection → global), otherwise
`INSUFFICIENT_COMPS` (explicit non-result, never an invented price). A live,
non-wash, unexpired bid above the median floors the suggestion. Net proceeds
use `computeRoyaltySplit`.

**Rationale.** A template sentence (EN/ES) is always grounded. In the treatment
arm the model may rephrase it; the reply is kept only if every cited offer id
is a used comp and every number it writes is one it was given.

**Measurement.** Every suggestion is a row with a deterministic arm
(hash(seller) < `PHASE_PRICING_CONTROL_PCT` → control: recorded, shown nothing).
The listing POST records the outcome once — a conditional
`UPDATE … WHERE outcome IS NULL`, the same claim-once shape as the settlement
replay guard — as `accepted` (±2%), `adjusted_up/down`, or `control_listed`.
Offer-accept stamps `sold_at` once. `GET /api/market/price-suggestion/stats`
reports accept rate and median time-to-sale per arm.

## File rulings

| File | Ruling |
|---|---|
| `app/api/market/route.ts` | **Changed.** Optional `suggestion_id` → outcome recorded after the listing exists (never fails the listing) + advisory `price_warning`. |
| `lib/market-store.ts` | **Changed.** `getSaleComps`, `getActiveAsks`, `getLiveBids` (filters `expires_at > now` itself), `getWashFlaggedTokenIds`; `updateOfferStatus` stamps `decided_at`. |
| `lib/wash-screening.ts` | **Changed.** `washCompWeight` — the single discount model. |
| `lib/wash-trading.ts` | **Ruled out.** Its detectors already run once per offer at write time via `wash-screening`; pricing consumes the persisted flag. Re-running them at read time would judge a sale twice and let pricing and volume disagree. |
| `app/api/market/collections/[collection_id]/offer-book/route.ts` | **Changed.** `priceBand` (seller-agnostic, no row written) beside the bids. |
| `app/api/market/[id]/offers/route.ts` | **Ruled out.** Offer creation is the wash *write* path (spike 036); pricing only reads its result. |
| `app/api/market/[id]/offers/[offer_id]/route.ts` | **Changed.** Accept stamps time-to-sale (`markSuggestionSold`). |
| `app/api/market/offers-by-buyer/route.ts` | **Ruled out.** Buyer-side history view; carries no seller-side pricing decision. |
| `app/api/nft-listings/route.ts` | **Ruled out.** Legacy JSON P2P listings with no sale record (no accepted price ever lands there), so they cannot be comps. |
| `lib/phase-nft-metadata-build.ts` | **Ruled out (trait level deferred).** Attributes live in IPFS metadata; sold listings carry no attribute snapshot, so trait comps would need an IPFS fetch per comp per request, and attributes supplied by the seller are unverified. Needs an attribute snapshot at listing time first. |
| `lib/metadata-migration.ts` | **Ruled out** for the same reason; v2 attribute shape becomes relevant once snapshots exist. |
| `lib/settlement-store.ts` | **Ruled out.** Its pattern (claim-once) is reused as a conditional SQLite `UPDATE`, which gives the same guarantee across processes; the JSON lock file is single-host. |
| `lib/phase-copy.ts` | **Changed.** `pricing` section (EN/ES). |
| `lib/api-observability.ts` | **Ruled out.** Routes use `createApiRequestContext` as-is; metadata keys are closed (`arm`, `level`, `rationale_source`). |
| `lib/cost-attribution-ledger.ts` | **Changed.** `pricing.rationale` step; job id `pricing:<suggestion_id>`. |
| `lib/security-counters.ts` | **Changed.** `pricing_*` counters (suggestions, insufficient, wash discounted, self excluded, outliers, citation rejected, outcome recorded/replay). |

New: `lib/pricing-oracle.ts`, `app/api/market/price-suggestion/**`.

## Tests

`lib/__tests__/pricing-oracle.test.ts` (13): weighted quantiles; self
exclusion on either side (case-insensitive); wash exclusion and repeat-pair
halving; half-life decay and outlier trimming; the discount model; level
fallback; explicit insufficient result (ES copy); bid floor + royalty net;
control arm shown nothing and no model call; model rationale rejected for an
unknown number or unknown offer id and accepted when grounded; real SQLite —
accepted offers only, royalty payouts not double counted, lazily-expired bids
excluded; outcome recorded once / mismatch / not found; time-to-sale once;
expired suggestion; outcome classification.

## Known limits

- No category level (the protocol has no categories); thin collections fall
  straight to the global prior.
- `decided_at` is NULL for offers decided before this change; comps fall back
  to `created_at` for those.
