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
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getDb } from "@/lib/sqlite-db"
import { resolveSessionWallet } from "@/lib/sep10-auth"

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

// ── phase-244 (#695): SEP-10 session-bound 2FA, lockout, auditable recovery, EN/ES copy ──

export const PROFILE_2FA_SENSITIVE_FIELDS = [...HIGH_VALUE_PROFILE_FIELDS, "imageUrl", "avatar_token_id"] as const

export const PROFILE_2FA_COPY = {
  en: {
    sessionRequired: "Active SEP-10 wallet session is required for 2FA profile changes.",
    sessionMismatch: "SEP-10 session wallet does not match the target profile wallet.",
    codeRequired: "Two-factor confirmation code is required for wallet-linked changes.",
    noPendingRequest: "No active 2FA challenge found. Request a new confirmation code first.",
    expired: "Confirmation code expired. Request a new confirmation code.",
    payloadChanged: "Profile change payload changed after the confirmation code was issued.",
    invalidCode: "Invalid confirmation code.",
    lockedOut: "Too many failed 2FA attempts. Try again after the cooldown period.",
    recoveryInitiated: "2FA recovery initiated. Use the recovery code to unlock your account.",
    recoveryCompleted: "2FA recovery completed and lockout cleared.",
    recoveryInvalid: "Invalid or expired 2FA recovery code.",
  },
  es: {
    sessionRequired: "Se requiere una sesión SEP-10 activa para cambios de perfil con 2FA.",
    sessionMismatch: "La wallet de la sesión SEP-10 no coincide con la wallet del perfil.",
    codeRequired: "Se requiere un código de confirmación de dos factores para cambios vinculados a la wallet.",
    noPendingRequest: "No hay un desafío 2FA activo. Solicita un nuevo código de confirmación primero.",
    expired: "El código de confirmación expiró. Solicita uno nuevo.",
    payloadChanged: "Los datos del cambio de perfil cambiaron después de emitir el código.",
    invalidCode: "Código de confirmación inválido.",
    lockedOut: "Demasiados intentos fallidos de 2FA. Intenta de nuevo después del enfriamiento.",
    recoveryInitiated: "Recuperación de 2FA iniciada. Usa el código de recuperación para desbloquear tu cuenta.",
    recoveryCompleted: "Recuperación de 2FA completada y bloqueo eliminado.",
    recoveryInvalid: "Código de recuperación 2FA inválido o expirado.",
  },
} as const

export type Profile2faLocale = keyof typeof PROFILE_2FA_COPY

export function pickProfile2faCopy(lang?: string | null) {
  const normalized = (lang ?? "").trim().toLowerCase().slice(0, 2)
  return normalized === "es" ? PROFILE_2FA_COPY.es : PROFILE_2FA_COPY.en
}

export function isProfile2faV2Enabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-244", wallet ? { wallet, runtimeOnly: true } : { runtimeOnly: true })
}

function get2faMaxAttempts(): number {
  const raw = (process.env.PROFILE_2FA_MAX_ATTEMPTS ?? "5").trim()
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(20, parsed) : 5
}

function get2faLockoutMs(): number {
  const raw = (process.env.PROFILE_2FA_LOCKOUT_MS ?? String(15 * 60 * 1000)).trim()
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 15 * 60 * 1000
}

function hashWallet2fa(wallet: string): string {
  const secret = process.env.PHASE_2FA_HASH_KEY?.trim() || process.env.PHASE_KYC_HASH_KEY?.trim() || "phase-profile-2fa-key"
  return createHmac("sha256", secret).update(`2fa-wallet:${wallet.trim()}`).digest("hex")
}

function hashSecretWithSalt(salt: string, value: string): string {
  const secret = process.env.PHASE_2FA_HASH_KEY?.trim() || process.env.PHASE_KYC_HASH_KEY?.trim() || "phase-profile-2fa-key"
  return createHmac("sha256", secret).update(`${salt}:${value}`).digest("hex")
}

