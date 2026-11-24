import { createHash } from "node:crypto";

export const SECRET_KEY_RE = /S[A-Z2-7]{55}/g;
export const WALLET_KEY_RE = /G[A-Z2-7]{55}/g;

/**
 * Deterministically generates a masked wallet with a cryptographic fingerprint
 * suitable for external regulator oversight without revealing cleartext identity.
 * Example: GABC...WXYZ (fp: 3a9f0e1c)
 */
export function fingerprintWallet(wallet: string): string {
  if (!wallet || wallet.length < 10) return "[INVALID_WALLET]";
  const prefix = wallet.slice(0, 4);
  const suffix = wallet.slice(-4);
  const digest = createHash("sha256").update(wallet, "utf8").digest("hex").slice(0, 8);
  return `${prefix}...${suffix} (fp: ${digest})`;
}

/**
 * Strips raw Stellar secret keys from strings.
 */
export function redactSecretKeys(text: string): string {
  if (!text) return text;
  return text.replace(SECRET_KEY_RE, "[REDACTED_SECRET_KEY]");
}

/**
 * Sanitizes moderation reason text for external/regulatory viewing by stripping
 * secret keys and replacing explicit internal wallets.
 */
export function sanitizeModerationReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  let sanitized = redactSecretKeys(reason);
  sanitized = sanitized.replace(WALLET_KEY_RE, (w) => fingerprintWallet(w));
  return sanitized;
}

/**
 * Clamps numeric values to safety limits.
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}
