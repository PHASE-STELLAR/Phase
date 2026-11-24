# Spike 607: Feature-Flag Ops — Staged Rollout, Per-Wallet Targeting and Kill-Switch Drills

**Issue**: #471
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-174` (`NEXT_PUBLIC_FEATURE_PHASE_174` / `FEATURE_PHASE_174`)
**Key Surfaces**: `lib/feature-flags.ts`, `app/api/admin/feature-flags/route.ts`, `app/api/faucet/route.ts`, `lib/distributor-refill.ts`, `app/api/cron/faucet-health/route.ts`

## Context & Motivation

Feature flags previously relied solely on static boolean environment reads (`NEXT_PUBLIC_FEATURE_*` then `FEATURE_*` via `isTruthy`). `getEnabledFeatureFlags()` omitted `phase-134` and `phase-135` while `PhaseFeatureFlag` duplicated `phase-128`. Critically, because `NEXT_PUBLIC_*` variables are baked into the client bundle at build time, server-side write paths had no way to halt a misbehaving flag (such as `phase-133` distributor auto-topup/refill) without an environment edit and redeploy, nor could operators target specific wallets or ramp flags in basis points without risking mid-poll `faucetPending` divergence.

## Key Architectural Decisions

1. **Build-Time vs. Runtime Split & Kill-Switch Precedence (`lib/feature-flags.ts`)**: `evaluateFeatureFlag(flag, context)` records both `clientBundled` (`NEXT_PUBLIC_FEATURE_*`) and `serverConfigured` (`FEATURE_*`) exposure while evaluating server runtime rules in strict order: `PHASE_KILL_SWITCH_FLAGS` env -> `rule.killSwitch` -> `rule.denyWallets` -> `rule.allowWallets` -> `rule.overrideEnabled` -> `rule.rolloutBps` -> static env fallback. An active kill-switch disables server write paths immediately even when `NEXT_PUBLIC_*` was baked in at build time.
2. **Deterministic FNV-1a Basis-Point Rollout (`flagRolloutBucket`)**: Uses 32-bit FNV-1a over `${flag}|${wallet}` modulo `10_000`, matching `questExperimentBucket` in `lib/env-validation.ts`. Ramping `rolloutBps` upward (`0 -> 1000 -> 5000 -> 10000`) is strictly monotonic and never flips an already-enrolled wallet off.
3. **Mid-Poll `faucetPending` Idempotency (`app/api/faucet/route.ts`)**: `faucetPending` now persists `amountStroops: effectiveAmountStroops` at transaction submission time. If `phase-131` (streak multiplier) is ramped or killed during the 8-minute `FAUCET_PENDING_TTL_MS` polling window, subsequent poll retries reuse both the in-flight `hash` and the pinned `amountStroops`.
4. **Stale-on-Error In-Memory Rule Cache & Optimistic CAS**: `refreshFeatureFlagOpsCache()` hydrates rules from `feature-flag-ops.json` (`lib/server-data-paths.ts`). If the sidecar read fails, the cache retains the last-known-good rules (`cacheState: "stale"`) and increments `flag_ops_stale_fallback`. Concurrent operator updates with a stale `expectedVersion` / `If-Match` fail with `409 VERSION_CONFLICT` (`flag_ops_version_conflict`).
5. **Non-Destructive Kill-Switch Drill (`runKillSwitchDrill`)**: Verifies build-env kill override, 50-wallet monotonic rollout ramp, `faucetPending` mid-poll idempotency, and stale-cache resilience, restoring pre-drill state in `finally`.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_174` / `FEATURE_PHASE_174` or set to `0`. `GET/POST /api/admin/feature-flags` returns 404, flags revert to static environment evaluation, and `feature-flag-ops.json` remains inert on disk.
