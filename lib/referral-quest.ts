/**
 * phase-132: Referral-quest attribution with anti-gaming caps.
 *
 * Each wallet may generate a unique referral code. When a new wallet
 * completes its genesis claim using a referral code, the referrer earns
 * a bonus reward. Anti-gaming measures:
 *
 *   1. One referral code per wallet (immutable once generated).
 *   2. Referrer cannot refer themselves.
 *   3. Maximum 50 successful referrals per wallet (cap).
 *   4. Minimum 24h between referral claims from the same IP fingerprint
 *      (rate-limit to prevent rapid-fire abuse).
 *   5. Referred wallet must be unique — no double-counting.
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_132 / FEATURE_PHASE_132
 * Rollback: unset the flag. Referral bonus logic is skipped entirely.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { assessWalletSybilRisk, isSybilResistanceEnabled } from "@/lib/sybil-resistance"
import { readJsonFile, updateStore } from "@/lib/json-store"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { incSecurityCounter } from "@/lib/security-counters"
import { getDb } from "@/lib/sqlite-db"
import { isAnalyticsWarehouseEnabled, recordWarehouseEvent } from "@/lib/analytics-warehouse"

const FLAG: "phase-132" = "phase-132"

export function isReferralQuestEnabled(wallet?: string): boolean {
  return isFeatureEnabled(FLAG, wallet ? { wallet } : undefined)
}

const REFERRAL_BONUS_STROOPS = "15000000" // 15 PHASELQ bonus
const MAX_REFERRALS_PER_WALLET = 50
const REFERRAL_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24h between claims from same origin

type ReferralCode = string // 8-char alphanumeric

type ReferralRecord = {
  /** The wallet that created this code. */
  referrer: string
  /** Wallets referred by this code (addresses). */
  referred: string[]
  /** Timestamps of each successful referral claim. */
  referredAt: number[]
  /** Rate-limit by origin fingerprint. */
  rateLimits?: Record<string, number>
  /** phase-261: whether this code is single-use. */
  oneUse?: boolean
  /** phase-261: wallet that redeemed this one-use code. */
  consumedBy?: string
  /** phase-261: timestamp when the one-use code was redeemed. */
  consumedAt?: number
}

export type ReferralStore = {
  /** Monotonic optimistic-concurrency version (phase-261). */
  version?: number
  /** wallet → referral code */
  codesByWallet: Record<string, ReferralCode>
  /** code → referral record */
  recordsByCode: Record<ReferralCode, ReferralRecord>
  /** referred wallet → referral code used (one-time mapping) */
  referredByWallet: Record<string, ReferralCode>
}

const DEFAULT_STORE: ReferralStore = {
  version: 0,
  codesByWallet: {},
  recordsByCode: {},
  referredByWallet: {},
}

