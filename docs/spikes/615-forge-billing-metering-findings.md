# Spike 615: Billing and Metering for Paid Forge Tiers with Quota Enforcement

**Issue**: #478
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-177` (`NEXT_PUBLIC_FEATURE_PHASE_177` / `FEATURE_PHASE_177`)
**Key Surfaces**: `lib/forge/billing.ts`, `app/api/forge-agent/route.ts`, `app/api/agent/forge/route.ts`

## Context & Motivation

The forge charged a flat x402 fee with no per-wallet metering: nothing stopped a wallet from settling the fee in an unbounded number of jobs, there was no daily quota, and no usage record existed to reconcile against the cost ledger or the settlement idempotency store. The only quota-like code was error-message classification for AI-provider 429s.

## Key Architectural Decisions

1. **UTC-day metering with hashed wallets**: `forge-billing.json` stores per `sha256(wallet):YYYY-MM-DD` usage `{count, jobs}` written through the locked store; raw wallets never persist. Bounded at 5,000 wallet-days (oldest pruned) and 200 jobs per wallet-day.
2. **Idempotent by jobId**: `recordForgeBillingEvent` dedups on `jobId` (settlement txHash for the agent path, generation-job id for the sync pipeline), so a serverless retry after timeout cannot double-count quota — mirroring `markSettlementUsedIfUnused` semantics.
3. **Tier config, not code**: `PHASE_FORGE_BILLING_TIERS` JSON maps tier id → daily limit (defaults standard 5 … obsidian 100); invalid config fails safe to defaults so billing can never brick the forge. `resolveBillingTier` currently returns the deployment default (`PHASE_FORGE_BILLING_DEFAULT_TIER`); per-wallet stake upgrades via `getStakedFeeTier` are a documented follow-up.
4. **Enforcement placement**: `agent/forge` checks quota *before* settle (an exhausted wallet never burns a real payment); `forge-agent` checks after settlement verification but before job creation (the settlement idempotency store still fences replays first). Refusal is `429 FORGE_QUOTA_EXCEEDED` + `Retry-After` (floor 60s, or seconds to the UTC-day reset) with tier/used/limit in the body.
5. **Metering at acceptance**: both forge paths record the billing event after the job is accepted (sync pipeline and async NanoBanana), and book `chargeSurfaceCost("forge", 20)` against the spike-614 budget.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_177` / `FEATURE_PHASE_177` or set to `0`. `checkForgeQuota` always allows, `recordForgeBillingEvent` is a no-op, routes never 429 on quota, and `forge-billing.json` stays inert on disk. No migrations.

## Known limitations

- Quota is enforced per wallet, but the first forge-agent POST may lack `payerAddress` — enforcement then defers to the settle-verified payer (always present on the paid path).
- Per-wallet stake-tier resolution and invoice/credit-note generation are follow-ups.
- Metering covers accepted jobs only; failed-generation refunds are not booked (the settlement is already consumed by design).
