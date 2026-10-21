# Spike 626: Albedo Full Retirement-or-Parity Plan with Flagged Sunset

**Issue**: #489
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-170` (`NEXT_PUBLIC_FEATURE_PHASE_170` / `FEATURE_PHASE_170`)
**Key Surfaces**: `lib/albedo-sunset.ts`, `lib/albedo-intent-client.ts`, `lib/stellar-wallet-kit.ts`, `app/api/albedo/status/route.ts`

## Context & Motivation

Albedo was load-bearing across every signing surface: the intent client's `implicitFlow` + `isImplicitSessionAllowed`, the wallet-provider bottom banner + `syncTxPrep`, the trustline prep card + pre-sign block, the chamber / liquidity-faucet trustline guards, and the `signTransaction` early-return demanding popup permission. `@albedo-link/intent` was pinned at 0.12.0 with no flag, no sunset copy, and no migration path — removing Albedo meant a flag-day rewrite. This spike is the removal-vs-parity-freeze deprecation program (not spikes 520/537, which kept Albedo first-class with guards).

## Key Architectural Decisions

1. **Two-stage sunset program (`lib/albedo-sunset.ts`)**:
   - `parity-freeze` (default when the flag is on, `ALBEDO_SUNSET_MODE=full` alias): every existing call site keeps working; new Albedo call-site registration (`registerAlbedoCallSite`) is rejected with `CALL_SITE_FROZEN`; the pinned intent version is enforced (`checkAlbedoParityVersion` / `assertParityVersionFrozen`, `PARITY_VERSION_DRIFT`).
   - `retired` (`ALBEDO_SUNSET_MODE=retired`): `assertAlbedoCallSiteAllowed` throws `ALBEDO_RETIRED` for every registered site — a fail-closed write path.
2. **Call-site migration registry**: all six call sites (`intent-implicit-flow`, `intent-session-check`, `kit-sign-guard`, `provider-banner`, `trustline-prep-card`, `chamber-trustline-guard`) are enumerated with file + replacement so `GET /api/albedo/status` tracks program progress.
3. **Retired enforcement, surface by surface**:
   - `getAlbedoIntent()` throws before the dynamic import — the intent bundle is never loaded and no popup can open.
   - `requestAlbedoImplicitTxFlow()` short-circuits with bilingual migration copy.
   - `albedoImplicitTxAllowed()` returns `true` so pre-sign probes don't wedge users in the legacy "needed" banner state.
   - `signTransaction` (kit guard) returns the bilingual retired error when Albedo is the selected module — signing is blocked fail-closed with guidance to reconnect via Freighter / Ledger / WalletConnect.
   - The legacy implicit-tx banner is suppressed in `syncTxPrep`; `components/albedo-sunset-banner.tsx` (mounted in `FloatingHeader`) renders parity-freeze or retired copy instead, with a wallet-switch button.
   - Trustline prep card + pre-sign block and the two chamber trustline guards short-circuit with retired copy.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_170` / `FEATURE_PHASE_170` or set to `0`. `getAlbedoSunsetMode()` returns `null`, `GET /api/albedo/status` returns 404, and every Albedo call site reverts to the legacy guarded behavior (zero regression). No data migration — the program holds no state of its own.
