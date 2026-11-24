/**
 * Module #45 (Issue #69) — Sybil-resistance scoring for faucet / reward claims
 * via on-chain account-history scoring.
 *
 * AUDIT NOTE (execution flow, app/api/og/* and reward paths):
 * Bots farm rewards with freshly created wallets. The OG image routes resolve a
 * wallet with zero trust signal, and the faucet path only rate-limits per
 * wallet — trivially bypassed by minting new keypairs. There was no shared,
 * testable notion of "how established is this account on chain".
 *
 * This module is the isolated domain for that signal:
 *   - SybilScoreInputSchema — type-safe feature vector for an account
 *   - scoreWalletHistory()  — pure 0..100 trust score + band + reason list
 *   - isSybilSuspect()      — threshold predicate
 *   - fetchAccountHistoryFeatures() — best-effort Horizon reader (network)
 *   - assessWalletSybilRisk()       — flag-gated end-to-end assessment
 *
 * Flag: phase-145 (NEXT_PUBLIC_FEATURE_PHASE_145 / FEATURE_PHASE_145).
 * When the flag is off, assessWalletSybilRisk() returns null and callers keep
 * their legacy behaviour (zero regression). The pure scorer stays callable for
 * isolated unit testing with `npx tsx`.
 *
 * Rollback: unset the flag. No persisted state — nothing to migrate.
 */

import { createHmac, randomUUID } from "node:crypto"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { HORIZON_URL } from "@/lib/phase-protocol"
import { getDb } from "@/lib/sqlite-db"
import { incSecurityCounter, SYBIL_DECISION_REASONS } from "@/lib/security-counters"

export function isSybilResistanceEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-145", wallet ? { wallet, runtimeOnly: true } : { runtimeOnly: true })
}

export function flag145RollbackNote(): string {
  return "Rollback phase-145: unset NEXT_PUBLIC_FEATURE_PHASE_145 / FEATURE_PHASE_145 or set 0/false and restart. No persisted state."
}

const G_ADDRESS_RE = /^G[A-Z2-7]{55}$/

export const SybilScoreInputSchema = z.object({
  accountAgeDays: z.number().min(0).max(100_000),
  transactionCount: z.number().int().min(0),
  paymentCount: z.number().int().min(0),
  distinctCounterparties: z.number().int().min(0),
  nativeBalance: z.number().min(0),
  hasHomeDomain: z.boolean().default(false),
  signerCount: z.number().int().min(1).default(1),
  trustlineCount: z.number().int().min(0).default(0),
  sponsoredReserves: z.number().int().min(0).default(0),
})

export type SybilScoreInput = z.infer<typeof SybilScoreInputSchema>

export type SybilBand = "trusted" | "caution" | "suspect"

export type SybilScore = {
  score: number
  band: SybilBand
  suspect: boolean
  signals: string[]
}

export class SybilResistanceError extends Error {
  readonly code: "VALIDATION_FAILED" | "FLAG_DISABLED"
  readonly details?: unknown
  constructor(code: SybilResistanceError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "SybilResistanceError"
    this.code = code
    this.details = details
  }
}

function getSuspectThreshold(): number {
  const envVal = (process.env.NEXT_PUBLIC_SYBIL_SUSPECT_MAX ?? process.env.SYBIL_SUSPECT_MAX ?? "34").trim()
  const parsed = parseInt(envVal, 10)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 34
}

function getCautionThreshold(): number {
  const envVal = (process.env.NEXT_PUBLIC_SYBIL_CAUTION_MAX ?? process.env.SYBIL_CAUTION_MAX ?? "64").trim()
  const parsed = parseInt(envVal, 10)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 64
}

const SUSPECT_MAX = getSuspectThreshold()
const CAUTION_MAX = getCautionThreshold()

function clampThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(100, value))
}

/**
 * Pure — maps an account feature vector to a 0..100 trust score (higher = more
 * established / less likely to be a throwaway sybil wallet). Throws
 * SybilResistanceError on a malformed input rather than guessing.
 */