export function extractBearerSessionHash(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim() ?? ""
  if (!header.toLowerCase().startsWith("bearer ")) return null
  const token = header.slice("bearer ".length).trim()
  if (!token) return null
  return createHash("sha256").update(token).digest("base64url")
}

export async function requireSep10SessionForWallet(
  request: Request,
  targetWallet: string,
  lang?: string | null,
): Promise<{ ok: true; sessionHash: string } | { ok: false; status: 401 | 403; reason: "SESSION_REQUIRED" | "SESSION_MISMATCH"; error: string }> {
  const t = pickProfile2faCopy(lang)
  const sessionHash = extractBearerSessionHash(request)
  const sessionWallet = await resolveSessionWallet(request)
  if (!sessionHash || !sessionWallet) {
    return { ok: false, status: 401, reason: "SESSION_REQUIRED", error: t.sessionRequired }
  }
  if (sessionWallet !== targetWallet) {
    return { ok: false, status: 403, reason: "SESSION_MISMATCH", error: t.sessionMismatch }
  }
  return { ok: true, sessionHash }
}

function canonicalSensitivePayload(wallet: string, body: Record<string, unknown>): string {
  const subset: Record<string, unknown> = { wallet }
  for (const field of PROFILE_2FA_SENSITIVE_FIELDS) {
    if (body[field] !== undefined) subset[field] = body[field]
  }
  return createHash("sha256").update(JSON.stringify(subset)).digest("hex")
}

function append2faAudit(walletHash: string, eventType: string, reasonCode: string, actor: string): void {
  getDb()
    .prepare("INSERT INTO profile_2fa_audit (id, wallet_hash, event_type, reason_code, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), walletHash, eventType, reasonCode, actor, Date.now())
}

export function listProfile2faAudit(wallet: string, limit = 50): Array<{
  id: string
  eventType: string
  reasonCode: string
  actor: string
  createdAt: number
}> {
  const bounded = Math.max(1, Math.min(100, limit))
  const rows = getDb()
    .prepare("SELECT id, event_type, reason_code, actor, created_at FROM profile_2fa_audit WHERE wallet_hash = ? ORDER BY created_at DESC LIMIT ?")
    .all(hashWallet2fa(wallet), bounded) as Array<{
    id: string
    event_type: string
    reason_code: string
    actor: string
    created_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    reasonCode: r.reason_code,
    actor: r.actor,
    createdAt: r.created_at,
  }))
}

export type Session2faIssueResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; status: 429; reason: "LOCKED_OUT"; retryAfterSeconds: number; error: string }

export function issueSessionBound2faChallenge(
  wallet: string,
  sessionHash: string,
  body: Record<string, unknown>,
  lang?: string | null,
): Session2faIssueResult {
  const db = getDb()
  const now = Date.now()
  const walletHash = hashWallet2fa(wallet)
  const t = pickProfile2faCopy(lang)

  const lock = db
    .prepare("SELECT failed_attempts, locked_until FROM profile_2fa_lockouts WHERE wallet_hash = ?")
    .get(walletHash) as { failed_attempts: number; locked_until: number } | undefined

  if (lock && lock.locked_until > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((lock.locked_until - now) / 1000))
    append2faAudit(walletHash, "challenge_blocked", "locked_out", "user")
    return { ok: false, status: 429, reason: "LOCKED_OUT", retryAfterSeconds, error: t.lockedOut }
  }

  const code = generateCode()
  const salt = randomBytes(16).toString("hex")
  const codeHash = hashSecretWithSalt(salt, code)
  const payloadHash = canonicalSensitivePayload(wallet, body)
  const expiresAt = now + CODE_TTL_MS

  db.prepare(`
    INSERT INTO profile_2fa_challenges (wallet_hash, session_hash, payload_hash, code_hash, salt, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_hash) DO UPDATE SET
      session_hash = excluded.session_hash,
      payload_hash = excluded.payload_hash,
      code_hash = excluded.code_hash,
      salt = excluded.salt,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `).run(walletHash, sessionHash, payloadHash, codeHash, salt, expiresAt, now)

  append2faAudit(walletHash, "challenge_issued", "ok", "user")
  return { ok: true, code, expiresAt }
}

