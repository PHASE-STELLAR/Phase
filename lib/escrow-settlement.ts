/**
 * Escrow settlement with 2-of-3 multisig fallback
 * Isolated module for recovery path on failed settlements
 * Provides dispute resolution and recovery mechanisms
 */

import { z } from "zod"

// ── Configuration ──────────────────────────────────────────────────────────

export const ESCROW_TIMEOUT_SECONDS = 86400 * 7 // 7 days
export const DISPUTE_WINDOW_SECONDS = 86400 * 3 // 3 days
export const MAX_ESCROW_AMOUNT = "100000000000" // 10000 PHASELQ in stroops

// ── Type definitions ───────────────────────────────────────────────────────

export const EscrowSchema = z.object({
  escrowId: z.string().min(1).max(128),
  buyer: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  seller: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  arbiter: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  amount: z.string().regex(/^\d+$/), // stroops
  tokenId: z.number().int().positive(),
  collectionId: z.number().int().min(0),
  status: z.enum([
    "pending",
    "funded",
    "completed",
    "disputed",
    "refunded",
    "failed",
    "expired",
  ]),
  createdAt: z.number().int().positive(),
  fundedAt: z.number().int().positive().nullable(),
  completedAt: z.number().int().positive().nullable(),
  expiresAt: z.number().int().positive(),
  multisigAddress: z.string().length(56).regex(/^G[A-Z2-7]{55}$/).nullable(),
  signatures: z.array(z.object({
    signer: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
    signedAt: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
  })),
  metadata: z.object({
    reason: z.string().max(500).optional(),
    disputeReason: z.string().max(1000).optional(),
  }).optional(),
})

export type Escrow = z.infer<typeof EscrowSchema>

export const CreateEscrowSchema = z.object({
  buyer: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  seller: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  arbiter: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  amount: z.string().regex(/^\d+$/),
  tokenId: z.number().int().positive(),
  collectionId: z.number().int().min(0),
  timeoutSeconds: z.number().int().min(3600).max(2592000).default(ESCROW_TIMEOUT_SECONDS),
})

export type CreateEscrow = z.infer<typeof CreateEscrowSchema>

export const SignEscrowSchema = z.object({
  escrowId: z.string().min(1).max(128),
  signer: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(500).optional(),
})

export type SignEscrow = z.infer<typeof SignEscrowSchema>

export const DisputeEscrowSchema = z.object({
  escrowId: z.string().min(1).max(128),
  initiator: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  reason: z.string().min(10).max(1000),
})

export type DisputeEscrow = z.infer<typeof DisputeEscrowSchema>

// ── Error handling ─────────────────────────────────────────────────────────

export class EscrowSettlementError extends Error {
  code:
    | "VALIDATION_FAILED"
    | "ESCROW_NOT_FOUND"
    | "ESCROW_EXPIRED"
    | "INSUFFICIENT_SIGNATURES"
    | "UNAUTHORIZED_SIGNER"
    | "ALREADY_SIGNED"
    | "INVALID_STATUS"
    | "AMOUNT_EXCEEDS_LIMIT"
    | "DISPUTE_WINDOW_CLOSED"
  details?: unknown

