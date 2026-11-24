import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BIOMETRIC_ENVELOPE_LS_KEY,
  BIOMETRIC_LOCKOUT_MS,
  BIOMETRIC_MAX_FAILED_ATTEMPTS,
  BIOMETRIC_META_LS_KEY,
  BIOMETRIC_SESSION_TTL_MS,
  BiometricUnlockError,
  biometricCopy,
  biometricLockState,
  buildBiometricChallenge,
  clearBiometricLockMeta,
  clearBiometricSession,
  deriveUnlockKey,
  isBiometric172Enabled,
  isEnvelopeExpired,
  isPlatformAuthenticatorAvailable,
  openSessionEnvelope,
  readBiometricEnvelope,
  readLockMeta,
  registerFailedUnlockAttempt,
  requiresBiometricGate,
  sealBiometricSession,
  sealSessionEnvelope,
  unlockWithBiometric,
} from "@/lib/biometric-unlock";
import type { CredentialsLike } from "@/lib/biometric-unlock";
import type { StorageLike } from "@/lib/types/freighter-mobile";
import type { BiometricSessionPayload } from "@/lib/types/biometric-unlock";

const WALLET = "GPHASEBIOMETRICTESTWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function memoryStorage(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

function fakeCreds(signature: Uint8Array, failWith?: string): CredentialsLike {
  return {
    get: async () => {
      if (failWith) {
        const e = new Error("denied");
        e.name = failWith;
        throw e;
      }
      return { signature: signature.slice().buffer as ArrayBuffer };
    },
  };
}

const SIG = new Uint8Array(64).map((_, i) => (i * 7) % 256);
const OTHER_SIG = new Uint8Array(64).map((_, i) => (i * 11) % 256);

function payload(): BiometricSessionPayload {
  return { address: WALLET, module_id: "albedo", created_at: 1_700_000_000_000 };
}

async function sealInto(storage: StorageLike, creds: CredentialsLike) {
  const ok = await sealBiometricSession(payload(), { storage, creds });
  expect(ok).toBe(true);
}

