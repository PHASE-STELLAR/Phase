/**
 * Unified server pre-credit gate for faucet / reward claims — phase-247 (issue #698).
 *
 * Evaluates deny-list, Turnstile, sybil, and compliance in one fail-closed
 * decision before any reward credit or on-chain mint is attempted:
 *   - Any gate can block credit independently.
 *   - Any provider outage (Turnstile timeout/5xx, Horizon signal outage,
 *     compliance screening unavailable, deny-list store error) fails closed
 *     with HTTP 503 + `Retry-After`.
 *   - Persists only keyed HMAC-SHA256 hashes (wallet_hash, ip_hash) — never raw PII.
 *
 * Flag: phase-247 (NEXT_PUBLIC_FEATURE_PHASE_247 / FEATURE_PHASE_247).
 * Rollback: unset flag — legacy gate order in app/api/faucet/route.ts is used;
 *           hash rows in `pre_credit_gate_decisions` remain inert.
 */

import { createHmac, randomUUID } from "node:crypto"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getDb } from "@/lib/sqlite-db"
import { isWalletDenied } from "@/lib/faucet-deny-list"
import {
  FaucetTurnstileError,
  turnstileSiteKeyConfigured,
  verifyTurnstileToken,
} from "@/lib/faucet-turnstile"
import {
  assessWalletSybilRisk,
  evaluateAndRecordSybilDecision,
  isSybilGatingEnabled,
  isSybilResistanceEnabled,
} from "@/lib/sybil-resistance"
import { ComplianceError, screenCompliance } from "@/lib/compliance"
import { incSecurityCounter, PRE_CREDIT_GATE_REASONS } from "@/lib/security-counters"

export type PreCreditBlockingGate = "none" | "deny_list" | "turnstile" | "sybil" | "compliance"
export type PreCreditReasonCode = (typeof PRE_CREDIT_GATE_REASONS)[number]

export type PreCreditGateDecision = {
  decisionId: string
  walletHash: string
  ipHash: string | null
  allowed: boolean
  blockingGate: PreCreditBlockingGate
  reasonCode: PreCreditReasonCode
  code: string
  error?: string
  status: number
  retryAfterSeconds?: number
  createdAt: number
}

export type PreCreditGateInput = {
  wallet: string
  amountStroops: string
  turnstileToken?: string
  clientIp?: string
  retryAfterSeconds?: number
}

export type PreCreditGateDeps = {
  checkDenyList?: (wallet: string) => Promise<boolean>
  isTurnstileRequired?: () => boolean
  verifyTurnstile?: (token: string, clientIp?: string) => Promise<boolean>
  checkSybil?: (wallet: string) => Promise<{
    allowed: boolean
    unavailable?: boolean
    reasonCode?: string
    score?: number
    minThreshold?: number
  }>
  checkCompliance?: (wallet: string, amountStroops: string) => Promise<void>
}

const DEFAULT_RETRY_AFTER_SECONDS = 30

export function isPreCreditGateEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-247", wallet ? { wallet, runtimeOnly: true } : { runtimeOnly: true })
}

export function hashPreCreditIdentity(kind: "wallet" | "ip", value: string): string {
  const secret =
    process.env.PHASE_PRE_CREDIT_HASH_KEY?.trim() ||
    process.env.PHASE_KYC_HASH_KEY?.trim() ||
    "phase-pre-credit-hash-key"
  return createHmac("sha256", secret).update(`${kind}:${value.trim()}`).digest("hex")
}

function persistPreCreditDecision(decision: PreCreditGateDecision): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO pre_credit_gate_decisions (
      decision_id, wallet_hash, ip_hash, allowed, blocking_gate, reason_code, http_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.decisionId,
    decision.walletHash,
    decision.ipHash,
    decision.allowed ? 1 : 0,
    decision.blockingGate,
    decision.reasonCode,
    decision.status,
    decision.createdAt,
  )
}

function recordAndReturn(decision: PreCreditGateDecision): PreCreditGateDecision {
  persistPreCreditDecision(decision)
  incSecurityCounter("pre_credit_gate_decision", decision.reasonCode)
  return decision
}

async function defaultCheckSybil(wallet: string): Promise<{
  allowed: boolean
  unavailable?: boolean
  reasonCode?: string
  score?: number
  minThreshold?: number
}> {
  if (isSybilGatingEnabled(wallet)) {
    const decision = await evaluateAndRecordSybilDecision(wallet, "reward_credit")
    if (!decision) return { allowed: true }
    if (decision.reasonCode === "signal_unavailable") {
      return { allowed: false, unavailable: true, reasonCode: decision.reasonCode, score: decision.score }
    }
    return {
      allowed: decision.allowed,
      reasonCode: decision.reasonCode,
      score: decision.score,
      minThreshold: decision.minThreshold,
    }
  }
  if (isSybilResistanceEnabled(wallet)) {
    const risk = await assessWalletSybilRisk(wallet)
    if (!risk) return { allowed: false, unavailable: true, reasonCode: "signal_unavailable" }
    return { allowed: !risk.suspect, score: risk.score }
  }
  return { allowed: true }
}

/**
 * Evaluates deny-list, Turnstile, sybil, and compliance in one unified
 * fail-closed pre-credit decision. Returns null when phase-247 is off.
 */
