export interface BiometricSessionPayload {
  address: string;
  module_id: string | null;
  created_at: number;
}

export interface BiometricSessionEnvelope {
  /** Envelope schema version. */
  v: 1;
  /** Plaintext wallet binding — prevents cross-wallet envelope replay. */
  wallet: string;
  /** base64 AES-GCM IV. */
  iv: string;
  /** base64 AES-GCM ciphertext of the JSON session payload. */
  ciphertext: string;
  sealed_at: number;
}

/** Attempt counter kept in plaintext (counts only — no PII). */
export interface BiometricLockMeta {
  failed_attempts: number;
  locked_until: number | null;
}

export type BiometricLockState =
  | "disabled"
  | "unsupported"
  | "no-envelope"
  | "locked-out"
  | "locked"
  | "unlocked";

export type BiometricErrorCode =
  | "FLAG_DISABLED"
  | "UNSUPPORTED"
  | "NOT_ALLOWED"
  | "CANCELLED"
  | "NO_ENVELOPE"
  | "CORRUPT_ENVELOPE"
  | "WALLET_MISMATCH"
  | "EXPIRED"
  | "LOCKED_OUT";
