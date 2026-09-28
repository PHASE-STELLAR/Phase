/**
 * phase-80: Fractional-ownership listing for high-value artifacts
 * Isolated module for co-ownership of expensive NFTs
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_80 / FEATURE_PHASE_80
 * Rollback: unset flag to disable fractional ownership
 */

import { z } from "zod"

// ── Feature flag ───────────────────────────────────────────────────────────

export function isPhase80Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_80 ?? process.env.FEATURE_PHASE_80 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag80RollbackNote(): string {
  return "Rollback phase-80: unset NEXT_PUBLIC_FEATURE_PHASE_80 / FEATURE_PHASE_80 or set to 0/false. Fractional ownership disabled."
}

// ── Configuration ──────────────────────────────────────────────────────────

export const MIN_FRACTION_SHARES = 2
export const MAX_FRACTION_SHARES = 10000
export const MIN_SHARE_PRICE_STROOPS = "100000" // 0.01 PHASELQ
export const MIN_SHAREHOLDERS = 1
export const MAX_SHAREHOLDERS_PER_ARTIFACT = 100

// ── Type definitions ───────────────────────────────────────────────────────

export const FractionalArtifactSchema = z.object({
  artifactId: z.string().min(1).max(128),
  tokenId: z.number().int().positive(),
  collectionId: z.number().int().min(0),
  totalShares: z.number().int().min(MIN_FRACTION_SHARES).max(MAX_FRACTION_SHARES),
  sharePrice: z.string().regex(/^\d+$/), // stroops
  availableShares: z.number().int().min(0),
  shareholders: z.array(z.object({
    address: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
    shares: z.number().int().positive(),
    acquiredAt: z.number().int().positive(),
  })),
  creator: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  createdAt: z.number().int().positive(),
  status: z.enum(["listing", "fully_owned", "cancelled"]),
  metadata: z.object({
    name: z.string().max(256),
    description: z.string().max(2000),
    imageUri: z.string().url(),
  }),
})

export type FractionalArtifact = z.infer<typeof FractionalArtifactSchema>

export const CreateFractionalListingSchema = z.object({
  tokenId: z.number().int().positive(),
  collectionId: z.number().int().min(0),
  totalShares: z.number().int().min(MIN_FRACTION_SHARES).max(MAX_FRACTION_SHARES),
  sharePrice: z.string().regex(/^\d+$/),
  creator: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  metadata: z.object({
    name: z.string().min(1).max(256),
    description: z.string().max(2000),
    imageUri: z.string().url(),
  }),
})

export type CreateFractionalListing = z.infer<typeof CreateFractionalListingSchema>

export const PurchaseSharesSchema = z.object({
  artifactId: z.string().min(1).max(128),
  buyer: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  shares: z.number().int().min(1),
})

export type PurchaseShares = z.infer<typeof PurchaseSharesSchema>

// ── Error handling ─────────────────────────────────────────────────────────

export class FractionalOwnershipError extends Error {
  code:
    | "FLAG_DISABLED"
    | "VALIDATION_FAILED"
    | "INSUFFICIENT_SHARES"
    | "INVALID_SHARE_COUNT"
    | "ARTIFACT_NOT_FOUND"
    | "ALREADY_FULLY_OWNED"
    | "LISTING_CANCELLED"
    | "PRICE_TOO_LOW"
    | "TOO_MANY_SHAREHOLDERS"
  details?: unknown