export function scoreWalletHistory(
  rawInput: unknown,
  opts: { suspectThreshold?: number } = {},
): SybilScore {
  const parsed = SybilScoreInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SybilResistanceError(
      "VALIDATION_FAILED",
      "Sybil score input failed schema validation",
      parsed.error.flatten(),
    )
  }
  const f = parsed.data
  const signals: string[] = []
  let score = 0

  // Account age — freshly created wallets are the primary sybil tell.
  if (f.accountAgeDays >= 90) {
    score += 30
    signals.push("account_age>=90d")
  } else if (f.accountAgeDays >= 30) {
    score += 22
    signals.push("account_age>=30d")
  } else if (f.accountAgeDays >= 7) {
    score += 12
    signals.push("account_age>=7d")
  } else if (f.accountAgeDays >= 1) {
    score += 4
    signals.push("account_age>=1d")
  } else {
    signals.push("account_age<1d")
  }

  // Transaction-history depth.
  if (f.transactionCount >= 50) {
    score += 20
    signals.push("tx_count>=50")
  } else if (f.transactionCount >= 10) {
    score += 13
    signals.push("tx_count>=10")
  } else if (f.transactionCount >= 3) {
    score += 6
    signals.push("tx_count>=3")
  } else {
    signals.push("tx_count<3")
  }

  // Economic diversity — a real user transacts with multiple counterparties.
  if (f.distinctCounterparties >= 10) {
    score += 18
    signals.push("counterparties>=10")
  } else if (f.distinctCounterparties >= 3) {
    score += 10
    signals.push("counterparties>=3")
  } else if (f.distinctCounterparties >= 1) {
    score += 4
    signals.push("counterparties>=1")
  } else {
    signals.push("counterparties=0")
  }

  // Skin in the game.
  if (f.nativeBalance >= 100) {
    score += 12
    signals.push("balance>=100XLM")
  } else if (f.nativeBalance >= 20) {
    score += 8
    signals.push("balance>=20XLM")
  } else if (f.nativeBalance >= 5) {
    score += 4
    signals.push("balance>=5XLM")
  } else {
    signals.push("balance<5XLM")
  }

  // Configuration effort.
  if (f.hasHomeDomain) {
    score += 5
    signals.push("home_domain")
  }
  if (f.signerCount > 1) {
    score += 3
    signals.push("multi_signer")
  }
  if (f.trustlineCount >= 2) {
    score += 5
    signals.push("trustlines>=2")
  } else if (f.trustlineCount === 1) {
    score += 2
  }

  // Penalty — a fully sponsored, dormant, brand-new account looks farmed.
  if (f.sponsoredReserves > 0 && f.transactionCount <= 1 && f.accountAgeDays < 7) {
    score -= 10
    signals.push("sponsored_dormant")
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const suspectThreshold = clampThreshold(opts.suspectThreshold, SUSPECT_MAX)
  const band: SybilBand =
    score <= suspectThreshold ? "suspect" : score <= CAUTION_MAX ? "caution" : "trusted"

  return { score, band, suspect: band === "suspect", signals }
}

export function isSybilSuspect(score: number, threshold = SUSPECT_MAX): boolean {
  return score <= clampThreshold(threshold, SUSPECT_MAX)
}

// ─── Horizon feature extraction (network, best-effort) ───────────────────────

type HorizonBalance = { balance?: string; asset_type?: string }
type HorizonAccount = {
  created_at?: string
  balances?: HorizonBalance[]
  signers?: unknown[]
  home_domain?: string
  num_sponsored?: number | string
}
type HorizonRecords = { _embedded?: { records?: Array<Record<string, unknown>> } }

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Reads an account's on-chain history from Horizon and reduces it to the
 * feature vector scoreWalletHistory() expects. Returns null on any network
 * failure (caller treats as "unknown"); a not-found account yields a
 * zeroed vector (max sybil signal). `transactionCount` is capped at 200 by the
 * Horizon page size and is treated as a lower bound.
 */
