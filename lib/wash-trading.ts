import { z } from "zod"
import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"

// ─── phase-77: wash-trading detection heuristics for listings (isolated, flag-gated) ───
// Manipulated market volume and fake wash trading distort pricing and activity indicators.
// This module provides heuristics to detect circular trading (A->B->A), rapid markup churn,
// self-trading, and artificial volume churn across NFT listing trade histories.
// Feature flag: phase-77 (NEXT_PUBLIC_FEATURE_PHASE_77 / FEATURE_PHASE_77)
// Rollback: unset flag or set to 0/false and restart; no persistent data migration to undo.

export function isPhase77Enabled(): boolean {
  return isFeatureEnabled("phase-77")
}

export function flag77RollbackNote(): string {
  return flagRollbackNote("phase-77")
}

const STELLAR_G_REGEX = /^G[A-Z2-7]{55}$/

export const TradeRecordSchema = z.object({
  tradeId: z.string().trim().min(1).max(128),
  tokenId: z.number().int().min(1).max(1_000_000),
  collectionId: z.number().int().min(0).default(0),
  sellerWallet: z.string().trim().length(56).regex(STELLAR_G_REGEX, "Invalid seller wallet"),
  buyerWallet: z.string().trim().length(56).regex(STELLAR_G_REGEX, "Invalid buyer wallet"),
  pricePhaselq: z.number().positive(),
  timestamp: z.number().int().min(0),
  txHash: z.string().trim().max(128).optional(),
})

export type TradeRecord = z.infer<typeof TradeRecordSchema>

export const WashTradeAnalysisRequestSchema = z.object({
  tokenId: z.number().int().min(1).max(1_000_000),
  collectionId: z.number().int().min(0).default(0),
  trades: z.array(TradeRecordSchema),
  windowMs: z.number().int().min(1000).max(30 * 86400000).default(86400000), // Default 24h
})

export type WashTradeAnalysisRequest = z.infer<typeof WashTradeAnalysisRequestSchema>

export const WashTradePatternSchema = z.enum([
  "circular_trade",
  "rapid_flip",
  "self_trading",
  "volume_churn",
])

export type WashTradePattern = z.infer<typeof WashTradePatternSchema>

export const WashTradeRiskAssessmentSchema = z.object({
  isSuspicious: z.boolean(),
  riskScore: z.number().min(0).max(100),
  reasons: z.array(z.string()),
  flaggedTradeIds: z.array(z.string()),
  detectedPatterns: z.array(WashTradePatternSchema),
  confidence: z.enum(["low", "medium", "high"]),
  analyzedTradesCount: z.number().int().min(0),
})

export type WashTradeRiskAssessment = z.infer<typeof WashTradeRiskAssessmentSchema>

export class WashTradingDetectionError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "INSUFFICIENT_DATA" | "ANALYSIS_FAILED"
  details?: unknown
  constructor(code: WashTradingDetectionError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "WashTradingDetectionError"
    this.code = code
    this.details = details
  }
}

/**
 * Detects circular trading (e.g. Wallet A sells to B, and B sells back to A within window).
 */
export function detectCircularTrades(trades: TradeRecord[], maxWindowMs = 86400000): { flaggedIds: string[]; details: string[] } {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const flagged = new Set<string>()
  const details: string[] = []

  for (let i = 0; i < sorted.length; i++) {
    const t1 = sorted[i]!
    for (let j = i + 1; j < sorted.length; j++) {
      const t2 = sorted[j]!
      if (t2.timestamp - t1.timestamp > maxWindowMs) break

      // Circular: A -> B followed by B -> A
      if (t1.sellerWallet === t2.buyerWallet && t1.buyerWallet === t2.sellerWallet) {
        flagged.add(t1.tradeId)
        flagged.add(t2.tradeId)
        details.push(
          `Circular trade detected between ${t1.sellerWallet.slice(0, 6)}… and ${t1.buyerWallet.slice(0, 6)}… within ${Math.round((t2.timestamp - t1.timestamp) / 1000)}s`,
        )
      }
    }
  }

  return { flaggedIds: Array.from(flagged), details }
}

/**
 * Detects rapid price markup flips (e.g. item bought and relisted/sold within 1h with >100% price surge).
 */
export function detectRapidFlips(
  trades: TradeRecord[],
  maxHoldTimeMs = 3600000,
  minMarkupRatio = 2.0,
): { flaggedIds: string[]; details: string[] } {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const flagged = new Set<string>()
  const details: string[] = []

  for (let i = 0; i < sorted.length - 1; i++) {
    const buy = sorted[i]!
    const sell = sorted[i + 1]!

    if (buy.buyerWallet === sell.sellerWallet) {
      const holdTime = sell.timestamp - buy.timestamp
      if (holdTime <= maxHoldTimeMs && sell.pricePhaselq >= buy.pricePhaselq * minMarkupRatio) {
        flagged.add(buy.tradeId)
        flagged.add(sell.tradeId)
        const markupPct = Math.round(((sell.pricePhaselq - buy.pricePhaselq) / buy.pricePhaselq) * 100)
        details.push(
          `Rapid markup flip (+${markupPct}% in ${Math.round(holdTime / 60000)}m) by wallet ${buy.buyerWallet.slice(0, 6)}…`,
        )
      }
    }
  }

  return { flaggedIds: Array.from(flagged), details }
}

/**
 * Detects direct self-trading (seller === buyer).
 */
