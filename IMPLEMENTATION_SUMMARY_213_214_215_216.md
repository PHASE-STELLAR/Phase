# Implementation Summary: Flags #213, #214, #215, #216

One branch, four flag-gated follow-ups. All flags default **off**; unsetting a
flag restores the legacy path with no data migration. The precursor slices
(phase-154/160/161/164/165) were ported from `origin/spike/batch-550-599`
because they were never merged into `main`.

## phase-213 — live RUM + PR-blocking web-vitals gate

- `components/web-vitals-reporter.tsx` observes LCP/INP/CLS and posts to a
  closed-label ingest route only while `NEXT_PUBLIC_FEATURE_PHASE_213` is on.
  Payload is exactly five fields: normalized route, metric, value, SHA-256 hash
  of a per-session UUID, and timestamp. No query, wallet, IP or user agent.
- `app/api/rum/ingest/route.ts` rejects any extra field, `lib/rum-store.ts`
  persists a bounded sidecar with atomic locked writes. Flag off → 404.
- `lib/web-vitals-budgets.ts` extends the phase-160 table with p75 evaluation,
  baseline deltas and a markdown PR body. `scripts/evaluate-web-vitals.ts`
  exits 1 on a configured regression; `.github/workflows/web-vitals-budget.yml`
  comments the delta table and blocks the PR. Flag off → evaluator SKIPs and
  the workflow job is skipped.
- Fixtures: `tests/fixtures/rum-{field-data,baseline,regression}.json`.
  `tests/web-vitals-gate.test.ts` proves a deliberate regression blocks the gate.

## phase-214 — transport taxonomy + bounded retry

- Ported `lib/phase-error-taxonomy.ts` (contract codes 1..39) and added a
  disjoint transport registry (1001..1004) with `retryable` hints and stable
  `userMessageKey`s. Contract lookups are unchanged.
- `lib/phase-transport-error.ts`: `RateLimitError`, `UpstreamServerError`,
  `TransportTimeoutError`, `NetworkUnreachableError`, `Retry-After` parsing
  (seconds + HTTP date), bounded jittered backoff and `withTransportRetry`
  (hard attempt cap and delay cap).
- Migrated all three callers of the legacy string helper to
  `lib/phase-error-presentation.ts`; localized transport copy lives in
  `lib/phase-copy.ts`. The Soroban RPC proxy now honours upstream
  `Retry-After` with a bounded backoff. Flag off → legacy string helpers and
  fixed 1s/2s/4s proxy backoff.

## phase-215 — signed webhook subscriptions, SSRF fence, redelivery

- Ported the phase-154 subscriber store and HMAC delivery, then added:
  `lib/webhook-ssrf.ts` (https-only, private-range denial, DNS resolution and
  pinning via `https.request` lookup, no redirects), `lib/webhook-circuit-breaker.ts`
  (CLOSED/OPEN/HALF_OPEN per endpoint), `lib/webhook-delivery-log.ts`
  (append-only, secret-redacted log + once-per-transition event dedupe).
- Real emissions: `settle.verified` (forge-agent), `market.offer_accepted`
  (offer accept), `faucet.claim_completed` (both claim success paths).
- Admin surface: subscription CRUD, delivery-log listing, redelivery endpoint,
  and `app/admin/webhook-subscriptions` UI with a Bearer-token input. Flag off
  → every admin route returns 404 and no event is emitted.

## phase-216 — age gate, license revocation, auditable decisions

- Ported `lib/age-gate.ts` (bands) and `lib/license-attestation.ts` (signed
  declarations). Added `lib/age-gate-216.ts` enforcing the configured gate on
  viewer (`POST /api/phase-nft/verify`) and claim (`POST /api/faucet`) paths
  with HTTP `451 AGE_RESTRICTED`.
- `lib/license-revocation.ts` appends revocation fields to the original
  attestation and cancels every active listing for that collection in the same
  request (`cancelListingsForCollection`). `lib/gating-audit.ts` records every
  allow/deny/cascade decision in an append-only sidecar.
- License metadata is attached to `GET /api/market` listings and to bulk CSV
  (`generateCSVTemplate`, `exportResultsToCSV`, `exportListingsWithLicenseToCSV`).
  Admin revocation route: `POST /api/admin/licenses/[collection_id]/revoke`.
  Flag off → gates no-op, no `license` field, CSV columns omitted.

## Verification

- `npx vitest run` on the five new/modified suites: **43 tests pass**.
- `./node_modules/.bin/tsx tests/web-vitals-gate.test.ts`: **3 tests pass**
  (good field data passes, deliberate regression exits 1, flag off skips).
- `npx tsc --noEmit`: no errors in files touched by this change. The repository
  has pre-existing type errors and git-only `node:test` files under
  `lib/__tests__` that `vitest` reports as "No test suite found"; those are
  unchanged by this branch.

## Rollback

Unset the relevant flag(s) and restart. No collection/evaluation, no transport
migration, no webhook emission and no gating remain active. JSON sidecars
(`rum-events.json`, `webhook-subscriptions.json`, `webhook-deliveries.json`,
`license-audit.json`) are inert and can be deleted.