export async function evaluatePreCreditGate(
  input: PreCreditGateInput,
  deps: PreCreditGateDeps = {},
): Promise<PreCreditGateDecision | null> {
  if (!isPreCreditGateEnabled(input.wallet)) return null

  const now = Date.now()
  const decisionId = randomUUID()
  const walletHash = hashPreCreditIdentity("wallet", input.wallet)
  const ipHash = input.clientIp?.trim() ? hashPreCreditIdentity("ip", input.clientIp) : null
  const retryAfter = input.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS

  // 1. Deny-list gate
  const checkDeny = deps.checkDenyList ?? isWalletDenied
  try {
    if (await checkDeny(input.wallet)) {
      return recordAndReturn({
        decisionId,
        walletHash,
        ipHash,
        allowed: false,
        blockingGate: "deny_list",
        reasonCode: "wallet_denied",
        code: "WALLET_DENIED",
        error: "Wallet is excluded by governance deny-list.",
        status: 403,
        createdAt: now,
      })
    }
  } catch {
    return recordAndReturn({
      decisionId,
      walletHash,
      ipHash,
      allowed: false,
      blockingGate: "deny_list",
      reasonCode: "provider_outage",
      code: "DENY_LIST_UNAVAILABLE",
      error: "Deny-list service unavailable. Retry later.",
      status: 503,
      retryAfterSeconds: retryAfter,
      createdAt: now,
    })
  }

  // 2. Turnstile gate
  const turnstileRequired = deps.isTurnstileRequired ?? turnstileSiteKeyConfigured
  if (turnstileRequired()) {
    if (!input.turnstileToken?.trim()) {
      return recordAndReturn({
        decisionId,
        walletHash,
        ipHash,
        allowed: false,
        blockingGate: "turnstile",
        reasonCode: "turnstile_required",
        code: "TURNSTILE_REQUIRED",
        error: "Turnstile token required.",
        status: 400,
        createdAt: now,
      })
    }
    const verifyTurnstile = deps.verifyTurnstile ?? verifyTurnstileToken
    try {
      const ok = await verifyTurnstile(input.turnstileToken.trim(), input.clientIp)
      if (!ok) {
        return recordAndReturn({
          decisionId,
          walletHash,
          ipHash,
          allowed: false,
          blockingGate: "turnstile",
          reasonCode: "turnstile_failed",
          code: "TURNSTILE_FAILED",
          error: "Turnstile verification failed.",
          status: 403,
          createdAt: now,
        })
      }
    } catch (err) {
      if (err instanceof FaucetTurnstileError && err.code === "TOKEN_INVALID") {
        return recordAndReturn({
          decisionId,
          walletHash,
          ipHash,
          allowed: false,
          blockingGate: "turnstile",
          reasonCode: "turnstile_failed",
          code: "TURNSTILE_FAILED",
          error: "Turnstile rejected token.",
          status: 403,
          createdAt: now,
        })
      }
      return recordAndReturn({
        decisionId,
        walletHash,
        ipHash,
        allowed: false,
        blockingGate: "turnstile",
        reasonCode: "provider_outage",
        code: "TURNSTILE_UNAVAILABLE",
        error: "Turnstile verification provider unavailable. Retry later.",
        status: 503,
        retryAfterSeconds: retryAfter,
        createdAt: now,
      })
    }
  }

  // 3. Sybil gate
  const checkSybil = deps.checkSybil ?? defaultCheckSybil
  try {
    const sybil = await checkSybil(input.wallet)
    if (sybil.unavailable) {
      return recordAndReturn({
        decisionId,
        walletHash,
        ipHash,
        allowed: false,
        blockingGate: "sybil",
        reasonCode: "provider_outage",
        code: "SYBIL_SIGNAL_UNAVAILABLE",
        error: "Sybil signal provider unavailable. Retry later.",
        status: 503,
        retryAfterSeconds: retryAfter,
        createdAt: now,
      })
    }
    if (!sybil.allowed) {
      return recordAndReturn({
        decisionId,
        walletHash,
        ipHash,
        allowed: false,
        blockingGate: "sybil",
        reasonCode: "sybil_blocked",
        code: "SYBIL_BELOW_THRESHOLD",
        error: "Wallet does not meet sybil threshold for credit.",
        status: 403,
        createdAt: now,
      })
    }
  } catch {
    return recordAndReturn({
      decisionId,
      walletHash,
      ipHash,
      allowed: false,
      blockingGate: "sybil",
      reasonCode: "provider_outage",
      code: "SYBIL_SIGNAL_UNAVAILABLE",
      error: "Sybil signal provider unavailable. Retry later.",
      status: 503,
      retryAfterSeconds: retryAfter,
      createdAt: now,
    })
  }

  // 4. Compliance gate
  const checkCompliance =
    deps.checkCompliance ?? ((w: string, amt: string) => screenCompliance(w, amt, "faucet"))
  try {
    await checkCompliance(input.wallet, input.amountStroops)
  } catch (err) {
    if (err instanceof ComplianceError && err.status < 500) {
      return recordAndReturn({
        decisionId,
        walletHash,
        ipHash,
        allowed: false,
        blockingGate: "compliance",
        reasonCode: "compliance_blocked",
        code: err.code,
        error: `Compliance blocked: ${err.code}`,
        status: err.status,
        createdAt: now,
      })
    }
    return recordAndReturn({
      decisionId,
      walletHash,
      ipHash,
      allowed: false,
      blockingGate: "compliance",
      reasonCode: "provider_outage",
      code: "SCREENING_UNAVAILABLE",
      error: "Compliance screening provider unavailable. Retry later.",
      status: 503,
      retryAfterSeconds: retryAfter,
      createdAt: now,
    })
  }

  return recordAndReturn({
    decisionId,
    walletHash,
    ipHash,
    allowed: true,
    blockingGate: "none",
    reasonCode: "admitted",
    code: "PRE_CREDIT_ADMITTED",
    status: 200,
    createdAt: now,
  })
}