export type Session2faVerifyResult =
  | { ok: true }
  | {
      ok: false
      status: 403 | 428 | 429
      reason: "MISSING_CODE" | "NO_PENDING_REQUEST" | "EXPIRED" | "PAYLOAD_CHANGED" | "SESSION_MISMATCH" | "CODE_MISMATCH" | "LOCKED_OUT"
      retryAfterSeconds?: number
      error: string
    }

export function verifySessionBound2faChallenge(
  wallet: string,
  sessionHash: string,
  body: Record<string, unknown>,
  submittedCode: string | undefined,
  lang?: string | null,
): Session2faVerifyResult {
  const db = getDb()
  const now = Date.now()
  const walletHash = hashWallet2fa(wallet)
  const t = pickProfile2faCopy(lang)

  const lock = db
    .prepare("SELECT failed_attempts, locked_until FROM profile_2fa_lockouts WHERE wallet_hash = ?")
    .get(walletHash) as { failed_attempts: number; locked_until: number } | undefined

  if (lock && lock.locked_until > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((lock.locked_until - now) / 1000))
    append2faAudit(walletHash, "verify_blocked", "locked_out", "user")
    return { ok: false, status: 429, reason: "LOCKED_OUT", retryAfterSeconds, error: t.lockedOut }
  }

  if (!submittedCode?.trim()) {
    return { ok: false, status: 428, reason: "MISSING_CODE", error: t.codeRequired }
  }

  const challenge = db
    .prepare("SELECT session_hash, payload_hash, code_hash, salt, expires_at FROM profile_2fa_challenges WHERE wallet_hash = ?")
    .get(walletHash) as
    | { session_hash: string; payload_hash: string; code_hash: string; salt: string; expires_at: number }
    | undefined

  if (!challenge) {
    return { ok: false, status: 428, reason: "NO_PENDING_REQUEST", error: t.noPendingRequest }
  }
  if (now > challenge.expires_at) {
    db.prepare("DELETE FROM profile_2fa_challenges WHERE wallet_hash = ?").run(walletHash)
    append2faAudit(walletHash, "verify_failed", "expired", "user")
    return { ok: false, status: 428, reason: "EXPIRED", error: t.expired }
  }
  if (challenge.session_hash !== sessionHash) {
    append2faAudit(walletHash, "verify_failed", "session_mismatch", "user")
    return { ok: false, status: 403, reason: "SESSION_MISMATCH", error: t.sessionMismatch }
  }
  if (challenge.payload_hash !== canonicalSensitivePayload(wallet, body)) {
    append2faAudit(walletHash, "verify_failed", "payload_changed", "user")
    return { ok: false, status: 428, reason: "PAYLOAD_CHANGED", error: t.payloadChanged }
  }

  const candidateHash = hashSecretWithSalt(challenge.salt, submittedCode.trim())
  const a = Buffer.from(candidateHash, "hex")
  const b = Buffer.from(challenge.code_hash, "hex")
  const matched = a.length === b.length && timingSafeEqual(a, b)

  if (!matched) {
    const maxAttempts = get2faMaxAttempts()
    const nextAttempts = (lock?.failed_attempts ?? 0) + 1
    const lockedUntil = nextAttempts >= maxAttempts ? now + get2faLockoutMs() : 0
    db.prepare(`
      INSERT INTO profile_2fa_lockouts (wallet_hash, failed_attempts, locked_until, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(wallet_hash) DO UPDATE SET
        failed_attempts = excluded.failed_attempts,
        locked_until = excluded.locked_until,
        updated_at = excluded.updated_at
    `).run(walletHash, nextAttempts, lockedUntil, now)

    if (lockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil - now) / 1000))
      append2faAudit(walletHash, "lockout_triggered", "max_attempts_exceeded", "system")
      return { ok: false, status: 429, reason: "LOCKED_OUT", retryAfterSeconds, error: t.lockedOut }
    }

    append2faAudit(walletHash, "verify_failed", "code_mismatch", "user")
    return { ok: false, status: 403, reason: "CODE_MISMATCH", error: t.invalidCode }
  }

  // Success: consume challenge and reset failed attempts.
  db.prepare("DELETE FROM profile_2fa_challenges WHERE wallet_hash = ?").run(walletHash)
  db.prepare(`
    INSERT INTO profile_2fa_lockouts (wallet_hash, failed_attempts, locked_until, updated_at)
    VALUES (?, 0, 0, ?)
    ON CONFLICT(wallet_hash) DO UPDATE SET
      failed_attempts = 0,
      locked_until = 0,
      updated_at = excluded.updated_at
  `).run(walletHash, now)
  append2faAudit(walletHash, "verify_succeeded", "ok", "user")
  return { ok: true }
}

