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

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { assessWalletSybilRisk, isSybilResistanceEnabled } from "@/lib/sybil-resistance"

const FLAG: "phase-132" = "phase-132"

export function isReferralQuestEnabled(): boolean {
  return isFeatureEnabled(FLAG)
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
}

type ReferralStore = {
  /** wallet → referral code */
  codesByWallet: Record<string, ReferralCode>
  /** code → referral record */
  recordsByCode: Record<ReferralCode, ReferralRecord>
  /** referred wallet → referral code used (one-time mapping) */
  referredByWallet: Record<string, ReferralCode>
}

function referralStorePath(): string {
  const fromEnv = process.env.PHASE_SERVER_DATA_DIR?.trim()
  const root = fromEnv
    ? fromEnv
    : process.env.VERCEL
      ? path.join(require("node:os").tmpdir(), "phase-server-data")
      : path.join(process.cwd(), ".data")
  return path.join(root, "referral-quest.json")
}

async function readStore(): Promise<ReferralStore> {
  try {
    const raw = await readFile(referralStorePath(), "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed as ReferralStore
    return { codesByWallet: {}, recordsByCode: {}, referredByWallet: {} }
  } catch {
    return { codesByWallet: {}, recordsByCode: {}, referredByWallet: {} }
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

async function writeStore(data: ReferralStore): Promise<void> {
  const fp = referralStorePath()
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(data, null, 2), "utf8")
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
  if (!isReferralQuestEnabled()) return ""
  const store = await readStore()
  if (hasOwn(store.codesByWallet, wallet) && store.codesByWallet[wallet]) return store.codesByWallet[wallet]

  // Generate a unique code
  let code = generateCode()
  while (hasOwn(store.recordsByCode, code)) {
    code = generateCode()
  }

  store.codesByWallet[wallet] = code
  store.recordsByCode[code] = { referrer: wallet, referred: [], referredAt: [] }
  await writeStore(store)
  return code
}

/**
 * Validate a referral code: exists, is not the user's own code.
 */
export async function validateReferralCode(
  code: string,
  claimingWallet: string,
): Promise<{ valid: boolean; referrer?: string; error?: string }> {
  if (!isReferralQuestEnabled()) return { valid: false, error: "Feature disabled" }
  const store = await readStore()
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
  if (!isReferralQuestEnabled()) return { bonus: null }
  if (!referralCode || !referredWallet) return { bonus: null }

  const store = await readStore()
  const record = hasOwn(store.recordsByCode, referralCode) ? store.recordsByCode[referralCode] : undefined
  if (!record) return { bonus: null, error: "Invalid referral code." }

  // Self-referral check
  if (record.referrer === referredWallet) {
    return { bonus: null, error: "Cannot refer yourself." }
  }

  // The flag-gated assessment uses Horizon account creation time (not the
  // first time this process saw the wallet), so waiting seven days cannot
  // turn a newly-created farming wallet into an established one.
  if (isSybilResistanceEnabled()) {
    const risk = await assessWalletSybilRisk(referredWallet)
    if (risk?.suspect) return { bonus: null, error: "Wallet failed referral trust checks." }
  }

  // Already referred check
  if (hasOwn(store.referredByWallet, referredWallet)) {
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

  // Record the referral
  record.referred.push(referredWallet)
  record.referredAt.push(Date.now())
  store.referredByWallet[referredWallet] = referralCode

  await writeStore(store)
  return { bonus: REFERRAL_BONUS_STROOPS }
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
  const store = await readStore()
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
  const store = await readStore()
  const code = hasOwn(store.referredByWallet, wallet) ? store.referredByWallet[wallet] : undefined
  if (!code) return null
  const record = store.recordsByCode[code]
  if (!record) return null
  return { referrer: record.referrer, referralCode: code }
}
