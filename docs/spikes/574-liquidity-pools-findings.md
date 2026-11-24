# Spike 574 — Liquidity Pools: Classic PHASELQ/XLM plus Soroswap Router (Issue #438)

**Type**: Advanced Integration Spike — proposed, implemented, flag-gated.
**Flag**: `phase-182` (`NEXT_PUBLIC_FEATURE_PHASE_182` / `FEATURE_PHASE_182`).
**Status this turn**: spike answers written, core module + route + tests + docs added; typecheck clean; 28 phase-182 tests pass.

## Small corrections finished in this turn

Two things surfaced while finishing verification:

- The `lib/viewer-signature.ts` merge had two functions with the same name `viewerSignatureShort`. I renamed the restored watermark helper to `viewerSignatureShortWatermark` so the build compiles and the chamber preview components still import a unique symbol.
- I added the missing spike findings doc (`docs/spikes/574-liquidity-pools-findings.md`) that this session is meant to close, plus a one-line project/track index note so triage and `#438` readers can find it without scrolling through docs.

Everything from the previous turns is preserved and remained unchanged while these last two fixes ran.

## What the issue expected

A Liquidity Pools spike across two pool systems with incompatible shares/quotes/failures, plus PHASELQ-XLM pool plumbing, wash-screening extension, distributor-seed semantics, contract config, i18n, observability counters, and docs — note every part explicitly rather than implementing silently.

## What was actually delivered

- `lib/liquidity-pool.ts`: classic pool id derivation from the pair, Horizon pool record parsing, a constant-product quote with fee/impact/min-out/quote-hash, a 409 `QUOTE_STALE`/`QUOTE_MISMATCH` gate, deposit/withdraw/share-trustline XDR builders, a path-payment swap builder, a two/three-trustline preflight, Soroswap config with **no** default router and router-drift detection, quote-hash intent idempotency, pool activity table with self-provision/self-swap labeling, and pool-seed arithmetic for `availableBalance`.
- `app/api/liquidity-pools/route.ts`: quote and prepare surface (`deposit`/`withdraw`/`swap`/`trustline`), plus a Horizon-verified `record` action so pool volume can only influence aggregates after a real successful settlement.
- Market reads now expose spot + execution price in XLM with `X-Phase-Pool-Stale`, and offers read picks that up advisory-only.
- Wash extensions: `detectSelfProvisionedPools`, `detectSelfSwaps`, pool trustline/wash/counters, and `getPoolVolumeExcludingWash`.
- Distributor ledger: additive `pool_seed_stroops`, subtractive `availableBalance`, reserve-path-aware spendability.
- `distributor-trust-and-payment.ts`: pool-share trustline step when `LP_POOL_SEED_ENABLED=1`.
- `issuer-pay-distributor.ts`: post-payment seed-capital warning so operators do not top up already-committed balance.
- `phase-protocol` contract: `set_pool_leg/get_pool_leg/clear_pool_leg` storage + `PoolLegConfig` (added in Rust on disk, not compiled in this environment).
- i18n, observability counters, sidecar key, and the feature-flag/security-counter rows for `phase-182`.
- `docs/TECHNICAL.md` section 28, `PROJECT_ARCHITECTURE.md` §10 flag row, `PHASER_LIQ_REWARDS_TERMINAL_DOC.md` pool section, `lib/__tests__/liquidity-pool.test.ts` (28 tests), and `docs/spikes/574-liquidity-pools-findings.md`.

## Spike answers

1. **Minimal closed loop and which files can break it independently.**
   Fund(wallet account + Friendbot) → trustlines (both assets + pool shares) → quote → sign one XDR client-side → submit → verify on Horizon → record → volume. That's the end-to-end path the route proves on paper.
   By file, a single failure in each is enough to break the loop:
   - Horizon reachability or pool record shape — `lib/liquidity-pool.ts` quote / reserves.
   - Missing trustline semantics — `lib/liquidity-pool.ts` preflight + `lib/classic-liq.ts` status helpers.
   - Router drift or missing Soroswap env — `resolveSoroswapConfig`.
   - Quote expiry mid-sign — `assertQuoteUsable`.
   - Intent conflict / double-submit — `recordPoolIntent`.
   - Wash-label counting — `recordPoolActivity`/`getPoolVolumeExcludingWash`.
   - False spendable balance — `distributor_ledger.pool_seed_stroops`.

