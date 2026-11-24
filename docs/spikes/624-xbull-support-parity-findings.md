# Spike 624 — xBull Full Support with Sign, Trustline and Freighter-Difference Matrix Findings (Issue #487)

## What the issue claimed

The issue noted that xBull was only supported implicitly via `defaultModules()` without direct module referencing:
- Never referenced by ID (`XBULL_ID`).
- No visual badge or identity recognition for xBull users.
- No `isXBullSelected` helper (only hardware and WalletConnect helpers existed).
- No error-mapping branch for xBull-specific error strings / objects.
- Comment mentioned Albedo and xBull, but zero xBull-specific logic was provided; xBull fell through generic Freighter-shaped assumptions (e.g., expecting `signedTxXdr` exclusively).
- Lack of Freighter vs. xBull difference matrix in documentation.

## What the code actually did at spike time

- `lib/stellar-wallet-kit.ts` loaded modules via `defaultModules()` which bundles xBull, but treated all extension signing results as standard Freighter objects (`signedTxXdr`).
- When xBull returned alternative result shapes or rejected with distinct error messages, the UI reported generic failures or failed silently.
- Profile and wallet components lacked any badge indication of connected wallet provider.

## The gap that was real

Freighter and xBull exhibit differing behavior in:
1. Result encapsulation: xBull can return `{ xdr: string }`, `{ result: string }`, or raw transaction strings, whereas Freighter returns `{ signedTxXdr: string }`.
2. Error representation: xBull rejections often provide structured error objects or distinct string messages (`User rejected`, `Transaction rejected`, `Denied by user`) that differed from Freighter's.
3. Execution model: xBull can operate as a web app popup (iframe / window) in addition to browser extension, necessitating distinct user prompts.

## Delivered specification (phase-168)

1. **Freighter vs. xBull Difference Matrix (`lib/xbull-adapter.ts`)**:
   - Documented comparison table detailing transport mechanism, popup vs extension behavior, signing response formats, and error models.
2. **xBull Detection & Helpers**:
   - `XBULL_ID` constant and `isXBullSelected()` helper inspecting active wallet module.
   - `WalletContextValue.isXBull` surfaced across the React tree.
3. **Sign Result Normalization**:
   - `normalizeXBullSignResult()` converting heterogeneous outputs (`xdr`, `result`, `signedTxXdr`, raw string) into canonical `{ signedTxXdr: string }`.
   - Updated `parseSignedTxXdr()` in `lib/classic-liq.ts` to support all xBull shapes.
4. **Error Mapping & Telemetry**:
   - `mapXBullError()` translating rejection codes and messages into user-friendly localized feedback.
   - Audit security counters tracking xBull signing lifecycle (`xbull_sign_requested`, `xbull_sign_success`, `xbull_sign_rejected`, `xbull_trustline_signed`, `xbull_error_mapped`).
5. **Visual Badge Integration**:
   - `components/wallet-badge.tsx` rendering an amber 🐂 badge for xBull in `components/profile-panel.tsx` and `components/wallet-avatar.tsx`.

## Decision & Rollback

- Gated under feature flag `phase-168` (`NEXT_PUBLIC_FEATURE_PHASE_168` / `FEATURE_PHASE_168`).
- Rollback: unset env var or set to `0`/`false` and restart. Zero persistent state or migrations required.