export function detectSelfTrading(trades: TradeRecord[]): { flaggedIds: string[]; details: string[] } {
  const flagged = new Set<string>()
  const details: string[] = []

  for (const t of trades) {
    if (t.sellerWallet.toUpperCase() === t.buyerWallet.toUpperCase()) {
      flagged.add(t.tradeId)
      details.push(`Self-trade detected on trade ${t.tradeId} by wallet ${t.sellerWallet.slice(0, 6)}…`)
    }
  }

  return { flaggedIds: Array.from(flagged), details }
}

/**
 * Analyzes an NFT trade history and computes a comprehensive wash-trading risk assessment.
 */
export function analyzeWashTradingRisk(
  input: unknown,
  opts: { force?: boolean } = {},
): WashTradeRiskAssessment {
  const enabled = opts.force || isPhase77Enabled()
  if (!enabled) {
    throw new WashTradingDetectionError("FLAG_DISABLED", "Wash-trading detection disabled (phase-77 flag off)")
  }

  const parsed = WashTradeAnalysisRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new WashTradingDetectionError("VALIDATION_FAILED", "Invalid wash trade analysis payload", parsed.error.flatten())
  }

  const { trades, windowMs } = parsed.data
  if (trades.length === 0) {
    return {
      isSuspicious: false,
      riskScore: 0,
      reasons: ["No trade history to analyze."],
      flaggedTradeIds: [],
      detectedPatterns: [],
      confidence: "low",
      analyzedTradesCount: 0,
    }
  }

  const patterns = new Set<WashTradePattern>()
  const allFlagged = new Set<string>()
  const allReasons: string[] = []

  // 1. Check self trading
  const selfTradeRes = detectSelfTrading(trades)
  if (selfTradeRes.flaggedIds.length > 0) {
    patterns.add("self_trading")
    selfTradeRes.flaggedIds.forEach((id) => allFlagged.add(id))
    allReasons.push(...selfTradeRes.details)
  }

  // 2. Check circular trades
  const circularRes = detectCircularTrades(trades, windowMs)
  if (circularRes.flaggedIds.length > 0) {
    patterns.add("circular_trade")
    circularRes.flaggedIds.forEach((id) => allFlagged.add(id))
    allReasons.push(...circularRes.details)
  }

  // 3. Check rapid markup flips
  const flipRes = detectRapidFlips(trades)
  if (flipRes.flaggedIds.length > 0) {
    patterns.add("rapid_flip")
    flipRes.flaggedIds.forEach((id) => allFlagged.add(id))
    allReasons.push(...flipRes.details)
  }

  // 4. Volume churn heuristic: multiple trades (>3) between a small set of wallets (<=2 wallets)
  const uniqueWallets = new Set(trades.flatMap((t) => [t.sellerWallet, t.buyerWallet]))
  if (trades.length >= 3 && uniqueWallets.size <= 2) {
    patterns.add("volume_churn")
    trades.forEach((t) => allFlagged.add(t.tradeId))
    allReasons.push(`Volume churn: ${trades.length} trades concentrated between only ${uniqueWallets.size} distinct wallets.`)
  }

  // Calculate score (0-100)
  let score = 0
  if (patterns.has("self_trading")) score += 50
  if (patterns.has("circular_trade")) score += 35
  if (patterns.has("volume_churn")) score += 30
  if (patterns.has("rapid_flip")) score += 20

  const flaggedRatio = trades.length > 0 ? allFlagged.size / trades.length : 0
  score = Math.min(100, Math.round(score * 0.7 + flaggedRatio * 100 * 0.3))

  const isSuspicious = score >= 40
  const confidence: WashTradeRiskAssessment["confidence"] =
    trades.length >= 5 ? "high" : trades.length >= 2 ? "medium" : "low"

  return {
    isSuspicious,
    riskScore: score,
    reasons: allReasons.length > 0 ? allReasons : ["Trade volume appears organic."],
    flaggedTradeIds: Array.from(allFlagged),
    detectedPatterns: Array.from(patterns),
    confidence,
    analyzedTradesCount: trades.length,
  }
}

export function auditWashTradingWiring(): { ok: boolean; note: string } {
  if (!isPhase77Enabled()) {
    return { ok: true, note: "[phase-77] wash-trading detection disabled; nothing to audit." }
  }
  try {
    const probe = analyzeWashTradingRisk(
      {
        tokenId: 1,
        collectionId: 0,
        trades: [
          {
            tradeId: "t1",
            tokenId: 1,
            collectionId: 0,
            sellerWallet: "G" + "A".repeat(55),
            buyerWallet: "G" + "B".repeat(55),
            pricePhaselq: 100,
            timestamp: 1000,
          },
          {
            tradeId: "t2",
            tokenId: 1,
            collectionId: 0,
            sellerWallet: "G" + "B".repeat(55),
            buyerWallet: "G" + "A".repeat(55),
            pricePhaselq: 100,
            timestamp: 2000,
          },
        ],
      },
      { force: true },
    )
    if (probe.detectedPatterns.includes("circular_trade")) {
      return { ok: true, note: `[phase-77] wash-trading heuristics OK (risk score: ${probe.riskScore}). ${flag77RollbackNote()}` }
    }
    return { ok: false, note: "[phase-77] probe failed to detect circular pattern." }
  } catch (e) {
    return { ok: false, note: `[phase-77] audit error: ${e instanceof Error ? e.message : String(e)}` }
  }
}