describe("phase-172 biometric unlock", () => {
  const originalFlag = process.env.FEATURE_PHASE_172;

  beforeEach(() => {
    process.env.FEATURE_PHASE_172 = "1";
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_PHASE_172;
    else process.env.FEATURE_PHASE_172 = originalFlag;
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  });

  it("checks the feature flag", () => {
    expect(isBiometric172Enabled()).toBe(true);
    process.env.FEATURE_PHASE_172 = "0";
    expect(isBiometric172Enabled()).toBe(false);
  });

  it("fails closed everywhere while the flag is off", async () => {
    process.env.FEATURE_PHASE_172 = "0";
    const storage = memoryStorage();
    expect(biometricLockState({ storage })).toBe("disabled");
    expect(requiresBiometricGate(storage)).toBe(false);
    expect(await sealBiometricSession(payload(), { storage, creds: fakeCreds(SIG) })).toBe(false);
    await expect(
      unlockWithBiometric({ storage, creds: fakeCreds(SIG) }),
    ).rejects.toMatchObject({ code: "FLAG_DISABLED" });
  });

  it("builds a deterministic wallet-bound challenge", () => {
    const a = buildBiometricChallenge(WALLET);
    const b = buildBiometricChallenge(WALLET);
    expect(Array.from(a)).toEqual(Array.from(b));
    const other = buildBiometricChallenge("GOTHERWALLET");
    expect(Array.from(other)).not.toEqual(Array.from(a));
  });

  it("seals and opens an envelope round-trip", async () => {
    const key = await deriveUnlockKey(SIG, WALLET);
    const envelope = await sealSessionEnvelope(payload(), key);
    expect(envelope.v).toBe(1);
    expect(envelope.wallet).toBe(WALLET);
    expect(envelope.iv).toBeTruthy();
    expect(envelope.ciphertext).toBeTruthy();

    const opened = await openSessionEnvelope(envelope, key);
    expect(opened).toEqual(payload());
  });

  it("fails closed with the wrong assertion signature", async () => {
    const sealKey = await deriveUnlockKey(SIG, WALLET);
    const envelope = await sealSessionEnvelope(payload(), sealKey);
    const wrongKey = await deriveUnlockKey(OTHER_SIG, WALLET);
    await expect(openSessionEnvelope(envelope, wrongKey)).rejects.toMatchObject({
      code: "CORRUPT_ENVELOPE",
    });

    // Tampered ciphertext also fails the GCM auth tag.
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
    await expect(openSessionEnvelope(tampered, sealKey)).rejects.toMatchObject({
      code: "CORRUPT_ENVELOPE",
    });
  });

  it("round-trips seal → unlock through storage", async () => {
    const storage = memoryStorage();
    const creds = fakeCreds(SIG);
    await sealInto(storage, creds);

    const unlocked = await unlockWithBiometric({ storage, creds });
    expect(unlocked).toEqual(payload());
    // Attempt counter reset on success.
    expect(readLockMeta(storage).failed_attempts).toBe(0);
  });

  it("rejects when no envelope is stored", async () => {
    const storage = memoryStorage();
    await expect(
      unlockWithBiometric({ storage, creds: fakeCreds(SIG) }),
    ).rejects.toMatchObject({ code: "NO_ENVELOPE" });
    expect(biometricLockState({ storage })).toBe("no-envelope");
    expect(requiresBiometricGate(storage)).toBe(false);
  });

  it("expires stale envelopes and clears them", async () => {
    const storage = memoryStorage();
    const creds = fakeCreds(SIG);
    await sealInto(storage, creds);

    const stale = readBiometricEnvelope(storage)!;
    expect(isEnvelopeExpired(stale, Date.now())).toBe(false);
    expect(isEnvelopeExpired(stale, stale.sealed_at + BIOMETRIC_SESSION_TTL_MS + 1)).toBe(true);

    const old = readBiometricEnvelope(storage)!;
    old.sealed_at = Date.now() - BIOMETRIC_SESSION_TTL_MS - 1000;
    storage.setItem(BIOMETRIC_ENVELOPE_LS_KEY, JSON.stringify(old));

    await expect(
      unlockWithBiometric({ storage, creds }),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    expect(readBiometricEnvelope(storage)).toBeNull();
    expect(requiresBiometricGate(storage)).toBe(false);
  });

  it("counts failures into a cooldown lockout", async () => {
    const storage = memoryStorage();
    const creds = fakeCreds(SIG);
    await sealInto(storage, creds);

    const now = Date.now();
    for (let i = 0; i < BIOMETRIC_MAX_FAILED_ATTEMPTS - 1; i++) {
      const meta = registerFailedUnlockAttempt(now, storage);
      expect(meta.failed_attempts).toBe(i + 1);
      expect(meta.locked_until).toBeNull();
    }
    const finalMeta = registerFailedUnlockAttempt(now, storage);
    expect(finalMeta.locked_until).toBe(now + BIOMETRIC_LOCKOUT_MS);

    // Locked out: unlock refuses before even prompting.
    await expect(
      unlockWithBiometric({ storage, creds, now: now + 1000 }),
    ).rejects.toMatchObject({ code: "LOCKED_OUT" });

    // After the cooldown the flow resumes; success clears the counter.
    clearBiometricLockMeta(storage);
    const unlocked = await unlockWithBiometric({
      storage,
      creds,
      now: now + BIOMETRIC_LOCKOUT_MS + 1,
    });
    expect(unlocked.address).toBe(WALLET);
    expect(readLockMeta(storage).failed_attempts).toBe(0);
  });

  it("does not consume attempts on user cancel", async () => {
    const storage = memoryStorage();
    const creds = fakeCreds(SIG, "NotAllowedError");
    await expect(
      unlockWithBiometric({ storage, creds }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(readLockMeta(storage).failed_attempts).toBe(0);
  });

  it("reports missing WebAuthn as unsupported", async () => {
    const storage = memoryStorage();
    await sealInto(storage, fakeCreds(SIG));
    // Node has no navigator.credentials → default creds are null.
    await expect(
      unlockWithBiometric({ storage, creds: null }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(readLockMeta(storage).failed_attempts).toBe(0);
    expect(await isPlatformAuthenticatorAvailable()).toBe(false);
  });

  it("clears corrupt envelope markers instead of throwing", () => {
    const storage = memoryStorage();
    storage.setItem(BIOMETRIC_ENVELOPE_LS_KEY, "{not json");
    expect(readBiometricEnvelope(storage)).toBeNull();
    expect(storage.data[BIOMETRIC_ENVELOPE_LS_KEY]).toBeUndefined();

    storage.setItem(BIOMETRIC_ENVELOPE_LS_KEY, JSON.stringify({ v: 2 }));
    expect(readBiometricEnvelope(storage)).toBeNull();
    expect(storage.data[BIOMETRIC_ENVELOPE_LS_KEY]).toBeUndefined();
    expect(storage.data[BIOMETRIC_META_LS_KEY]).toBeUndefined();
  });

  it("runs the lock-state machine", async () => {
    const storage = memoryStorage();
    expect(biometricLockState({ storage })).toBe("no-envelope");

    await sealInto(storage, fakeCreds(SIG));
    expect(biometricLockState({ storage })).toBe("locked");
    expect(biometricLockState({ storage, sessionUnlocked: true })).toBe("unlocked");
    expect(requiresBiometricGate(storage)).toBe(true);

    const now = Date.now();
    registerFailedUnlockAttempt(now, storage);
    for (let i = 1; i < BIOMETRIC_MAX_FAILED_ATTEMPTS; i++) registerFailedUnlockAttempt(now, storage);
    expect(biometricLockState({ storage, now: now + 1 })).toBe("locked-out");
    expect(biometricLockState({ storage, now: now + BIOMETRIC_LOCKOUT_MS + 1 })).toBe("locked");

    clearBiometricSession(storage);
    expect(biometricLockState({ storage })).toBe("no-envelope");
    expect(requiresBiometricGate(storage)).toBe(false);
  });

  it("detects a platform authenticator through the WebAuthn capability probe", async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    };
    expect(await isPlatformAuthenticatorAvailable()).toBe(true);

    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => {
        throw new Error("probe failed");
      },
    };
    expect(await isPlatformAuthenticatorAvailable()).toBe(false);
  });

  it("produces localized lock-screen copy", () => {
    const en = biometricCopy("en");
    const es = biometricCopy("es");
    expect(en.title).not.toBe(es.title);
    expect(en.unlock).toMatch(/biometric/i);
    expect(es.unlock).toMatch(/biometr/i);
    expect(en.lockedOut).toMatch(/attempt/i);
    expect(es.skip).toMatch(/wallet/i);
  });
});
