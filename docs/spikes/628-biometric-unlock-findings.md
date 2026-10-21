# Spike 628: Biometric Unlock for Returning Wallets with OS-Gated Session

**Issue**: #491
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-172` (`NEXT_PUBLIC_FEATURE_PHASE_172` / `FEATURE_PHASE_172`)
**Key Surfaces**: `lib/biometric-unlock.ts`, `hooks/useBiometricUnlock.ts`, `components/wallet-lock-screen.tsx`, `components/wallet-provider.tsx`

## Context & Motivation

Sessions were raw: `getAddress` restore on mount + focus, a `userDisconnectedRef` boolean, the wallet-kit's plaintext `@StellarWalletsKit/selectedModuleId` in localStorage, and the artist alias fetched via API. There was no `navigator.credentials`, no `PublicKeyCredential`, no encrypted cache, no lock screen — a returning user either auto-restored or had to fully reconnect, with no tap-to-unlock middle state. This spike is the off-chain OS biometric (Face ID / Touch ID / platform) gate over the cached session — the opposite layer from spike 555 (Passkey/Klefki on-chain `check_auth` smart-account): no contract change.

## Key Architectural Decisions

1. **Wallet-bound envelope crypto (`lib/biometric-unlock.ts`)**: the session payload `{address, module_id, created_at}` is sealed with AES-GCM; the key is HKDF-derived from a WebAuthn assertion signature over `phase-biometric-unlock-v1:<wallet>`. Producing the signature requires the OS biometric, the key is non-extractable, and only ciphertext persists (`@Phase/biometric-session-envelope`) — a copied envelope cannot be opened for another wallet or device.
2. **OS gating, not app PIN**: `isPlatformAuthenticatorAvailable()` (WebAuthn platform-authenticator probe) decides capability; there is no app-level fallback credential. Missing WebAuthn → `UNSUPPORTED` → the lock screen offers the legacy reconnect path.
3. **Fail-closed validation**: TTL of 7 days (`BIOMETRIC_SESSION_TTL_MS`), wallet-binding check, AES-GCM auth-tag tamper check; corrupt envelopes are cleared and reported as absent, never thrown raw into the UI.
4. **Attempt lockout**: failed unlocks counted in a separate plaintext meta key (`@Phase/biometric-lock-meta`, counts only — no PII); 5 failures start a 5-minute cooldown. User cancels (`NotAllowedError`) deliberately do not consume attempts.
5. **Provider gate**: `WalletProvider` routes all restore paths (mount `refresh`, focus `refresh`, kit `STATE_UPDATED`) through `gateBiometric()` — a sealed envelope holds `address` at null and mounts `WalletLockScreen`. Explicit `connect()`/`openWalletPicker()` seal a new envelope (unlocked session); explicit `disconnect()` forgets it. "Reconnect wallet" on the lock screen clears the envelope and resumes the legacy flow.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_172` / `FEATURE_PHASE_172` or set to `0`. `biometricLockState()` returns `disabled`, `requiresBiometricGate()` returns false, the lock screen never mounts, and auto-restore behaves exactly as before (zero regression). Stored envelopes remain inert ciphertext on disk; clearing them is optional (`clearBiometricSession`).
