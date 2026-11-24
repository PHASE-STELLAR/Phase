# Spike 622 — QR Code Flows for Receive, Offer-Claim, and Referral Share with Camera Scan Findings (Issue #485)

## What the issue claimed

The issue noted that PHASE had zero QR support across the entire protocol:
- Receiving assets was limited to displaying a truncated `G...` public key with clipboard copy.
- Referral quest sharing relied strictly on copying flat strings without visual code generation or share cards.
- The repository lacked QR matrix generation libraries, camera scan flows via `getUserMedia`, and scanner payload parsers.
- Security headers blocked camera usage outright via `Permissions-Policy: camera=()`, preventing browser camera scanner activation.

## What the code actually did at spike time

- `components/profile-panel.tsx` displayed only truncated wallet addresses and standard clipboard copy.
- `components/faucet-modal.tsx` had referral stats but no QR code visualization or scanning capabilities.
- `next.config.mjs` strictly set `Permissions-Policy: camera=(), microphone=(), geolocation=()`, outright blocking camera hardware access even if user gave browser permission.
- There was no structured QR scanner or parser recognizing SEP-0007 (`web+stellar:pay?destination=G...`), referral links (`?ref=...`), or offer handoff payloads.

## The gap that was real

Mobile users and desktop users interacting with mobile wallets (e.g. Lobstr, xBull Mobile) had no way to scan receiving addresses or share referral campaigns without manually typing or copy-pasting 56-character Stellar addresses and long URLs.

## Delivered specification (phase-166)

1. **Pure QR Generator (`lib/qr-code.ts`)**:
   - Zero-dependency Model 2 QR matrix encoder and SVG renderer (`generateQrSvg`, `qrSvgToDataUrl`).
   - Standard payload builders for Stellar pay (`buildStellarReceiveUri`), referral share (`buildReferralShareUri`), and offer claims (`buildOfferClaimUri`).
   - Server-side fallback endpoint (`GET /api/qr/encode`).

2. **Scanned QR Parser (`lib/qr-code.ts:parseScannedQrPayload`)**:
   - Detects plain Stellar addresses (`G...`), SEP-0007 URIs (`web+stellar:pay`), referral query parameters (`ref=...`), and claim tokens.

3. **Camera Diagnostics and Permissions**:
   - Updated `next.config.mjs` to `Permissions-Policy: camera=(self)` to enable camera capture on the same origin while keeping microphone and geolocation locked down.
   - Built `diagnoseCameraError` mapping `NotAllowedError`, `NotFoundError`, `NotReadableError`, and `SecurityError` to actionable user recovery steps.

4. **UI Components**:
   - `components/qr-code-dialog.tsx`: Modal for displaying high-contrast QR codes with optional amount requests, referral link generation, and one-click copy.
   - `components/qr-scanner-modal.tsx`: Interactive video viewfinder with animated reticle, camera error handling, and manual text entry fallback.
   - Integration into `profile-panel.tsx`, `faucet-modal.tsx`, `fusion-chamber.tsx`, and `wallet-provider.tsx`.

## Decision & Rollback

- Gated behind feature flag `phase-166` (`NEXT_PUBLIC_FEATURE_PHASE_166` / `FEATURE_PHASE_166`).
- Rollback: unset the env variable or set to `0`/`false` and restart. Zero persistent migration to undo.
