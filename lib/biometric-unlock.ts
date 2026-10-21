/**
 * Biometric unlock for returning wallets with OS-gated session.
 * Spike 628 / Issue #491.
 *
 * Previously the session was raw: `getAddress` restore on mount + focus, a
 * `userDisconnectedRef` boolean, and the wallet-kit's plaintext
 * `@StellarWalletsKit/selectedModuleId` in localStorage. A returning user
 * either auto-restored or had to fully reconnect — there was no
 * tap-to-unlock middle state.
 *
 * This module gates the cached session behind the OS biometric gate
 * (Face ID / Touch ID / platform authenticator via WebAuthn), entirely
 * off-chain — no contract change, the opposite layer from spike 555
 * (Passkey/Klefki on-chain check_auth smart accounts):
 *
 * - The session payload (wallet, module, timestamp) is sealed with an
 *   AES-GCM key derived (HKDF) from a WebAuthn assertion signature over a
 *   challenge bound to the wallet address. Producing the signature requires
 *   the OS biometric; the key is non-extractable and only lives in memory.
 * - The envelope (iv + ciphertext + wallet binding) persists in localStorage
 *   under `@Phase/biometric-session-envelope` — ciphertext only, no session
 *   material in plaintext.
 * - Failed attempts are counted in a separate plaintext meta key; too many
 *   failures trigger a cooldown lockout.
 * - Corrupt, stale (TTL), or cross-wallet envelopes fail closed.
 *
 * Feature flag: phase-172.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_172 / FEATURE_PHASE_172; the
 * lock screen never mounts and auto-restore behaves exactly as before. Stored
 * envelopes remain inert ciphertext on disk.
 */

import { isFeatureEnabled } from "@/lib/feature-flags";
import type { StorageLike } from "@/lib/types/freighter-mobile";
import type {
  BiometricErrorCode,
  BiometricLockMeta,
  BiometricLockState,
  BiometricSessionEnvelope,
  BiometricSessionPayload,
} from "@/lib/types/biometric-unlock";

export function isBiometric172Enabled(): boolean {
  return isFeatureEnabled("phase-172");
}

export const BIOMETRIC_ENVELOPE_LS_KEY = "@Phase/biometric-session-envelope";
export const BIOMETRIC_META_LS_KEY = "@Phase/biometric-lock-meta";
/** Sealed sessions re-gate via OS biometric after this long. */
export const BIOMETRIC_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const BIOMETRIC_MAX_FAILED_ATTEMPTS = 5;
export const BIOMETRIC_LOCKOUT_MS = 5 * 60_000;
export const BIOMETRIC_CHALLENGE_PREFIX = "phase-biometric-unlock-v1:";

export class BiometricUnlockError extends Error {
  code: BiometricErrorCode;

  constructor(code: BiometricErrorCode, message: string) {
    super(message);
    this.name = "BiometricUnlockError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64 helpers (browser + Node, no Buffer dependency)
// ─────────────────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when this device offers an OS-gated (platform) authenticator —
 * Face ID / Touch ID / Windows Hello / Android biometrics. False on the
 * server and on browsers without WebAuthn.
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  try {
    const PKC = (
      globalThis as {
        PublicKeyCredential?: {
          isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
        };
      }
    ).PublicKeyCredential;
    if (!PKC?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    return await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Challenge, key derivation, envelope seal/open
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic, wallet-bound challenge: an assertion over these bytes can
 * only derive the key that opens this wallet's envelope (cross-wallet replay
 * fails at decrypt).
 */
export function buildBiometricChallenge(wallet: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`${BIOMETRIC_CHALLENGE_PREFIX}${wallet}`));
}

/**
 * Derives the non-extractable AES-GCM envelope key from a WebAuthn assertion
 * signature. `subtle` is injectable for tests.
 */
export async function deriveUnlockKey(
  assertionSignature: ArrayBuffer | Uint8Array,
  wallet: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<CryptoKey> {
  const bytes =
    assertionSignature instanceof Uint8Array
      ? new Uint8Array(assertionSignature)
      : new Uint8Array(assertionSignature);
  const baseKey = await subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buildBiometricChallenge(wallet),
      info: new Uint8Array(new TextEncoder().encode("phase-biometric-envelope")),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: the key never leaves WebCrypto
    ["encrypt", "decrypt"],
  );
}

export async function sealSessionEnvelope(
  payload: BiometricSessionPayload,
  key: CryptoKey,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<BiometricSessionEnvelope> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new Uint8Array(new TextEncoder().encode(JSON.stringify(payload)));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    v: 1,
    wallet: payload.address,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    sealed_at: Date.now(),
  };
}