export async function fetchAccountHistoryFeatures(
  address: string,
  opts: { horizonUrl?: string; timeoutMs?: number } = {},
): Promise<SybilScoreInput | null> {
  const addr = address.trim()
  if (!G_ADDRESS_RE.test(addr)) return null
  const base = (opts.horizonUrl ?? HORIZON_URL).replace(/\/+$/, "")
  const timeoutMs = opts.timeoutMs ?? 6000
  const enc = encodeURIComponent(addr)

  const account = (await getJson(`${base}/accounts/${enc}`, timeoutMs)) as HorizonAccount | null
  if (account === null) {
    // Distinguish "no account" (404 → getJson null too). Probe once more cheaply:
    const probe = await fetch(`${base}/accounts/${enc}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null)
    if (probe && probe.status === 404) {
      return SybilScoreInputSchema.parse({
        accountAgeDays: 0,
        transactionCount: 0,
        paymentCount: 0,
        distinctCounterparties: 0,
        nativeBalance: 0,
        hasHomeDomain: false,
        signerCount: 1,
        trustlineCount: 0,
        sponsoredReserves: 0,
      })
    }
    return null
  }

  const balances = Array.isArray(account.balances) ? account.balances : []
  const nativeBalance =
    Number.parseFloat(balances.find((b) => b.asset_type === "native")?.balance ?? "0") || 0
  const trustlineCount = balances.filter((b) => b.asset_type !== "native").length
  const signerCount = Array.isArray(account.signers) ? Math.max(1, account.signers.length) : 1
  const hasHomeDomain =
    typeof account.home_domain === "string" && account.home_domain.trim().length > 0
  const sponsoredReserves = Number(account.num_sponsored ?? 0) || 0

  const [txPage, payPage] = await Promise.all([
    getJson(
      `${base}/accounts/${enc}/transactions?order=desc&limit=200&include_failed=false`,
      timeoutMs,
    ) as Promise<HorizonRecords | null>,
    getJson(`${base}/accounts/${enc}/payments?order=desc&limit=200`, timeoutMs) as Promise<
      HorizonRecords | null
    >,
  ])

  const txRecords = txPage?._embedded?.records ?? []
  const transactionCount = txRecords.length
  let accountAgeDays = 0
  if (typeof account.created_at === "string") {
    const ms = Date.now() - new Date(account.created_at).getTime()
    if (Number.isFinite(ms) && ms > 0) accountAgeDays = ms / 86_400_000
  }
  const oldest = txRecords[txRecords.length - 1]
  const oldestCreatedAt = oldest?.["created_at"]
  if (accountAgeDays === 0 && typeof oldestCreatedAt === "string") {
    const ms = Date.now() - new Date(oldestCreatedAt).getTime()
    if (Number.isFinite(ms) && ms > 0) accountAgeDays = ms / 86_400_000
  }

  const payRecords = payPage?._embedded?.records ?? []
  const paymentCount = payRecords.length
  const counterparties = new Set<string>()
  for (const p of payRecords) {
    for (const key of ["from", "to", "source_account", "account", "funder"]) {
      const v = p[key]
      if (typeof v === "string" && v !== addr && G_ADDRESS_RE.test(v)) counterparties.add(v)
    }
  }

  return SybilScoreInputSchema.parse({
    accountAgeDays,
    transactionCount,
    paymentCount,
    distinctCounterparties: counterparties.size,
    nativeBalance,
    hasHomeDomain,
    signerCount,
    trustlineCount,
    sponsoredReserves,
  })
}

/**
 * Flag-gated end-to-end assessment. Returns null when phase-145 is off or when
 * on-chain history could not be read.
 */
export async function assessWalletSybilRisk(
  address: string,
  opts: { horizonUrl?: string; timeoutMs?: number; suspectThreshold?: number } = {},
): Promise<SybilScore | null> {
  if (!isSybilResistanceEnabled(address)) return null
  const features = await fetchAccountHistoryFeatures(address, opts)
  if (!features) return null
  try {
    return scoreWalletHistory(features, { suspectThreshold: opts.suspectThreshold })
  } catch {
    return null
  }
}

// ── Spike 672 (flag-gated): lobby admission hint ──
// scoreWalletHistory bands are unchanged (suspect<=34, caution<=64); drops deny
// `suspect` wallets with 429 + Retry-After while humans pass through. Pure.
export type LobbyAdmission = "admit" | "challenge" | "deny";
export function lobbyAdmissionForBand(band: "trusted" | "caution" | "suspect"): LobbyAdmission {
  if (band === "trusted") return "admit";
  if (band === "caution") return "challenge";
  return "deny";
}

/**
 * Spike 611: Expose sybil band and account age for cohort analytics.
 */
export async function classifyWalletForCohorts(
  address: string,
): Promise<{ band: SybilBand; accountAgeDays: number; score: number } | null> {
  const features = await fetchAccountHistoryFeatures(address).catch(() => null)
  if (!features) return null
  const scoreResult = scoreWalletHistory(features)
  return {
    band: scoreResult.band,
    accountAgeDays: features.accountAgeDays,
    score: scoreResult.score,
  }
}

// ── phase-246 (#697): Sybil gating for rewards & governance + inspect ────────

export type SybilDecisionSurface = "reward_credit" | "governance_vote"
export type SybilDecisionReasonCode = (typeof SYBIL_DECISION_REASONS)[number]

export type SybilDecision = {
  decisionId: string
  walletHash: string
  surface: SybilDecisionSurface
  score: number
  minThreshold: number
  band: SybilBand
  allowed: boolean
  reasonCode: SybilDecisionReasonCode
  signals: string[]
  createdAt: number
}

export function isSybilGatingEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-246", wallet ? { wallet, runtimeOnly: true } : { runtimeOnly: true })
}

export function getSybilMinThreshold(surface: SybilDecisionSurface): number {
  const specific =
    surface === "reward_credit"
      ? process.env.SYBIL_MIN_REWARD_SCORE
      : process.env.SYBIL_MIN_VOTE_SCORE
  const raw = (specific ?? process.env.SYBIL_MIN_SCORE ?? "").trim()
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(100, parsed))
  }
  // Default: strictly above SUSPECT_MAX (34) so suspect wallets (0..34) are blocked.
  return Math.min(100, SUSPECT_MAX + 1)
}

export function hashWalletForSybil(wallet: string): string {
  const secret =
    process.env.PHASE_SYBIL_HASH_KEY?.trim() ||
    process.env.PHASE_KYC_HASH_KEY?.trim() ||
    "phase-sybil-decision-key"
  return createHmac("sha256", secret).update(`sybil:${wallet.trim()}`).digest("hex")
}

function persistSybilDecision(decision: SybilDecision): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO sybil_decisions (
      decision_id, wallet_hash, surface, score, min_threshold, band, allowed, reason_code, signals_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.decisionId,
    decision.walletHash,
    decision.surface,
    decision.score,
    decision.minThreshold,
    decision.band,
    decision.allowed ? 1 : 0,
    decision.reasonCode,
    JSON.stringify(decision.signals),
    decision.createdAt,
  )
}

function mapSybilDecisionRow(row: {
  decision_id: string
  wallet_hash: string
  surface: SybilDecisionSurface
  score: number
  min_threshold: number
  band: SybilBand
  allowed: number
  reason_code: string
  signals_json: string
  created_at: number
}): SybilDecision {
  const validReason = (SYBIL_DECISION_REASONS as readonly string[]).includes(row.reason_code)
    ? (row.reason_code as SybilDecisionReasonCode)
    : "signal_unavailable"
  let signals: string[] = []
  try {
    const parsed = JSON.parse(row.signals_json)
    if (Array.isArray(parsed)) signals = parsed.filter((s): s is string => typeof s === "string")
  } catch {
    signals = []
  }
  return {
    decisionId: row.decision_id,
    walletHash: row.wallet_hash,
    surface: row.surface,
    score: row.score,
    minThreshold: row.min_threshold,
    band: row.band,
    allowed: row.allowed === 1,
    reasonCode: validReason,
    signals,
    createdAt: row.created_at,
  }
}

/**
 * Evaluates a wallet's sybil score for a credit or governance vote surface,
 * persists the decision with a closed reason code, and emits a cardinality-safe
 * counter. Returns null when phase-246 is off (no gating).
 */
export async function evaluateAndRecordSybilDecision(
  wallet: string,
  surface: SybilDecisionSurface,
  opts: {
    minThreshold?: number
    features?: SybilScoreInput | null
    horizonUrl?: string
    timeoutMs?: number
  } = {},
): Promise<SybilDecision | null> {
  if (!isSybilGatingEnabled(wallet)) return null

  const trimmed = wallet.trim()
  const minThreshold = clampThreshold(opts.minThreshold, getSybilMinThreshold(surface))
  const now = Date.now()
  const walletHash = hashWalletForSybil(trimmed)
  const decisionId = randomUUID()

  if (!G_ADDRESS_RE.test(trimmed)) {
    const decision: SybilDecision = {
      decisionId,
      walletHash,
      surface,
      score: 0,
      minThreshold,
      band: "suspect",
      allowed: false,
      reasonCode: "invalid_wallet",
      signals: ["invalid_wallet"],
      createdAt: now,
    }
    persistSybilDecision(decision)
    incSecurityCounter("sybil_decision_recorded", decision.reasonCode)
    return decision
  }

  const features =
    opts.features !== undefined
      ? opts.features
      : await fetchAccountHistoryFeatures(trimmed, {
          horizonUrl: opts.horizonUrl,
          timeoutMs: opts.timeoutMs,
        })

  if (!features) {
    const decision: SybilDecision = {
      decisionId,
      walletHash,
      surface,
      score: 0,
      minThreshold,
      band: "suspect",
      allowed: false,
      reasonCode: "signal_unavailable",
      signals: ["horizon_unavailable"],
      createdAt: now,
    }
    persistSybilDecision(decision)
    incSecurityCounter("sybil_decision_recorded", decision.reasonCode)
    return decision
  }

  const scored = scoreWalletHistory(features, {
    suspectThreshold: Math.max(0, minThreshold - 1),
  })
  const allowed = scored.score >= minThreshold
  const reasonCode: SybilDecisionReasonCode = !allowed
    ? "below_threshold"
    : scored.band === "trusted"
      ? "allowed_trusted"
      : "allowed_caution"

  const decision: SybilDecision = {
    decisionId,
    walletHash,
    surface,
    score: scored.score,
    minThreshold,
    band: scored.band,
    allowed,
    reasonCode,
    signals: scored.signals,
    createdAt: now,
  }
  persistSybilDecision(decision)
  incSecurityCounter("sybil_decision_recorded", decision.reasonCode)
  return decision
}

export function getSybilDecisionById(decisionId: string): SybilDecision | null {
  const db = getDb()
  const row = db
    .prepare("SELECT * FROM sybil_decisions WHERE decision_id = ?")
    .get(decisionId) as Parameters<typeof mapSybilDecisionRow>[0] | undefined
  return row ? mapSybilDecisionRow(row) : null
}

export function listSybilDecisionsByWallet(wallet: string, limit = 25): SybilDecision[] {
  const db = getDb()
  const bounded = Math.max(1, Math.min(100, limit))
  const rows = db
    .prepare("SELECT * FROM sybil_decisions WHERE wallet_hash = ? ORDER BY created_at DESC LIMIT ?")
    .all(hashWalletForSybil(wallet), bounded) as Array<Parameters<typeof mapSybilDecisionRow>[0]>
  return rows.map(mapSybilDecisionRow)
}

export function listRecentSybilDecisions(limit = 50): SybilDecision[] {
  const db = getDb()
  const bounded = Math.max(1, Math.min(200, limit))
  const rows = db
    .prepare("SELECT * FROM sybil_decisions ORDER BY created_at DESC LIMIT ?")
    .all(bounded) as Array<Parameters<typeof mapSybilDecisionRow>[0]>
  return rows.map(mapSybilDecisionRow)
}
