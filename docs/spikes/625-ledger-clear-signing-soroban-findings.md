# Spike 625 — Ledger Blind-Signing to Clear-Signing Review for Soroban Transactions Findings (Issue #488)

## What the issue claimed

The issue noted that Ledger hardware integration relied solely on blind-signing:
- `LedgerModule` handled basic HID/USB connection with an 8-second heartbeat, USB event hooks, passphrase guards, and transport/timeout error strings.
- Zero Soroban decoding existed: `settle`, `create_collection`, and `transfer` operations were signed completely blind on-device.
- Soroban Gate #13 errors (`SelfTransfer` or context failure) surfaced only post-submit via `humanizePhaseHostErrorMessage`.
- No pre-sign review of amount, recipient, or target contract ID existed.
- Users lacked an on-device verification pre-image hash or verification code to validate call parameters against the physical device screen.

## What the code actually did at spike time

- `lib/stellar-wallet-kit.ts` passed raw transaction XDR directly to `StellarWalletsKit.signTransaction` with basic passphrase checking, leaving the Ledger device to sign opaque hashes without preflight validation.
- When users had "Blind signing" disabled in their Ledger Stellar app settings (error `0x6b0c` or `0x6a15`), the app threw cryptic transport errors without explaining that blind signing or clear signing had to be enabled in app settings.
- If a user inadvertently signed an invalid invocation (e.g., self-transfer), the transaction consumed hardware interaction and fee cycles only to reject on-chain with Gate #13.

## The gap that was real

Soroban smart contract transactions bundle complex `invokeHostFunction` arguments (`ScVal`). Ledger hardware devices either require explicit clear-signing review or fail with blind-signing disabled errors. Without decoding:
1. Users have no guarantee of contract address or recipient before approving on hardware.
2. Self-transfers and invalid authorizations result in wasted user effort and unhelpful errors.
3. Cryptic hardware error codes leave users stuck.

## Delivered specification (phase-169)

1. **Soroban Pre-Image Decoder (`lib/ledger-soroban-decoder.ts`)**:
   - Decodes `invokeHostFunction` operations into human-readable target contracts, functions (`settle`, `create_collection`, `transfer`, `initiate_phase`), and typed arguments.
   - Computes deterministic SHA-256 pre-image hash matching on-device parameters.
   - Generates formatted verification code (`VREF-XXXX-XXXX`) for visual on-device matching.
2. **Preflight Gate #13 Detection**:
   - Validates parameters before hardware transmission.
   - Detects `SelfTransfer` risk (`from === to`) and invalid values early, blocking device prompt and incrementing `ledger_gate13_preempted`.
3. **Clear-Signing Review Modal (`components/ledger-clear-signing-modal.tsx`)**:
   - Interactive pre-sign modal presenting contract label, function, recipient, amounts, fee, and verification code with mandatory user acknowledgement before sending payload to Ledger.
4. **Hardware Error Humanization**:
   - `humanizeLedgerHardwareErrorMessage` in `lib/phase-host-error.ts` and `mapLedgerHardwareError` in `lib/ledger-soroban-decoder.ts`.
   - Recognizes `0x6b0c` / `0x6a15` (blind-signing disabled), `0x6985` (user rejected), and `0x6e00` (device locked/timed out).
5. **Telemetry & Audit Counters**:
   - Route `POST /api/wallet/ledger` tracking clear-signing reviews and outcomes.
   - Counters in `lib/security-counters.ts`: `ledger_clear_signing_reviewed`, `ledger_clear_signing_approved`, `ledger_clear_signing_rejected`, `ledger_blind_signing_blocked`, `ledger_gate13_preempted`.

## Decision & Rollback

- Gated under feature flag `phase-169` (`NEXT_PUBLIC_FEATURE_PHASE_169` / `FEATURE_PHASE_169`).
- Rollback: unset env var or set to `0`/`false` and restart. Zero persistent state or migrations required.
