# Mainnet Cutover Runbook

This document specifies the operational procedure for transitioning PHASE from Stellar testnet to mainnet under feature flag `phase-238` (Issue #689).

## Prerequisites & Dual-Authorization Gates

To prevent accidental mainnet cutover or partial deploys:
1. **Explicit Cutover Acknowledgement**: `PHASE_MAINNET_CUTOVER_ACK=1`
2. **Dual Confirmation Token**: `PHASE_MAINNET_CONFIRMATION_TOKEN` (high-entropy secret string, minimum 16 characters)
3. **Issuer Public Key**: `PHASE_MAINNET_ISSUER_PUBLIC_KEY` (must be a valid Ed25519 public key `G...`)
4. **Contract ID**: `PHASE_MAINNET_CONTRACT_ID` (must be a valid Soroban contract ID `C...`)
5. **Canonical Mainnet Passphrase**: `Public Global Stellar Network ; September 2015`

## Dry-Run Verification

Before executing any live mainnet traffic or migrations, run the cutover verification in dry-run mode:

```bash
FEATURE_PHASE_238=1 \
PHASE_MAINNET_CUTOVER_ACK=1 \
PHASE_MAINNET_CONFIRMATION_TOKEN="<16+-char-secure-token>" \
PHASE_MAINNET_ISSUER_PUBLIC_KEY="<G...>" \
PHASE_MAINNET_CONTRACT_ID="<C...>" \
npm run mainnet:cutover -- --dry-run
```

The script will:
- Validate all public keys and Soroban contract IDs format.
- Verify canonical Stellar passphrase alignment.
- Confirm zero writes are made in dry-run mode (`PHASE_MAINNET_DRY_RUN=1`).
- Ensure testnet-only fixtures and mock faucet endpoints fail closed.

## Cutover Execution

Once dry-run verification succeeds:
1. Export environment variables to production runtime.
2. Enable `FEATURE_PHASE_238=1`.
3. Restart production containers.
4. Verify `/api/health` and network status endpoint.

## Rollback Procedure

To roll back immediately:
1. Unset `STELLAR_NETWORK` (defaults back to `testnet`).
2. Unset `FEATURE_PHASE_238` or set to `0`.
3. Restart service instances.
