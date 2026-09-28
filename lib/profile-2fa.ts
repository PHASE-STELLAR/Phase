/**
 * Two-factor confirmation for high-value profile changes — phase-104
 *
 * `POST /api/profile` accepts a wallet address as a plain string and applies
 * display-name/social changes immediately — there is no proof of wallet
 * ownership, so a spoofed wallet param (or a compromised session) can
 * silently take over another wallet's public identity ("account takeover
 * edits go unchallenged"). This module adds the two-step confirmation the
 * issue asks for: the client first requests a short-lived confirmation code
 * bound to the wallet and the exact set of high-value fields being changed,
 * then resubmits the change together with that code before it is applied.
 * Codes expire and are single-use.
 *
 * Wallet-signature verification is a separate concern and out of scope here
 * — this module adds the confirmation step, not a full auth overhaul.
 *
 * Feature flag: phase-104 (NEXT_PUBLIC_FEATURE_PHASE_104 / FEATURE_PHASE_104)
 * Rollback: disable flag → POST /api/profile reverts to applying changes
 *           immediately, no confirmation required. No data migration.
 */
import { createHash, randomInt } from "node:crypto"
import { isFeatureEnabled } from "@/lib/feature-flags"

const CODE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CODE_LENGTH = 6

/** Profile fields considered high-value enough to require confirmation. */
export const HIGH_VALUE_PROFILE_FIELDS = ["display_name", "twitter", "discord", "telegram"] as const

type PendingConfirmation = {
  code: string
  payloadHash: string
  expiresAt: number
}

const pending = new Map<string, PendingConfirmation>()

export function isProfile2faEnabled(): boolean {
  return isFeatureEnabled("phase-104")
}

export function touchesHighValueField(body: Record<string, unknown>): boolean {
  return HIGH_VALUE_PROFILE_FIELDS.some((field) => body[field] !== undefined)
}

/** Canonical, order-independent payload used to bind a code to an exact change. */
function canonicalPayload(wallet: string, body: Record<string, unknown>): string {
  const subset: Record<string, unknown> = { wallet }
  for (const field of HIGH_VALUE_PROFILE_FIELDS) {
    if (body[field] !== undefined) subset[field] = body[field]
  }
  return createHash("sha256").update(JSON.stringify(subset)).digest("hex")
}

function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0")
}

/** Issues a new confirmation code for a wallet + exact change payload. */
export function requestProfileChangeConfirmation(
  wallet: string,
  body: Record<string, unknown>,
): { code: string; expiresAt: number } {
  const code = generateCode()
  const expiresAt = Date.now() + CODE_TTL_MS
  pending.set(wallet, { code, payloadHash: canonicalPayload(wallet, body), expiresAt })
  return { code, expiresAt }
}

export type ConfirmationCheckResult =
  | { ok: true }
  | { ok: false; reason: "MISSING_CODE" | "NO_PENDING_REQUEST" | "EXPIRED" | "CODE_MISMATCH" | "PAYLOAD_CHANGED" }

/**
 * Verifies a submitted code matches a still-valid, unexpired pending request
 * for this exact wallet + payload. Single-use: consumes the code on success
 * (and on expiry, to avoid stale entries lingering).
 */
export function verifyProfileChangeConfirmation(
  wallet: string,
  body: Record<string, unknown>,
  submittedCode: string | undefined,
): ConfirmationCheckResult {
  if (!submittedCode) return { ok: false, reason: "MISSING_CODE" }
  const entry = pending.get(wallet)
  if (!entry) return { ok: false, reason: "NO_PENDING_REQUEST" }
  if (Date.now() > entry.expiresAt) {
    pending.delete(wallet)
    return { ok: false, reason: "EXPIRED" }
  }
  if (entry.payloadHash !== canonicalPayload(wallet, body)) return { ok: false, reason: "PAYLOAD_CHANGED" }
  if (entry.code !== submittedCode) return { ok: false, reason: "CODE_MISMATCH" }
  pending.delete(wallet)
  return { ok: true }
}

export function clearPendingConfirmations(): void {
  pending.clear()
}