export async function openSessionEnvelope(
  envelope: BiometricSessionEnvelope,
  key: CryptoKey,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<BiometricSessionPayload> {
  try {
    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.ciphertext),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as BiometricSessionPayload;
    if (!parsed || typeof parsed.address !== "string" || !parsed.address) {
      throw new Error("envelope payload missing address");
    }
    return parsed;
  } catch {
    // AES-GCM auth-tag failure covers tampering and wrong-key decryption.
    throw new BiometricUnlockError(
      "CORRUPT_ENVELOPE",
      "The sealed session could not be opened with this device's biometric key.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebAuthn assertion (OS biometric gate)
// ─────────────────────────────────────────────────────────────────────────────

export interface CredentialsLike {
  get(options: { publicKey: Record<string, unknown> }): Promise<{ signature?: ArrayBuffer } | null>;
}

function defaultCredentials(): CredentialsLike | null {
  try {
    if (typeof navigator !== "undefined" && navigator.credentials) {
      return navigator.credentials as unknown as CredentialsLike;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Requests an OS-biometric-gated assertion over the wallet-bound challenge.
 * Throws `CANCELLED` on user dismissal (not counted as a failed attempt) and
 * `UNSUPPORTED` when WebAuthn is absent.
 */
export async function requestBiometricAssertion(
  wallet: string,
  creds: CredentialsLike | null = defaultCredentials(),
): Promise<Uint8Array> {
  if (!creds) {
    throw new BiometricUnlockError(
      "UNSUPPORTED",
      "WebAuthn credentials API unavailable on this device.",
    );
  }
  const publicKey: Record<string, unknown> = {
    challenge: buildBiometricChallenge(wallet),
    userVerification: "required",
    allowCredentials: [],
  };
  if (typeof location !== "undefined" && location.hostname) {
    publicKey.rpId = location.hostname;
  }
  let assertion: { signature?: ArrayBuffer } | null;
  try {
    assertion = await creds.get({ publicKey });
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : "";
    if (name === "NotAllowedError") {
      throw new BiometricUnlockError(
        "CANCELLED",
        "Biometric prompt was dismissed or timed out.",
      );
    }
    throw new BiometricUnlockError(
      "NOT_ALLOWED",
      `Biometric assertion failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!assertion?.signature) {
    throw new BiometricUnlockError("NOT_ALLOWED", "Biometric assertion returned no signature.");
  }
  return new Uint8Array(assertion.signature);
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage (localStorage, injectable for tests)
// ─────────────────────────────────────────────────────────────────────────────

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function clearBiometricSession(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(BIOMETRIC_ENVELOPE_LS_KEY);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Reads and shape-validates the stored envelope. Corrupt markers are cleared
 * and reported as absent — they never throw into the UI.
 */
export function readBiometricEnvelope(
  storage: StorageLike | null = defaultStorage(),
): BiometricSessionEnvelope | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(BIOMETRIC_ENVELOPE_LS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BiometricSessionEnvelope;
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.wallet !== "string" ||
      !parsed.wallet ||
      typeof parsed.iv !== "string" ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.sealed_at !== "number"
    ) {
      clearBiometricSession(storage);
      return null;
    }
    return parsed;
  } catch {
    clearBiometricSession(storage);
    return null;
  }
}

export function isEnvelopeExpired(envelope: BiometricSessionEnvelope, now: number = Date.now()): boolean {
  return now - envelope.sealed_at > BIOMETRIC_SESSION_TTL_MS;
}

export function readLockMeta(storage: StorageLike | null = defaultStorage()): BiometricLockMeta {
  const fallback: BiometricLockMeta = { failed_attempts: 0, locked_until: null };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(BIOMETRIC_META_LS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<BiometricLockMeta>;
    if (typeof parsed.failed_attempts !== "number") return fallback;
    return {
      failed_attempts: parsed.failed_attempts,
      locked_until: typeof parsed.locked_until === "number" ? parsed.locked_until : null,
    };
  } catch {
    return fallback;
  }
}

function writeLockMeta(meta: BiometricLockMeta, storage: StorageLike | null): void {
  try {
    storage?.setItem(BIOMETRIC_META_LS_KEY, JSON.stringify(meta));
  } catch {
    // best-effort persistence
  }
}

export function clearBiometricLockMeta(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(BIOMETRIC_META_LS_KEY);
  } catch {
    // best-effort cleanup
  }
}

/** Counts a failed unlock; at the attempt ceiling starts the cooldown. */
export function registerFailedUnlockAttempt(
  now: number = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): BiometricLockMeta {
  const meta = readLockMeta(storage);
  const failed = meta.failed_attempts + 1;
  const next: BiometricLockMeta =
    failed >= BIOMETRIC_MAX_FAILED_ATTEMPTS
      ? { failed_attempts: 0, locked_until: now + BIOMETRIC_LOCKOUT_MS }
      : { failed_attempts: failed, locked_until: meta.locked_until };
  writeLockMeta(next, storage);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seal / unlock / gate / state machine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seals the connected session behind the OS biometric gate. Called on an
 * explicit connect (user gesture) so the first prompt is expected. Returns
 * false on any failure — the app then behaves exactly as before.
 */
export async function sealBiometricSession(
  payload: BiometricSessionPayload,
  opts: { storage?: StorageLike | null; creds?: CredentialsLike | null } = {},
): Promise<boolean> {
  if (!isBiometric172Enabled() || !payload?.address) return false;
  const storage = opts.storage ?? defaultStorage();
  const creds = opts.creds ?? defaultCredentials();
  try {
    const signature = await requestBiometricAssertion(payload.address, creds);
    const key = await deriveUnlockKey(signature, payload.address);
    const envelope = await sealSessionEnvelope(payload, key);
    storage?.setItem(BIOMETRIC_ENVELOPE_LS_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/**
 * The tap-to-unlock flow: OS biometric → derived key → envelope open →
 * wallet binding + TTL validation. Failures are typed and counted (except
 * user cancels).
 */
export async function unlockWithBiometric(
  opts: {
    storage?: StorageLike | null;
    creds?: CredentialsLike | null;
    now?: number;
  } = {},
): Promise<BiometricSessionPayload> {
  if (!isBiometric172Enabled()) {
    throw new BiometricUnlockError(
      "FLAG_DISABLED",
      "Biometric unlock is disabled (phase-172 flag off).",
    );
  }
  const storage = opts.storage ?? defaultStorage();
  const now = opts.now ?? Date.now();

  const meta = readLockMeta(storage);
  if (meta.locked_until && now < meta.locked_until) {
    throw new BiometricUnlockError(
      "LOCKED_OUT",
      `Too many failed unlock attempts. Try again in ${Math.ceil((meta.locked_until - now) / 1000)}s.`,
    );
  }

  const envelope = readBiometricEnvelope(storage);
  if (!envelope) {
    throw new BiometricUnlockError(
      "NO_ENVELOPE",
      "No sealed biometric session is stored on this device.",
    );
  }
  if (isEnvelopeExpired(envelope, now)) {
    clearBiometricSession(storage);
    throw new BiometricUnlockError(
      "EXPIRED",
      "The sealed biometric session expired — reconnect your wallet.",
    );
  }

  try {
    const signature = await requestBiometricAssertion(envelope.wallet, opts.creds ?? defaultCredentials());
    const key = await deriveUnlockKey(signature, envelope.wallet);
    const payload = await openSessionEnvelope(envelope, key);
    if (payload.address !== envelope.wallet) {
      throw new BiometricUnlockError(
        "WALLET_MISMATCH",
        "Sealed session wallet does not match the envelope binding.",
      );
    }
    clearBiometricLockMeta(storage);
    return payload;
  } catch (e: unknown) {
    // User dismissal and missing capability are not failed guesses — they do
    // not consume attempts. Wrong-key/tamper failures do.
    if (e instanceof BiometricUnlockError) {
      if (e.code !== "CANCELLED" && e.code !== "UNSUPPORTED") {
        registerFailedUnlockAttempt(now, storage);
      }
    } else {
      registerFailedUnlockAttempt(now, storage);
    }
    throw e;
  }
}

/**
 * True when the wallet layer must hold the auto-restore behind the lock
 * screen: flag on + a valid (non-expired) sealed envelope exists.
 */
export function requiresBiometricGate(storage: StorageLike | null = defaultStorage()): boolean {
  if (!isBiometric172Enabled()) return false;
  const envelope = readBiometricEnvelope(storage);
  if (!envelope) return false;
  return !isEnvelopeExpired(envelope);
}

/** Synchronous lock-state machine consumed by the lock screen UI. */
export function biometricLockState(
  opts: { sessionUnlocked?: boolean; storage?: StorageLike | null; now?: number } = {},
): BiometricLockState {
  if (!isBiometric172Enabled()) return "disabled";
  if (opts.sessionUnlocked) return "unlocked";
  const storage = opts.storage ?? defaultStorage();
  const envelope = readBiometricEnvelope(storage);
  if (!envelope) return "no-envelope";
  if (isEnvelopeExpired(envelope, opts.now ?? Date.now())) return "no-envelope";
  const meta = readLockMeta(storage);
  const now = opts.now ?? Date.now();
  if (meta.locked_until && now < meta.locked_until) return "locked-out";
  return "locked";
}

export interface BiometricCopy {
  title: string;
  body: string;
  unlock: string;
  retry: string;
  lockedOut: string;
  unsupported: string;
  skip: string;
}

export function biometricCopy(lang: "en" | "es"): BiometricCopy {
  return lang === "es"
    ? {
        title: "Sesión bloqueada",
        body: "Desbloqueá tu sesión con Face ID / Touch ID para continuar con tu wallet.",
        unlock: "Desbloquear con biometría",
        retry: "Reintentando…",
        lockedOut: "Demasiados intentos. Esperá unos minutos o reconectá tu wallet.",
        unsupported: "Este dispositivo no ofrece desbloqueo biométrico. Conectá tu wallet para continuar.",
        skip: "Reconectar wallet",
      }
    : {
        title: "Session locked",
        body: "Unlock with Face ID / Touch ID to continue with your wallet.",
        unlock: "Unlock with biometrics",
        retry: "Retrying…",
        lockedOut: "Too many attempts. Wait a few minutes or reconnect your wallet.",
        unsupported: "This device has no biometric unlock. Connect your wallet to continue.",
        skip: "Reconnect wallet",
      };
}
