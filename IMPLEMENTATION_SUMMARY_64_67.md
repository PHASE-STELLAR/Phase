# Implementation Summary: Issues #64, #65, #66, #67

All four issues follow the repo's established pattern: an **isolated, flag-gated
domain module** appended to a `lib/*-store.ts`, wired additively into its API
route and UI, with a `node:test` unit suite. Every flag defaults **off** → zero
behavioural change until explicitly enabled.

New feature flags (`lib/feature-flags.ts`): `phase-136`, `phase-137`, `phase-138`.

Run the new suites:

```
node --test --import ./node_modules/tsx/dist/loader.mjs \
  lib/__tests__/cid-gateway-cache.test.ts \
  lib/__tests__/profile-error-taxonomy.test.ts \
  lib/__tests__/cost-attribution-ledger.test.ts
```

---

## Issue #64 — CID gateway resolution cache with TTL + health scoring (phase-136)

**Problem:** every metadata read re-resolved a CID against the gateway list from
scratch, and a degrading gateway kept being picked until it hard-failed.

**Module:** `lib/signal-store.ts`
- `resolveCidGateway(cid, opts)` — memoizes the CID→gateway URL per CID with a
  TTL (default 5 min, bounded 1 s–24 h). Flag off ⇒ deterministic first-gateway
  pick, no caching.
- `recordCidGatewayOutcome({ gateway, ok, latencyMs })` — feeds a rolling health
  model (success ratio 70 % + EWMA latency 30 %); a recorded failure evicts every
  cache entry pinned to that gateway.
- `scoreGateway`, `getCidGatewayCacheStats`, `extractIpfsCidPath`,
  `__resetCidGatewayCacheForTests`.
- Typed errors: `CidResolutionError` (`FLAG_DISABLED` / `VALIDATION_FAILED` /
  `NO_GATEWAY`); zod `CidResolutionRequestSchema`, `GatewayOutcomeSchema`.

**Wiring:**
- `app/api/signals/[id]/replies/route.ts` — POST + GET responses now carry
  `signalMedia: { image, gateway }` (resolved, cached) and an
  `X-Phase136-Gateway` header when the signal has an IPFS `nft_image`.
- `app/signals/[id]/page.tsx` — renders the resolved gateway URL for the signal's
  NFT image, falling back to the stored URL on any failure.

**Tests:** `lib/__tests__/cid-gateway-cache.test.ts` (9 cases) — flag-off
passthrough, TTL hit/expiry, health ranking, failure-driven eviction, cold-cache
best-gateway pick, malformed-input handling, `extractIpfsCidPath`.

---

## Issues #65 & #66 — Structured error taxonomy for avatar / x402 failures (phase-137)

Issues #65 and #66 are duplicates (same title, same file set); one coherent
implementation resolves both — the server taxonomy (#65) and the client
retry-policy wiring (#66).

**Problem:** avatar / gateway / invoice failures all surfaced as a single generic
`500 Internal server error`, so a Pinata timeout, a checksum mismatch and a bad
wallet were indistinguishable in logs and the client couldn't tell a retryable
blip from a permanent failure.

**Module:** `lib/profile-store.ts`
- `ProfileError` — carries `code`, deterministic `status`, `category`
  (`client` / `upstream` / `integrity` / `config` / `internal`) and `retryable`.
- Closed taxonomy `PROFILE_ERROR_CODES` (13 codes) with a status/category/retry
  table.
- `classifyProfileError(err)` — maps AbortError/timeouts → `GATEWAY_TIMEOUT`
  (504, retryable), DNS/conn failures → `GATEWAY_UNREACHABLE`, checksum/tamper →
  `CHECKSUM_MISMATCH`, `{ status }` upstream errors → 4xx/5xx/429, `ZodError` →
  `MALFORMED_RESPONSE`, everything else → `INTERNAL`.
- `toProfileErrorResponse(err)` → `{ body, status }`; zod
  `ProfileErrorResponseSchema`.

**Wiring:**
- `app/api/profile/avatar/route.ts` — GET/POST catch blocks and the POST
  fetch/pin failure branches emit the structured body (`{ error, code, category,
  retryable }`) with the taxonomy's status when the flag is on; legacy generic
  500 otherwise. Invalid-wallet GET returns `INVALID_WALLET` (400).
- `components/wallet-avatar.tsx` — reads `retryable` from the response and does
  **one** silent retry on a retryable upstream code before settling on initials;
  surfaces the final `code` via `data-avatar-error` / `title` for observability.
  Fetch is now abortable.

**Tests:** `lib/__tests__/profile-error-taxonomy.test.ts` (9 cases) — pass-through,
timeout/DNS/checksum/status/Zod mapping, unknown→INTERNAL, schema-valid response
bodies, full-taxonomy coverage.

---

## Issue #67 — Cost attribution ledger per request (phase-138)

**Problem:** infra spend (Horizon fan-out on the follow-suggestions path,
notification writes, profile enrichment) was never attributed to the request that
caused it, so the treasury couldn't reconcile spend against revenue.

**Module:** `lib/follow-store.ts`
- `recordRequestCost({ requestId, operation, count?, units?, source?, wallet? })` —
  appends a cost line to a bounded (5 000-entry) in-memory ledger; flag off ⇒
  no-op returning `0`. `BILLABLE_OPERATIONS` taxonomy with default unit weights
  (`OPERATION_UNIT_COST`).
- `getRequestCost(requestId)`, `getCostLedger({ operation?, sinceMs?, limit? })`,
  `summarizeCostByOperation()` (treasury view), `__resetCostLedgerForTests`.
- Typed `CostAttributionError` (`VALIDATION_FAILED`); zod
  `CostAttributionInputSchema`.

**Wiring:**
- `app/api/profile/follow/route.ts`
  - **Bug fix:** the file used `isFeatureEnabled`, `FollowSuggestionQuerySchema`
    and `getFollowSuggestions` without importing them — the suggestions endpoint
    would throw `ReferenceError` at runtime. Imports added (net −22 project type
    errors).
  - Suggestions path books `follow.suggestions` + `horizon.*` + per-profile
    `profile.enrichment` cost and returns `costUnits` + `X-Phase138-Cost-Units`.
  - Follow/unfollow POST books `follow.write` (+ `notification.create`) and
    returns `costUnits`.
- `app/profile/[wallet]/follow-button.tsx` — `FollowSuggestions` surfaces the
  request's cost as `STELLAR GRAPH · <n>u`.

**Tests:** `lib/__tests__/cost-attribution-ledger.test.ts` (7 cases) — flag-off
no-op, unit weighting, count scaling + explicit override, treasury aggregation,
operation filter, malformed-input error, per-request isolation.

---

## Verification

- `npx tsc --noEmit`: **65 → 43** pre-existing errors (net −22; the follow-route
  missing imports). No new type errors in any changed file.
- Full test suite: **192 → 217 passing**, `+25` new, **0 regressions** (the 6
  pre-existing failures — `narrative-search`, `forge-pipeline`,
  `watchlist-price-drops` — are unchanged and unrelated).
- `eslint`: no new errors or warnings in changed files.
- All three flags default off ⇒ every route/UI path is byte-identical to `main`
  until `NEXT_PUBLIC_FEATURE_PHASE_136/137/138` (or `FEATURE_PHASE_*`) is set.
