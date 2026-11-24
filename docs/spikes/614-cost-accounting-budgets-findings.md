# Spike 614: Cost Accounting per Surface with Budgets, Burn-Rate Alerts and Kill-Switches

**Issue**: #477
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-176` (`NEXT_PUBLIC_FEATURE_PHASE_176` / `FEATURE_PHASE_176`)
**Key Surfaces**: `lib/cost-budgets.ts`, `app/api/cron/cost-budgets/route.ts`, `app/api/cost-budgets/health/route.ts`, `app/api/forge-agent/route.ts`, `app/api/agent/forge/route.ts`, `vercel.json`

## Context & Motivation

Spend was attributed (phase-138 in-memory units, the cost-attribution ledger's dollar estimates) but never *bounded*: nothing stopped a runaway surface from burning budget unattended, and the only kill-switch in the repo was contract-side (`DataKey::MainnetKillSwitch` in `contracts/mock-token`). There was no burn-rate concept and no server-side per-surface halt.

## Key Architectural Decisions

1. **Closed surface taxonomy**: `COST_SURFACES = ["faucet","forge","agent","chamber","explore","profile","world","market"]` — labels never derive from wallets, request ids or other unbounded values (`security-counters.ts` rule).
2. **Persisted daily windows**: `cost-budgets.json` holds per-surface `{windowStart, spentUnits, alertLevel}` written through the locked `updateStoreWithReader`; the window rolls on `PHASE_COST_BUDGET_WINDOW_MS` (default 24h) at charge/evaluate time.
3. **Budgets from env**: `PHASE_COST_BUDGET_<SURFACE>` (units) — unset/0 means unlimited (inert surface). Warning at 80% (`PHASE_COST_BUDGET_WARNING_RATIO`), halt at ≥100%. A process-local halt cache keeps `isSurfaceHalted()` disk-free on the hot path.
4. **Transition-only alerts**: `evaluateSurfaceBudgets` fires `sendWebhookAlert` (warning/critical/info) only when a surface's `alertLevel` changes; the webhook module's own 15min dedup is the second layer. Recovery (`*→ok`) emits an info alert.
5. **Kill-switch enforcement**: `forge-agent` and `agent/forge` refuse with `503 FORGE_SURFACE_HALTED` + `Retry-After: 300` before any spend; `chargeSurfaceCost` refuses further booking once halted and counts `budget_halt_refusal`. Hourly cron (`/api/cron/cost-budgets`, `validateCronAuth` pattern from faucet-health, registered in `vercel.json`) evaluates + alerts; `GET /api/cost-budgets/health` is the operator view (evaluation without alerts so a dashboard poll cannot spam webhooks).

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_176` / `FEATURE_PHASE_176` or set to `0`. Charging is a no-op, `isSurfaceHalted` is always false, routes never refuse, cron reports disabled, and `cost-budgets.json` stays inert on disk. No migrations.

## Known limitations

- The halt cache is per-process: on serverless each instance relearns on its first charge/cron tick (budget overshoot up to one in-flight request per instance).
- Cross-instance budget consistency needs a shared store (same json-store scope limit as every sidecar).
- Charge wiring is minimal (forge-agent/agent-forge paths); faucet, explore and Horizon fan-out surfaces register as closed labels but need their own `chargeSurfaceCost` call sites.