export async function readReferralStore(): Promise<ReferralStore> {
  return readJsonFile<ReferralStore>(serverDataJsonPath("referralQuests"), DEFAULT_STORE)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function generateCode(): ReferralCode {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no ambiguous I/1/O/0
  let code = ""
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

/**
 * Get or create a referral code for a wallet. Idempotent —
 * returns the existing code if one was already generated.
 */
export async function getOrCreateReferralCode(wallet: string): Promise<ReferralCode> {
  if (!isReferralQuestEnabled(wallet)) return ""
  return updateStore<ReferralStore, ReferralCode>("referralQuests", (store) => {
    if (hasOwn(store.codesByWallet, wallet) && store.codesByWallet[wallet]) {
      return store.codesByWallet[wallet]
    }

    // Generate a unique code
    let code = generateCode()
    while (hasOwn(store.recordsByCode, code)) {
      code = generateCode()
    }

    store.codesByWallet[wallet] = code
    store.recordsByCode[code] = { referrer: wallet, referred: [], referredAt: [] }
    return code
  })
}

/**
 * Validate a referral code: exists, is not the user's own code.
 */
export async function validateReferralCode(
  code: string,
  claimingWallet: string,
): Promise<{ valid: boolean; referrer?: string; error?: string }> {
  if (!isReferralQuestEnabled()) return { valid: false, error: "Feature disabled" }
  const store = await readReferralStore()
  const record = hasOwn(store.recordsByCode, code) ? store.recordsByCode[code] : undefined
  if (!record) return { valid: false, error: "Invalid referral code." }
  if (record.referrer === claimingWallet) {
    return { valid: false, error: "You cannot refer yourself." }
  }
  return { valid: true, referrer: record.referrer }
}

/**
 * Record a successful referral after genesis claim.
 * Returns the bonus amount (stroops) or null if the referral was not applied.
 */
export async function recordReferral(
  referralCode: string,
  referredWallet: string,
  originFingerprint?: string,
): Promise<{ bonus: string | null; error?: string }> {
  const normWallet = (referredWallet ?? "").trim().toUpperCase()
  const normCode = (referralCode ?? "").trim().toUpperCase()
  if (!isReferralQuestEnabled(normWallet)) return { bonus: null }
  if (!normCode || !normWallet) return { bonus: null }

  // Sybil check before taking lock
  if (isSybilResistanceEnabled()) {
    const risk = await assessWalletSybilRisk(normWallet)
    if (risk?.suspect) return { bonus: null, error: "Wallet failed referral trust checks." }
  }

  // SQLite-level uniqueness check to prevent duplicate attribution under concurrent load
  try {
    const db = getDb()
    db.exec(`
      CREATE TABLE IF NOT EXISTS referral_attributions (
        referred_wallet TEXT PRIMARY KEY,
        referrer_wallet TEXT NOT NULL,
        referral_code   TEXT NOT NULL,
        bonus_stroops   TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      )
    `)
    const existing = db
      .prepare("SELECT referrer_wallet FROM referral_attributions WHERE referred_wallet = ?")
      .get(normWallet)
    if (existing) {
      return { bonus: null, error: "Wallet already referred." }
    }
  } catch {}

  return updateStore<ReferralStore, { bonus: string | null; error?: string }>(
    "referralQuests",
    (store) => {
      const record = hasOwn(store.recordsByCode, normCode) ? store.recordsByCode[normCode] : undefined
      if (!record) return { bonus: null, error: "Invalid referral code." }

      const normReferrer = record.referrer.trim().toUpperCase()

      // Self-referral check
      if (normReferrer === normWallet) {
        return { bonus: null, error: "Cannot refer yourself." }
      }

      // Already referred check in store
      if (hasOwn(store.referredByWallet, normWallet) || record.referred.map((w) => w.toUpperCase()).includes(normWallet)) {
        return { bonus: null, error: "Wallet already referred." }
      }

      // Referrer cap check
      if (record.referred.length >= MAX_REFERRALS_PER_WALLET) {
        return { bonus: null, error: "Referrer has reached the maximum referral limit." }
      }

      // Rate limit by origin fingerprint
      if (originFingerprint) {
        const now = Date.now()
        record.rateLimits = record.rateLimits ?? {}
        const lastClaim = hasOwn(record.rateLimits, originFingerprint)
          ? record.rateLimits[originFingerprint]
          : 0
        if (now - lastClaim < REFERRAL_COOLDOWN_MS) {
          return { bonus: null, error: "Referral rate limit. Try again later." }
        }
        Object.defineProperty(record.rateLimits, originFingerprint, {
          value: now,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }

      const now = Date.now()

      // Atomic SQLite record
      try {
        const db = getDb()
        db.prepare(
          `INSERT OR IGNORE INTO referral_attributions
            (referred_wallet, referrer_wallet, referral_code, bonus_stroops, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(normWallet, normReferrer, normCode, REFERRAL_BONUS_STROOPS, now)
      } catch {}

      // Record the referral in sidecar store
      record.referred.push(normWallet)
      record.referredAt.push(now)
      store.referredByWallet[normWallet] = normCode
      store.version = (store.version ?? 0) + 1

      if (isAnalyticsWarehouseEnabled(normWallet)) {
        void recordWarehouseEvent({
          surface: "referral",
          stage: "referral_confirmed",
          wallet: normWallet,
          metadata: {
            referrer: normReferrer,
            referralCode: normCode,
            bonus: REFERRAL_BONUS_STROOPS,
          },
        }).catch(() => {})
      }

      return { bonus: REFERRAL_BONUS_STROOPS }
    },
  )
}

/**
 * Get referral stats for a wallet (referrer view).
 */
export async function getReferralStats(wallet: string): Promise<{
  code: string | null
  totalReferred: number
  remainingSlots: number
}> {
  if (!isReferralQuestEnabled()) return { code: null, totalReferred: 0, remainingSlots: 0 }
  const store = await readReferralStore()
  const code = hasOwn(store.codesByWallet, wallet) ? store.codesByWallet[wallet] : null
  if (!code) return { code: null, totalReferred: 0, remainingSlots: MAX_REFERRALS_PER_WALLET }
  const record = store.recordsByCode[code]
  const total = record?.referred.length ?? 0
  return {
    code,
    totalReferred: total,
    remainingSlots: Math.max(0, MAX_REFERRALS_PER_WALLET - total),
  }
}

/**
 * Check if a wallet was referred (for metadata attribution).
 */
export async function getReferralAttribution(
  wallet: string,
): Promise<{ referrer: string; referralCode: string } | null> {
  if (!isReferralQuestEnabled()) return null
  const store = await readReferralStore()
  const code = hasOwn(store.referredByWallet, wallet) ? store.referredByWallet[wallet] : undefined
  if (!code) return null
  const record = store.recordsByCode[code]
  if (!record) return null
  return { referrer: record.referrer, referralCode: code }
}

// ─── phase-261: SEP-10 signed attribution, one-use codes & atomic version guard ─

export function isSignedReferralQuestEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-261", wallet ? { wallet } : undefined)
}

export function signedReferralQuestRollbackNote(): string {
  return "Rollback phase-261: unset NEXT_PUBLIC_FEATURE_PHASE_261 / FEATURE_PHASE_261. Referral route 404; rows inert."
}

function countReferrerTotalCredits(store: ReferralStore, referrer: string): number {
  let total = 0
  for (const key of Object.keys(store.recordsByCode)) {
    const rec = store.recordsByCode[key]
    if (rec && rec.referrer === referrer) {
      total += rec.referred.length
    }
  }
  return total
}

export type IssueOneUseCodeResult =
  | { ok: true; code: string; version: number }
  | { ok: false; status: number; code: "FLAG_DISABLED" | "REFERRER_CAP_REACHED" | "VERSION_CONFLICT"; error: string }

/**
 * Issue a one-use referral code bound to the authenticated SEP-10 session wallet.
 */
export async function issueOneUseReferralCode(
  sessionWallet: string,
  opts: { expectedVersion?: number } = {},
): Promise<IssueOneUseCodeResult> {
  if (!isSignedReferralQuestEnabled(sessionWallet)) {
    return { ok: false, status: 404, code: "FLAG_DISABLED", error: "Referral quest disabled" }
  }

  return updateStore<ReferralStore, IssueOneUseCodeResult>("referralQuests", (store) => {
    const currentVersion = store.version ?? 0
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== currentVersion) {
      return {
        ok: false,
        status: 409,
        code: "VERSION_CONFLICT",
        error: "Concurrent modification detected",
      }
    }

    if (countReferrerTotalCredits(store, sessionWallet) >= MAX_REFERRALS_PER_WALLET) {
      return {
        ok: false,
        status: 429,
        code: "REFERRER_CAP_REACHED",
        error: "Referrer has reached the maximum referral limit.",
      }
    }

    let code = generateCode()
    while (hasOwn(store.recordsByCode, code)) {
      code = generateCode()
    }

    store.recordsByCode[code] = {
      referrer: sessionWallet,
      referred: [],
      referredAt: [],
      oneUse: true,
    }
    if (!hasOwn(store.codesByWallet, sessionWallet) || !store.codesByWallet[sessionWallet]) {
      store.codesByWallet[sessionWallet] = code
    }
    store.version = currentVersion + 1
    incSecurityCounter("referral_quest_code_issued")
    return { ok: true, code, version: store.version }
  })
}

export type SignedReferralEnrollErrorCode =
  | "FLAG_DISABLED"
  | "INVALID_CODE"
  | "SELF_REFERRAL"
  | "ALREADY_ENROLLED"
  | "CODE_ALREADY_USED"
  | "REFERRER_CAP_REACHED"
  | "VERSION_CONFLICT"
  | "SYBIL_REJECTED"

export type SignedReferralEnrollResult =
  | {
      ok: true
      status: 200
      referrer: string
      referredWallet: string
      bonus: string
      version: number
    }
  | {
      ok: false
      status: 400 | 403 | 404 | 409 | 429
      code: SignedReferralEnrollErrorCode
      error: string
      currentVersion?: number
    }

/**
 * Atomically enroll `sessionWallet` (from verified SEP-10 session) using a
 * one-use referral code with optimistic version guard and closed counters.
 */
export async function enrollSignedReferral(input: {
  sessionWallet: string
  code: string
  expectedVersion?: number
  nowMs?: number
}): Promise<SignedReferralEnrollResult> {
  const { sessionWallet, code, expectedVersion } = input
  if (!isSignedReferralQuestEnabled(sessionWallet)) {
    return { ok: false, status: 404, code: "FLAG_DISABLED", error: "Referral quest disabled" }
  }

  const normalizedCode = code.trim().toUpperCase()
  if (!normalizedCode) {
    incSecurityCounter("referral_quest_enrollment", { reason: "invalid_code" })
    return { ok: false, status: 400, code: "INVALID_CODE", error: "Invalid referral code." }
  }

  if (isSybilResistanceEnabled()) {
    const risk = await assessWalletSybilRisk(sessionWallet)
    if (risk?.suspect) {
      incSecurityCounter("referral_quest_enrollment", { reason: "sybil_rejected" })
      return { ok: false, status: 403, code: "SYBIL_REJECTED", error: "Wallet failed referral trust checks." }
    }
  }

  const now = input.nowMs ?? Date.now()
  return updateStore<ReferralStore, SignedReferralEnrollResult>("referralQuests", (store) => {
    const currentVersion = store.version ?? 0
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      incSecurityCounter("referral_quest_enrollment", { reason: "version_conflict" })
      return {
        ok: false,
        status: 409,
        code: "VERSION_CONFLICT",
        error: "Concurrent modification detected",
        currentVersion,
      }
    }

    const record = hasOwn(store.recordsByCode, normalizedCode)
      ? store.recordsByCode[normalizedCode]
      : undefined
    if (!record) {
      incSecurityCounter("referral_quest_enrollment", { reason: "invalid_code" })
      return { ok: false, status: 400, code: "INVALID_CODE", error: "Invalid referral code." }
    }

    if (record.referrer === sessionWallet) {
      incSecurityCounter("referral_quest_enrollment", { reason: "self_referral" })
      return { ok: false, status: 400, code: "SELF_REFERRAL", error: "Cannot refer yourself." }
    }

    if (hasOwn(store.referredByWallet, sessionWallet)) {
      incSecurityCounter("referral_quest_enrollment", { reason: "already_enrolled" })
      return { ok: false, status: 409, code: "ALREADY_ENROLLED", error: "Wallet already enrolled." }
    }

    if (record.oneUse && record.consumedBy) {
      incSecurityCounter("referral_quest_enrollment", { reason: "code_already_used" })
      return { ok: false, status: 409, code: "CODE_ALREADY_USED", error: "Referral code already used." }
    }

    if (countReferrerTotalCredits(store, record.referrer) >= MAX_REFERRALS_PER_WALLET) {
      incSecurityCounter("referral_quest_enrollment", { reason: "referrer_cap_reached" })
      return {
        ok: false,
        status: 429,
        code: "REFERRER_CAP_REACHED",
        error: "Referrer has reached the maximum referral limit.",
      }
    }

    record.referred.push(sessionWallet)
    record.referredAt.push(now)
    if (record.oneUse) {
      record.consumedBy = sessionWallet
      record.consumedAt = now
    }
    store.referredByWallet[sessionWallet] = normalizedCode
    store.version = currentVersion + 1

    incSecurityCounter("referral_quest_enrollment", { reason: "enrolled" })
    return {
      ok: true,
      status: 200,
      referrer: record.referrer,
      referredWallet: sessionWallet,
      bonus: REFERRAL_BONUS_STROOPS,
      version: store.version,
    }
  })
}

/**
 * Get signed referral summary + store version for a SEP-10 session wallet.
 */
export async function getSignedReferralSummary(sessionWallet: string): Promise<{
  version: number
  totalReferredByMe: number
  remainingSlots: number
  enrolledWith: { referrer: string; code: string } | null
}> {
  const store = await readReferralStore()
  const totalReferredByMe = countReferrerTotalCredits(store, sessionWallet)
  const usedCode = hasOwn(store.referredByWallet, sessionWallet)
    ? store.referredByWallet[sessionWallet]
    : undefined
  const usedRecord = usedCode ? store.recordsByCode[usedCode] : undefined
  return {
    version: store.version ?? 0,
    totalReferredByMe,
    remainingSlots: Math.max(0, MAX_REFERRALS_PER_WALLET - totalReferredByMe),
    enrolledWith: usedCode && usedRecord ? { referrer: usedRecord.referrer, code: usedCode } : null,
  }
}
