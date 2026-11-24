# Spike 612: A/B Experimentation Framework for Forge and Chamber Copy plus Pricing

**Issue**: #475
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-174` (`NEXT_PUBLIC_FEATURE_PHASE_174` / `FEATURE_PHASE_174`)
**Key Surfaces**: `lib/experiments.ts`, `lib/phase-copy.ts`, `lib/forge/payment-verifier.ts`, `app/api/forge-agent/route.ts`, `app/api/agent/forge/route.ts`, `app/api/x402/*`, `app/api/experiments/forge/route.ts`, `app/forge/page.tsx`, `components/fusion-chamber.tsx`

## Context & Motivation

Pricing was code, not config: `REQUIRED_AMOUNT` was hard-read in the 402 challenge builder, the on-chain verifier floor (`payment-verifier.ts:136`), three x402 shim routes and the agent's challenge clobber — changing a price meant editing all of them at once, and there was no way to measure a change. Copy was static per-lang with no variant slot. No assignment persistence existed: the phase-50 quest experiment framework was pure/in-memory and could not keep a wallet on the same variant across salt rotation or the anonymous→authed upgrade.

## Key Architectural Decisions

1. **Sticky salted bucketing (`lib/experiments.ts`)**: FNV-1a bucket over `(salt, experimentId, subject)` (phase-50 parity), but the first assignment is persisted to `experiment-assignments.json` keyed by `sha256(subject)` — salt rotation and weight changes never flip an existing subject. Subjects are only stored hashed.
2. **One resolved amount everywhere**: `resolveForgePaymentAmount(payer)` feeds the legacy challenge, the official `paymentRequirements`, the `X-Required-Amount` header, the on-chain verifier floor, the agent settle amount (which previously clobbered the challenge with `REQUIRED_AMOUNT`) and the x402 shim floors. A variant can sell at A and verify at B only if one of those call sites is skipped.
3. **Fail-safe to control**: no flag, no config, unparseable `PHASE_EXPERIMENT_CONFIG`, holdout, missing subject, or any resolver error → `REQUIRED_AMOUNT` + control copy. A pricing experiment can never make the forge unpayable or accidentally free.
4. **Client copy via a public route**: `GET /api/experiments/forge` (404 when flag off) serves the variant copy key and price; the forge page overrides the AWAITING_PAYMENT hint and the chamber overrides `paymentGateExplainer`. The chamber keeps its on-chain collection price authoritative — only copy varies there; price variants live in the forge-agent 402 flow.
5. **Copy registry**: `forgeExperiment.variants.{control,price_cut,copy_urgent}` added to `lib/phase-copy.ts` (EN/ES) with `pickForgeExperimentCopy(lang, copyKey)` falling back to control.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_174` / `FEATURE_PHASE_174` or set to `0`. Every resolver returns control; the experiments route 404s; client overrides never fetch; `experiment-assignments.json` stays inert on disk. No migrations.

## Known limitations

- The first forge-agent POST does not reliably carry a payer wallet; variant pricing on that POST resolves control until `payerAddress` is present (the settle-time verification still resolves the payer's variant floor).
- One experiment config (`forge_price_v1`) drives both copy and price axes; separate experiments per axis are a config-schema follow-up.
- Per-wallet stake-based price tiers (`staked-forge-discounts`) are not yet merged into variant resolution.
