# Spike 608: Dependency-Update Cadence Automation with Grouped Soroban and Stellar Updates

**Issue**: #472
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-175` (`NEXT_PUBLIC_FEATURE_PHASE_175` / `FEATURE_PHASE_175`)
**Key Surfaces**: `lib/dependency-cadence.ts`, `scripts/check-dependency-cadence.ts`, `.github/dependabot.yml`, `package.json`, `scripts/package.json`, `contracts/phase-protocol`, `contracts/mock-token`

## Context & Motivation

PHASE previously maintained two diverged JavaScript dependency universes and an inconsistent Rust/WASM build pipeline:
1. Root `package.json` pinned `@stellar/stellar-sdk` `^15.0.1` (`15.0.1`), `next` `16.2.2` (with `overrides.next`), `react` `19.2.0`, and declared `packageManager: "yarn@1.22.22..."` despite CI running `npm ci`.
2. `scripts/package.json` pinned `@stellar/stellar-sdk` `^12.0.0` (`12.3.0` — three major versions behind root), built `phase-protocol` with `--target wasm32v1-none` while `.github/workflows/ci.yml` and `scripts/deploy-phase-sep50.ts` used `--target wasm32-unknown-unknown`, and installed `stellar-cli` via an unpinned `^23` range.
3. `.github/workflows/dependency-audit.yml` only watched root `package*.json` and had no grouped Dependabot config or WASM bytecode-diff gate.

## Key Architectural Decisions

1. **Unified `@stellar/stellar-sdk` v15 Across Root and `scripts/`**: Upgraded `scripts/package.json` and `scripts/package-lock.json` to `@stellar/stellar-sdk` `^15.0.1` (`15.0.1`, `@stellar/stellar-base` `15.0.0`, `@stellar/js-xdr` `4.0.0`). `verifyStellarSdkSorobanEncodingParity()` in `lib/dependency-cadence.ts` verifies that `TransactionBuilder`, `Contract.call`, `Address.fromString(...).toScVal()`, and `nativeToScVal(BigInt, { type: "i128" })` produce valid, distinct XDR envelopes for `mint` and `transfer`.
2. **Canonical WASM Target (`wasm32-unknown-unknown`) & Soroban ABI Pin (`22000`)**: Aligned `scripts/package.json` (`build:phase`, `optimize:phase`) with `.github/workflows/ci.yml` and `scripts/deploy-phase-sep50.ts` on `wasm32-unknown-unknown`, pinned `stellar-cli` `23.0.0`, and added `pub fn soroban_abi_version(_env: Env) -> u32 { 22_000 }` plus `[package.metadata.phase_cadence]` to both `contracts/phase-protocol` and `contracts/mock-token`.
3. **WASM Bytecode-Diff & Staging Dry-Run Gate (`evaluateWasmBytecodeDiffGate`)**: Computes SHA-256 digests of baseline vs. candidate WASM artifacts and blocks deployment if `sorobanAbiVersion !== 22000` or if the bytecode hash changed without `stagingDryRunPassed: true`.
4. **Grouped Dependabot & CI Enforcement**: Added `.github/dependabot.yml` with weekly grouped PRs (`stellar-sdk-root`, `stellar-sdk-scripts`, `nextjs-react-bonded`, `vitest-bonded`, `soroban-sdk-phase-protocol`, `soroban-sdk-mock-token`, `github-actions`) and wired `npm run deps:cadence` into `ci.yml`, `dependency-audit.yml`, and `secret-rotation.yml`.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_175` / `FEATURE_PHASE_175` or set to `0`. `/api/faucet` omits `sorobanAbiVersion` metadata and runtime cadence flags remain off.