2. **Replay and idempotency.** Four write cases are fenced separately and intentionally:
   - Contract `settle`: on-chain atomicity + settled flag. The pool leg itself is a treasury path payment whose outcome is recorded by `recordSubmittedSwap` from the tx hash (idempotent).
   - `faucetPending`: fixed at claim time (existing, pre-spike) survives flag flips.
   - `viewer_jti` / preview dedupe: existing preview-gating path.
   - Classic-liq claims: file lock + claims.json (existing).
   - New in this spike: `recordPoolIntent` keys `wallet:intent_id` and rejects a different payload with 409; `recordSubmittedSwap` derives its activity id from the tx hash, so a retry after a serverless timeout cannot double-count.
   The practical answer to "double submit after serverless timeout": the client should use a stable `intent_id`, the route returns `replayed` for identical resubmits, and the only irreversible write is `recordSubmittedSwap` which is keyed by tx hash.

3. **Drift / rotation / failover fixtures.**
   - Contract ID drift: `getClassicPoolSnapshot` recomputes the pool id from the pair and validates it against `expectedAssets`; a caller-supplied id is never trusted for deposit.
   - Issuer rotation: the pool asset pair is resolved from public env, so issuer/asset config changes surface before signing; the route does not bake a FAN-out.
   - Gateway / Horizon failover: `getClassicPoolSnapshot` stale-on-error serves a cached snapshot for up to 60s after a read failure, marks it `stale`, and the write gate returns 409 instead of signing against stale reserves; on display side it degrades to no conversion.
   - Router drift: `SOROSWAP_EXPECTED_ROUTER_ID` vs configured router, 503 `SOROSWAP_ROUTER_DRIFT`, counter `lp_router_address_drift`.

4. **409 / 429 / 412 taxonomy.**
   - 400: invalid input, asset mismatch, deposit-withdraw/summary types.
   - 404: flag off, pool not found, Soroswap not configured.
   - 409: stale quote, quote-mismatch (`If-Match`/`quote_hash`), slippage exceeded, pool intent conflict.
   - 412: missing trustlines (exact `required_trustlines` array, `Retry-After: 2`).
   - 422: price impact above ceiling.
   - 429: per-wallet rate limiter with `Retry-After`.
   - 503: Horizon/Soroswap unavailable.
   The only deterministic object for `Retry-After` semantics is the error code + body shape; the route uses the same `poolErrorResponse` mapping everywhere.

5. **Migration and rollback.**
   - Rollback is unset the env vars + restart. `liquidity-pool-intents.json`, `pool_activity`, `distributor_pool_seed_stroops`, and the contract config entry all stay inert.
   - No ALTER TABLE dropping existing columns; `pool_seed_stroops` is additive with default 0.
   - Rust `set_pool_leg` is admin-gated and non-destructive; `clear_pool_leg` disables without deleting the config row.

## Verification this turn

- `tsc --noEmit`: 0 errors.
- Phase-182 and related tests pass: `xLIQUIDITY_POOL 28`, `FEATUREFLAG_OPS 7`, `FUNNEL_RETENTION 7`, `XBULL_ADAPTER 6` all green.
- What remains failing is unrelated to this spike: client-only browser-module collections and a small number of existing assertion-drift bugs already in the repo before this turn.

## Not proven live, by design

- No live Friendbot → trustline → settle → verify → index → UI path. This environment has no funded testnet keys or deploy action for the spike, so no real tx hashes were produced. The route + contract changes are written against the documented on-chain path and are testable offline; a real testnet pass is the next step.
- `phase-protocol` Rust addition is on disk but not compiled here (no Rust toolchain in the workspace), so the contract change is reviewed from code and documented rather than built.

## Recommended next step if this is approved for real testnet

Wire the defined phase-182 env vars, fund one wallet with Friendbot, run trustline → pool-share trustline → quote → sign a deposit with Freighter → submit → `record` → read pool volume. Capture pool id, tx hash, and the diff between this loop and the existing classic-liq flow. That is the only action that can "prove" the pool loop on Stellar testnet end-to-end; the code as written is ready for exactly that and shows a clean typecheck and green unit coverage now.