  constructor(code: EscrowSettlementError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "EscrowSettlementError"
    this.code = code
    this.details = details
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate escrow creation
 */
export function validateEscrowCreation(
  escrow: CreateEscrow
): { valid: true } | { valid: false; error: string; code: string } {
  const parsed = CreateEscrowSchema.safeParse(escrow)
  if (!parsed.success) {
    return {
      valid: false,
      error: parsed.error.message,
      code: "VALIDATION_FAILED",
    }
  }

  // Validate parties are unique
  const parties = [escrow.buyer, escrow.seller, escrow.arbiter]
  const uniqueParties = new Set(parties)
  if (uniqueParties.size !== 3) {
    return {
      valid: false,
      error: "Buyer, seller, and arbiter must be different addresses",
      code: "VALIDATION_FAILED",
    }
  }

  // Validate amount
  try {
    const amountBI = BigInt(escrow.amount)
    const maxBI = BigInt(MAX_ESCROW_AMOUNT)
    
    if (amountBI <= BigInt(0)) {
      return {
        valid: false,
        error: "Escrow amount must be greater than zero",
        code: "VALIDATION_FAILED",
      }
    }

    if (amountBI > maxBI) {
      return {
        valid: false,
        error: `Escrow amount ${escrow.amount} exceeds maximum ${MAX_ESCROW_AMOUNT}`,
        code: "AMOUNT_EXCEEDS_LIMIT",
      }
    }
  } catch {
    return {
      valid: false,
      error: "Invalid escrow amount format",
      code: "VALIDATION_FAILED",
    }
  }

  return { valid: true }
}

/**
 * Validate escrow signature
 */
export function validateEscrowSignature(
  signature: SignEscrow,
  escrow: Escrow
): { valid: true } | { valid: false; error: string; code: string } {
  const parsed = SignEscrowSchema.safeParse(signature)
  if (!parsed.success) {
    return {
      valid: false,
      error: parsed.error.message,
      code: "VALIDATION_FAILED",
    }
  }

  // Check escrow status
  if (escrow.status !== "funded" && escrow.status !== "disputed") {
    return {
      valid: false,
      error: `Cannot sign escrow in ${escrow.status} status`,
      code: "INVALID_STATUS",
    }
  }

  // Check signer authorization
  const authorizedSigners = [escrow.buyer, escrow.seller, escrow.arbiter]
  if (!authorizedSigners.includes(signature.signer)) {
    return {
      valid: false,
      error: "Signer is not authorized for this escrow",
      code: "UNAUTHORIZED_SIGNER",
    }
  }

  // Check if already signed
  const existingSignature = escrow.signatures.find((s) => s.signer === signature.signer)
  if (existingSignature) {
    return {
      valid: false,
      error: "Signer has already signed this escrow",
      code: "ALREADY_SIGNED",
    }
  }

  // Check expiration
  if (Date.now() > escrow.expiresAt) {
    return {
      valid: false,
      error: "Escrow has expired",
      code: "ESCROW_EXPIRED",
    }
  }

  return { valid: true }
}

// ── Multisig operations ────────────────────────────────────────────────────

/**
 * Check if escrow has reached 2-of-3 consensus
 */
export function hasReachedConsensus(escrow: Escrow): {
  reached: boolean
  decision: "approve" | "reject" | null
  approvals: number
  rejections: number
} {
  const approvals = escrow.signatures.filter((s) => s.decision === "approve").length
  const rejections = escrow.signatures.filter((s) => s.decision === "reject").length

  if (approvals >= 2) {
    return { reached: true, decision: "approve", approvals, rejections }
  }

  if (rejections >= 2) {
    return { reached: true, decision: "reject", approvals, rejections }
  }

  return { reached: false, decision: null, approvals, rejections }
}

/**
 * Get remaining required signatures
 */
export function getRemainingSignatures(escrow: Escrow): {
  required: number
  remaining: string[]
} {
  const consensus = hasReachedConsensus(escrow)
  if (consensus.reached) {
    return { required: 0, remaining: [] }
  }

  const allParties = [escrow.buyer, escrow.seller, escrow.arbiter]
  const signed = new Set(escrow.signatures.map((s) => s.signer))
  const remaining = allParties.filter((p) => !signed.has(p))

  return {
    required: 2 - escrow.signatures.length,
    remaining,
  }
}

/**
 * Check if escrow is expired
 */
export function isEscrowExpired(escrow: Escrow): boolean {
  return Date.now() > escrow.expiresAt
}

/**
 * Check if escrow can be disputed
 */
export function canDisputeEscrow(escrow: Escrow, initiator: string): {
  can: boolean
  reason: string | null
} {
  if (escrow.status !== "funded") {
    return { can: false, reason: `Cannot dispute escrow in ${escrow.status} status` }
  }

  if (initiator !== escrow.buyer && initiator !== escrow.seller) {
    return { can: false, reason: "Only buyer or seller can initiate dispute" }
  }

  if (!escrow.fundedAt) {
    return { can: false, reason: "Escrow has not been funded yet" }
  }

  const disputeDeadline = escrow.fundedAt + (DISPUTE_WINDOW_SECONDS * 1000)
  if (Date.now() > disputeDeadline) {
    return { can: false, reason: "Dispute window has closed" }
  }

  return { can: true, reason: null }
}

// ── Settlement logic ───────────────────────────────────────────────────────

/**
 * Determine escrow settlement outcome
 */
export function determineSettlement(escrow: Escrow): {
  shouldSettle: boolean
  outcome: "complete" | "refund" | "expire" | "pending"
  reason: string
} {
  // Check expiration
  if (isEscrowExpired(escrow) && escrow.status === "funded") {
    return {
      shouldSettle: true,
      outcome: "expire",
      reason: "Escrow expired without reaching consensus",
    }
  }

  // Check consensus
  const consensus = hasReachedConsensus(escrow)
  if (consensus.reached) {
    if (consensus.decision === "approve") {
      return {
        shouldSettle: true,
        outcome: "complete",
        reason: `2-of-3 consensus reached: ${consensus.approvals} approvals`,
      }
    }

    return {
      shouldSettle: true,
      outcome: "refund",
      reason: `2-of-3 consensus reached: ${consensus.rejections} rejections`,
    }
  }

  return {
    shouldSettle: false,
    outcome: "pending",
    reason: "Awaiting signatures to reach 2-of-3 consensus",
  }
}

/**
 * Get escrow statistics
 */
export function getEscrowStatistics(escrows: Escrow[]): {
  total: number
  byStatus: Record<Escrow["status"], number>
  totalVolume: string
  averageAmount: string
  successRate: string
  disputeRate: string
} {
  const byStatus: Record<Escrow["status"], number> = {
    pending: 0,
    funded: 0,
    completed: 0,
    disputed: 0,
    refunded: 0,
    failed: 0,
    expired: 0,
  }

  let totalVolume = BigInt(0)
  
  for (const escrow of escrows) {
    byStatus[escrow.status]++
    try {
      totalVolume += BigInt(escrow.amount)
    } catch {
      // Skip invalid amounts
    }
  }

  const completed = byStatus.completed
  const total = escrows.length
  const successRate = total > 0 ? ((completed / total) * 100).toFixed(2) : "0.00"
  const disputeRate = total > 0 ? ((byStatus.disputed / total) * 100).toFixed(2) : "0.00"
  const averageAmount = total > 0 ? (totalVolume / BigInt(total)).toString() : "0"

  return {
    total,
    byStatus,
    totalVolume: totalVolume.toString(),
    averageAmount,
    successRate,
    disputeRate,
  }
}

// ── User views ─────────────────────────────────────────────────────────────

/**
 * Get escrows for a user (buyer, seller, or arbiter)
 */
export function getUserEscrows(address: string, escrows: Escrow[]): {
  asBuyer: Escrow[]
  asSeller: Escrow[]
  asArbiter: Escrow[]
  pending: Escrow[]
  requiresAction: Escrow[]
} {
  const asBuyer = escrows.filter((e) => e.buyer === address)
  const asSeller = escrows.filter((e) => e.seller === address)
  const asArbiter = escrows.filter((e) => e.arbiter === address)
  
  const allUserEscrows = [...asBuyer, ...asSeller, ...asArbiter]
  const pending = allUserEscrows.filter((e) => e.status === "funded" || e.status === "disputed")
  
  const requiresAction = pending.filter((e) => {
    const signed = e.signatures.find((s) => s.signer === address)
    return !signed && !hasReachedConsensus(e).reached
  })

  return {
    asBuyer,
    asSeller,
    asArbiter,
    pending,
    requiresAction,
  }
}

// ── Export configuration ───────────────────────────────────────────────────

export const ESCROW_CONFIG = {
  timeoutSeconds: ESCROW_TIMEOUT_SECONDS,
  disputeWindowSeconds: DISPUTE_WINDOW_SECONDS,
  maxAmount: MAX_ESCROW_AMOUNT,
  requiredSignatures: 2,
  totalSigners: 3,
} as const

/**
 * Audit escrow settlement wiring for diagnostics
 */
export function auditEscrowSettlementWiring(): { ok: boolean; note: string } {
  try {
    const probeEscrow: CreateEscrow = {
      buyer: "G" + "A".repeat(55),
      seller: "G" + "B".repeat(55),
      arbiter: "G" + "C".repeat(55),
      amount: "10000000",
      tokenId: 1,
      collectionId: 0,
      timeoutSeconds: 86400,
    }

    const validation = validateEscrowCreation(probeEscrow)
    if (!validation.valid) {
      return { ok: false, note: `[escrow] Validation failed: ${validation.error}` }
    }

    const mockEscrow: Escrow = {
      escrowId: "test-1",
      ...probeEscrow,
      status: "funded",
      createdAt: Date.now(),
      fundedAt: Date.now(),
      completedAt: null,
      expiresAt: Date.now() + ESCROW_TIMEOUT_SECONDS * 1000,
      multisigAddress: "G" + "D".repeat(55),
      signatures: [],
    }

    const consensus = hasReachedConsensus(mockEscrow)
    if (consensus.reached) {
      return { ok: false, note: "[escrow] Consensus check failed for empty signatures" }
    }

    return {
      ok: true,
      note: `[escrow] Escrow settlement OK (2-of-3 multisig, ${ESCROW_TIMEOUT_SECONDS}s timeout)`,
    }
  } catch (e) {
    return {
      ok: false,
      note: `[escrow] Escrow settlement error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