export function initiateProfile2faRecovery(
  wallet: string,
  actor: "user" | "admin" = "user",
): { recoveryCode: string; expiresAt: number } {
  const db = getDb()
  const now = Date.now()
  const walletHash = hashWallet2fa(wallet)
  const recoveryCode = randomBytes(16).toString("hex")
  const salt = randomBytes(16).toString("hex")
  const recoveryHash = hashSecretWithSalt(salt, recoveryCode)
  const expiresAt = now + 15 * 60 * 1000

  db.prepare(`
    INSERT INTO profile_2fa_lockouts (
      wallet_hash, failed_attempts, locked_until, recovery_hash, recovery_salt, recovery_expires_at, updated_at
    ) VALUES (?, 0, 0, ?, ?, ?, ?)
    ON CONFLICT(wallet_hash) DO UPDATE SET
      recovery_hash = excluded.recovery_hash,
      recovery_salt = excluded.recovery_salt,
      recovery_expires_at = excluded.recovery_expires_at,
      updated_at = excluded.updated_at
  `).run(walletHash, recoveryHash, salt, expiresAt, now)

  append2faAudit(walletHash, "recovery_initiated", "ok", actor)
  return { recoveryCode, expiresAt }
}

export function completeProfile2faRecovery(
  wallet: string,
  recoveryCode: string,
  lang?: string | null,
): { ok: true; message: string } | { ok: false; status: 403; error: string } {
  const db = getDb()
  const now = Date.now()
  const walletHash = hashWallet2fa(wallet)
  const t = pickProfile2faCopy(lang)

  const row = db
    .prepare("SELECT recovery_hash, recovery_salt, recovery_expires_at FROM profile_2fa_lockouts WHERE wallet_hash = ?")
    .get(walletHash) as
    | { recovery_hash: string | null; recovery_salt: string | null; recovery_expires_at: number }
    | undefined

  if (!row || !row.recovery_hash || !row.recovery_salt || row.recovery_expires_at <= now) {
    append2faAudit(walletHash, "recovery_failed", "expired_or_missing", "user")
    return { ok: false, status: 403, error: t.recoveryInvalid }
  }

  const candidate = hashSecretWithSalt(row.recovery_salt, recoveryCode.trim())
  const a = Buffer.from(candidate, "hex")
  const b = Buffer.from(row.recovery_hash, "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    append2faAudit(walletHash, "recovery_failed", "invalid_recovery_code", "user")
    return { ok: false, status: 403, error: t.recoveryInvalid }
  }

  db.prepare(`
    UPDATE profile_2fa_lockouts
    SET failed_attempts = 0, locked_until = 0, recovery_hash = NULL, recovery_salt = NULL, recovery_expires_at = 0, updated_at = ?
    WHERE wallet_hash = ?
  `).run(now, walletHash)
  db.prepare("DELETE FROM profile_2fa_challenges WHERE wallet_hash = ?").run(walletHash)
  append2faAudit(walletHash, "recovery_completed", "ok", "user")
  return { ok: true, message: t.recoveryCompleted }
}
