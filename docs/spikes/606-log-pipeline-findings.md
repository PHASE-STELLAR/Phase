# Spike 606 — Log Pipeline: Structured Logs to an External Sink with Sampling and Redaction Findings (Issue #470)

## What the issue claimed / what the code did

- `lib/api-observability.ts` wrote one JSON line per event to `console.*`; no batching, sampling, or external transport.
- Ad-hoc `console.*` callers (faucet, Horizon, proxy, stellar, market, i18n) bypass it entirely.
- Counters (`security-counters`, `signal-version-metrics`, bulkhead) are process-local and never exported.
- Nothing stopped a `rawPayload`/`errorResult` serialization from carrying an `S...` seed into Vercel logs.

## Delivered slice (phase-170)

- **Redaction** (`redactLogValue`): `S...` seeds masked in every string; keys matching secret/seed/private/passphrase/password/authorization/api key/token/rawPayload/errorResult/signature are replaced wholesale (`signature_verified` and `token_id` are deliberately kept). Applied before sampling and before the console line is written.
- **Sampling** (`shouldSampleLog`): warn/error always kept; info kept by FNV hash of the correlation id (default 10%), so a request is kept or dropped whole.
- **Cardinality** (`toPipelineRecord`): only `level`, `event`, `route`, `method`, `status_class` are labels; numeric and long-hex route segments collapse to `:id`; wallets, CIDs, token ids, hashes and `lastFailure` stay in unindexed `fields`.
- **Transport** (`LogPipeline`): `emit` is synchronous and never throws; bounded buffer (drop-oldest, counted); single-flight flush with an abort timeout; at-most-once (a failed batch is counted and dropped); the flush timer is `unref`'d. The sink must be `https://` (`validateServerEnv`).

## Affected files: changed or explicitly ruled out

| File | Status |
|---|---|
| `lib/api-observability.ts` | Changed: all lines go through `emitLog`. |
| `lib/security-counters.ts` | Changed: six closed `log_pipeline_*` counters. |
| `lib/env-validation.ts` | Changed: `LOG_SINK_URL` must be https. |
| `app/api/faucet/route.ts`, `app/api/soroban-rpc/route.ts`, `app/api/x402/settle/route.ts`, `app/api/forge-agent/route.ts`, `app/api/cron/faucet-health/route.ts`, `lib/stellar.ts`, `lib/market-store.ts`, `lib/i18n-loader.ts`, `lib/generation-job-store.ts` | Ruled out of this slice: their raw `console.*` calls are migrated to the context logger in a follow-up so each route's behavior change is reviewable on its own. |
| `lib/signal-version-metrics.ts`, `lib/horizon-bulkhead.ts`, `lib/webhook-alerts.ts` | Ruled out: counter export needs a decision on the sink's metrics shape. |
| `scripts/check-secret-rotation.ts`, `middleware.ts`, `vercel.json` | Ruled out: no log-shaped change is required. A `waitUntil` flush belongs in `middleware.ts` once the runtime is confirmed. |

## Rollback

Unset `FEATURE_PHASE_170` and restart: console lines are written unchanged and the buffer is dropped.

## Follow-ups

This is a partial slice. The issue's acceptance criteria that need a live testnet or hosted environment (end-to-end transaction proof, kill-the-primary resilience demo) are not claimed here; see `docs/TECHNICAL.md` for what the unit tests do cover.