  constructor(code: FractionalOwnershipError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "FractionalOwnershipError"
    this.code = code
    this.details = details
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate fractional listing creation
 */
export function validateFractionalListing(
  listing: CreateFractionalListing
): { valid: true } | { valid: false; error: string; code: string } {
  if (!isPhase80Enabled()) {
    return {
      valid: false,
      error: "Fractional ownership is disabled (phase-80 flag off)",
      code: "FLAG_DISABLED",
    }
  }

  const parsed = CreateFractionalListingSchema.safeParse(listing)
  if (!parsed.success) {
    return {
      valid: false,
      error: parsed.error.message,
      code: "VALIDATION_FAILED",
    }
  }

  // Validate share price meets minimum
  try {
    const priceBI = BigInt(listing.sharePrice)
    const minBI = BigInt(MIN_SHARE_PRICE_STROOPS)
    
    if (priceBI < minBI) {
      return {
        valid: false,
        error: `Share price ${listing.sharePrice} is below minimum ${MIN_SHARE_PRICE_STROOPS} stroops`,
        code: "PRICE_TOO_LOW",
      }
    }
  } catch {
    return {
      valid: false,
      error: "Invalid share price format",
      code: "VALIDATION_FAILED",
    }
  }

  return { valid: true }
}

/**
 * Validate share purchase
 */
export function validateSharePurchase(
  purchase: PurchaseShares,
  artifact: FractionalArtifact
): { valid: true; totalCost: string } | { valid: false; error: string; code: string } {
  if (!isPhase80Enabled()) {
    return {
      valid: false,
      error: "Fractional ownership is disabled (phase-80 flag off)",
      code: "FLAG_DISABLED",
    }
  }

  const parsed = PurchaseSharesSchema.safeParse(purchase)
  if (!parsed.success) {
    return {
      valid: false,
      error: parsed.error.message,
      code: "VALIDATION_FAILED",
    }
  }

  if (artifact.status !== "listing") {
    return {
      valid: false,
      error: `Artifact is ${artifact.status}, not available for purchase`,
      code: artifact.status === "fully_owned" ? "ALREADY_FULLY_OWNED" : "LISTING_CANCELLED",
    }
  }

  if (purchase.shares > artifact.availableShares) {
    return {
      valid: false,
      error: `Requested ${purchase.shares} shares but only ${artifact.availableShares} available`,
      code: "INSUFFICIENT_SHARES",
    }
  }

  if (purchase.shares <= 0) {
    return {
      valid: false,
      error: "Must purchase at least 1 share",
      code: "INVALID_SHARE_COUNT",
    }
  }

  // Check if adding this buyer would exceed shareholder limit
  const existingShareholder = artifact.shareholders.find((s) => s.address === purchase.buyer)
  if (!existingShareholder && artifact.shareholders.length >= MAX_SHAREHOLDERS_PER_ARTIFACT) {
    return {
      valid: false,
      error: `Maximum ${MAX_SHAREHOLDERS_PER_ARTIFACT} shareholders per artifact`,
      code: "TOO_MANY_SHAREHOLDERS",
    }
  }

  // Calculate total cost
  try {
    const priceBI = BigInt(artifact.sharePrice)
    const totalCost = (priceBI * BigInt(purchase.shares)).toString()
    return { valid: true, totalCost }
  } catch {
    return {
      valid: false,
      error: "Failed to calculate total cost",
      code: "VALIDATION_FAILED",
    }
  }
}

// ── Ownership calculations ─────────────────────────────────────────────────

/**
 * Calculate ownership percentage for a shareholder
 */
export function calculateOwnershipPercentage(shares: number, totalShares: number): string {
  if (totalShares === 0) return "0.00"
  const percentage = (shares / totalShares) * 100
  return percentage.toFixed(2)
}

/**
 * Get shareholder ownership details
 */
export function getShareholderOwnership(
  address: string,
  artifact: FractionalArtifact
): {
  address: string
  shares: number
  percentage: string
  value: string
  acquiredAt: number | null
} | null {
  const shareholder = artifact.shareholders.find((s) => s.address === address)
  if (!shareholder) return null

  const percentage = calculateOwnershipPercentage(shareholder.shares, artifact.totalShares)
  const value = (BigInt(artifact.sharePrice) * BigInt(shareholder.shares)).toString()

  return {
    address: shareholder.address,
    shares: shareholder.shares,
    percentage,
    value,
    acquiredAt: shareholder.acquiredAt,
  }
}

/**
 * Get all shareholders sorted by ownership
 */
export function getShareholdersSorted(
  artifact: FractionalArtifact
): Array<{
  address: string
  shares: number
  percentage: string
  value: string
}> {
  return artifact.shareholders
    .map((s) => ({
      address: s.address,
      shares: s.shares,
      percentage: calculateOwnershipPercentage(s.shares, artifact.totalShares),
      value: (BigInt(artifact.sharePrice) * BigInt(s.shares)).toString(),
    }))
    .sort((a, b) => b.shares - a.shares)
}

/**
 * Calculate total market value of artifact
 */
export function calculateTotalValue(artifact: FractionalArtifact): string {
  try {
    const priceBI = BigInt(artifact.sharePrice)
    const totalBI = BigInt(artifact.totalShares)
    return (priceBI * totalBI).toString()
  } catch {
    return "0"
  }
}

/**
 * Calculate raised funds from sold shares
 */
export function calculateRaisedFunds(artifact: FractionalArtifact): string {
  try {
    const priceBI = BigInt(artifact.sharePrice)
    const soldShares = artifact.totalShares - artifact.availableShares
    return (priceBI * BigInt(soldShares)).toString()
  } catch {
    return "0"
  }
}

// ── Statistics ─────────────────────────────────────────────────────────────

/**
 * Get artifact statistics
 */
export function getArtifactStatistics(artifact: FractionalArtifact): {
  totalValue: string
  raisedFunds: string
  soldShares: number
  availableShares: number
  completionPercentage: string
  shareholderCount: number
} {
  const soldShares = artifact.totalShares - artifact.availableShares
  const completionPercentage = calculateOwnershipPercentage(soldShares, artifact.totalShares)

  return {
    totalValue: calculateTotalValue(artifact),
    raisedFunds: calculateRaisedFunds(artifact),
    soldShares,
    availableShares: artifact.availableShares,
    completionPercentage,
    shareholderCount: artifact.shareholders.length,
  }
}

/**
 * Filter artifacts by status
 */
export function filterArtifactsByStatus(
  artifacts: FractionalArtifact[],
  status: FractionalArtifact["status"]
): FractionalArtifact[] {
  return artifacts.filter((a) => a.status === status)
}

/**
 * Get user's fractional holdings
 */
export function getUserFractionalHoldings(
  address: string,
  artifacts: FractionalArtifact[]
): Array<{
  artifact: FractionalArtifact
  shares: number
  percentage: string
  value: string
}> {
  return artifacts
    .map((artifact) => {
      const ownership = getShareholderOwnership(address, artifact)
      if (!ownership) return null

      return {
        artifact,
        shares: ownership.shares,
        percentage: ownership.percentage,
        value: ownership.value,
      }
    })
    .filter((h): h is NonNullable<typeof h> => h !== null)
    .sort((a, b) => parseInt(b.value) - parseInt(a.value))
}

// ── Export configuration ───────────────────────────────────────────────────

export const FRACTIONAL_OWNERSHIP_CONFIG = {
  minShares: MIN_FRACTION_SHARES,
  maxShares: MAX_FRACTION_SHARES,
  minSharePrice: MIN_SHARE_PRICE_STROOPS,
  maxShareholders: MAX_SHAREHOLDERS_PER_ARTIFACT,
  flag: "phase-80",
} as const

/**
 * Audit fractional ownership wiring for diagnostics
 */
export function auditFractionalOwnershipWiring(): { ok: boolean; note: string } {
  if (!isPhase80Enabled()) {
    return {
      ok: true,
      note: "[phase-80] Fractional ownership disabled. " + flag80RollbackNote(),
    }
  }

  try {
    const probeListing: CreateFractionalListing = {
      tokenId: 1,
      collectionId: 0,
      totalShares: 100,
      sharePrice: "10000000",
      creator: "G" + "A".repeat(55),
      metadata: {
        name: "Test Artifact",
        description: "Test fractional listing",
        imageUri: "https://example.com/image.png",
      },
    }

    const validation = validateFractionalListing(probeListing)
    if (!validation.valid) {
      return { ok: false, note: `[phase-80] Validation failed: ${validation.error}` }
    }

    return {
      ok: true,
      note: `[phase-80] Fractional ownership OK (max ${MAX_FRACTION_SHARES} shares). ` + flag80RollbackNote(),
    }
  } catch (e) {
    return {
      ok: false,
      note: `[phase-80] Fractional ownership error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
