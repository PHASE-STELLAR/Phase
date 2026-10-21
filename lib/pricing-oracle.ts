/**
 * Pricing oracle — phase-143
 *
 * Suggests a list price before a seller lists, from comparable sales, and
 * records what the seller then did so the suggestion can be measured.
 *
 * Comps are accepted offers (the only agreed prices this market records; see
 * getSaleComps). Each comp is weighted by:
 *
 *   recency     0.5^(age / HALF_LIFE)
 *   wash        washCompWeight: 0 if flagged, halved per repeat trade between
 *               the same two wallets
 *   self        0 if the requesting seller was either side — your own sales
 *               may not move your own suggestion (the pumping attack)
 *   outlier     0 if outside [median / OUTLIER_FACTOR, median × OUTLIER_FACTOR]
 *
 * and the suggestion is the weighted median, with the weighted p25/p75 as the
 * band. Thin markets fall back token → collection → global; a level is used
 * only when it has MIN_COMPS surviving comps. A live non-wash bid above the
 * median floors the suggestion: never suggest listing below what someone has
 * already offered. Trait-level comps are not attempted — sold listings carry
 * no attribute snapshot, see docs/spikes/143-pricing-oracle.md.
 *
 * The model, when available, only rephrases the deterministic rationale; its
 * reply is discarded unless every offer id it cites and every number it writes
 * is in the data it was given.
 *
 * Feature flag: phase-143. Rollback: unset → the suggestion route 404s, the
 * listing POST ignores `suggestion_id`; `price_suggestions` rows are inert.
 */

import { createHash, randomUUID } from "node:crypto"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getDb } from "@/lib/sqlite-db"
import { incSecurityCounter } from "@/lib/security-counters"
import { chargeAiStep } from "@/lib/cost-attribution-ledger"
import { fillCopy, pickCopy } from "@/lib/phase-copy"
import { buildPriceRationalePrompt } from "@/lib/forge/prompt-builder"
import { generateJsonStep, type AiJsonGenerator } from "@/lib/forge/ai-pipeline"
import { washCompWeight } from "@/lib/wash-screening"
import { computeRoyaltySplit, type SaleComp } from "@/lib/market-store"

export function isPricingOracleEnabled(): boolean {
  return isFeatureEnabled("phase-143")
}

const DAY_MS = 24 * 3_600_000

export const PRICING = {
  HALF_LIFE_MS: 14 * DAY_MS,
  LOOKBACK_MS: 180 * DAY_MS,
  MIN_COMPS: 3,
  OUTLIER_FACTOR: 4,
  /** A listing within ±2% of the suggestion counts as accepting it. */
  ACCEPT_TOLERANCE: 0.02,
  /** Listing more than 3× p75 or under p25/3 returns a warning (never a block). */
  WARN_FACTOR: 3,
  SUGGESTION_TTL_MS: DAY_MS,
  MAX_CITED: 5,
} as const

export type CompLevel = "token" | "collection" | "global"
export type ExperimentArm = "treatment" | "control"

export type WeightedComp = SaleComp & { weight: number }

export type CompWeighing = {
  used: WeightedComp[]
  washExcluded: number
  washDiscounted: number
  selfExcluded: number
  outliersDropped: number
}

// ── pure ────────────────────────────────────────────────────────────────────

/** Weighted quantile (q ∈ [0,1]) by cumulative weight; values need not be sorted. */
export function weightedQuantile(points: ReadonlyArray<{ value: number; weight: number }>, q: number): number {
  const sorted = points.filter((p) => p.weight > 0).sort((a, b) => a.value - b.value)
  if (sorted.length === 0) return Number.NaN
  const total = sorted.reduce((s, p) => s + p.weight, 0)
  const target = q * total
  let acc = 0
  for (const p of sorted) {
    acc += p.weight
    if (acc >= target) return p.value
  }
  return sorted[sorted.length - 1]!.value
}

export function weighComps(comps: readonly SaleComp[], opts: { now: number; sellerWallet: string }): CompWeighing {
  const seller = opts.sellerWallet.toUpperCase()
  const pairKey = (c: SaleComp) => [c.seller_wallet.toUpperCase(), c.buyer_wallet.toUpperCase()].sort().join(":")
  const pairCounts = new Map<string, number>()
  for (const c of comps) pairCounts.set(pairKey(c), (pairCounts.get(pairKey(c)) ?? 0) + 1)

  let washExcluded = 0
  let washDiscounted = 0
  let selfExcluded = 0
  const candidates: WeightedComp[] = []
  for (const c of comps) {
    if (c.seller_wallet.toUpperCase() === seller || c.buyer_wallet.toUpperCase() === seller) {
      selfExcluded++
      continue
    }
    const wash = washCompWeight({ washFlagged: c.wash_flagged, repeatPairCount: pairCounts.get(pairKey(c)) ?? 1 })
    if (wash === 0) {
      washExcluded++
      continue
    }
    if (wash < 1) washDiscounted++
    const age = Math.max(0, opts.now - c.sold_at)
    candidates.push({ ...c, weight: wash * 0.5 ** (age / PRICING.HALF_LIFE_MS) })
  }

  const median = weightedQuantile(candidates.map((c) => ({ value: c.amount_phaselq, weight: c.weight })), 0.5)
  const used = Number.isFinite(median)
    ? candidates.filter((c) => c.amount_phaselq >= median / PRICING.OUTLIER_FACTOR && c.amount_phaselq <= median * PRICING.OUTLIER_FACTOR)
    : []
  return { used, washExcluded, washDiscounted, selfExcluded, outliersDropped: candidates.length - used.length }
}

/** Deterministic arm from the seller wallet, so a seller never flips arms. */
export function assignArm(sellerWallet: string, controlPct: number): ExperimentArm {
  const pct = Math.min(100, Math.max(0, Math.floor(controlPct)))
  const bucket = parseInt(createHash("sha256").update(sellerWallet.toUpperCase()).digest("hex").slice(0, 8), 16) % 100
  return bucket < pct ? "control" : "treatment"
}

function controlPct(): number {
  const n = Number(process.env.PHASE_PRICING_CONTROL_PCT)
  return Number.isFinite(n) ? n : 10
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * A model summary is grounded only if every offer id it cites is a used comp
 * and every number it writes is one it was given (amounts, band, counts, ages).
 */
export function rationaleIsGrounded(
  reply: unknown,
  allowedIds: ReadonlySet<string>,
  allowedNumbers: readonly number[],
): reply is { summary: string; cited_offer_ids: string[] } {
  if (!reply || typeof reply !== "object") return false
  const r = reply as { summary?: unknown; cited_offer_ids?: unknown }
  if (typeof r.summary !== "string" || !r.summary.trim() || r.summary.length > 320) return false
  if (!Array.isArray(r.cited_offer_ids) || !r.cited_offer_ids.every((id) => typeof id === "string" && allowedIds.has(id))) return false
  const allowed = new Set(allowedNumbers.map(round))
  const written = [...r.summary.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => round(Number(m[0].replace(",", "."))))
  return written.every((n) => allowed.has(n))
}

// ── orchestration ───────────────────────────────────────────────────────────

export type SuggestInput = {
  sellerWallet: string
  collectionId: number
  tokenId?: number
  royaltyBps?: number
  creatorWallet?: string
  lang: "en" | "es"
}

export type SuggestDeps = {
  comps: (scope: { collection_id?: number; token_id?: number }, since: number) => SaleComp[]
  liveBids: (collectionId: number, now: number) => Array<{ offer_id: string; amount_phaselq: number }>
  generate?: AiJsonGenerator
  now?: number
}

export type PriceSuggestion = {
  suggestion_id: string
  arm: ExperimentArm
  level: CompLevel
  suggested_phaselq: number
  band: { p25_phaselq: number; p75_phaselq: number }
  floored_by_bid: boolean
  net_proceeds: { royalty_bps: number; royalty_phaselq: number; seller_phaselq: number }
  comps: Array<{ offer_id: string; listing_id: string; amount_phaselq: number; days_ago: number; weight: number }>
  excluded: { wash: number; self: number; outliers: number; wash_discounted: number }
  rationale: string
  rationale_source: "model" | "template"
  expires_at: number
}

export type SuggestResult =
  | { ok: true; suggestion: PriceSuggestion | null; arm: ExperimentArm; suggestion_id: string }
  | { ok: false; code: "INSUFFICIENT_COMPS"; message: string }

export async function suggestListPrice(input: SuggestInput, deps: SuggestDeps): Promise<SuggestResult> {
  const now = deps.now ?? Date.now()
  const since = now - PRICING.LOOKBACK_MS
  const copy = pickCopy(input.lang).pricing
  incSecurityCounter("pricing_suggestions_total")

  const levels: Array<[CompLevel, { collection_id?: number; token_id?: number }]> = [
    ["collection", { collection_id: input.collectionId }],
    ["global", {}],
  ]
  if (input.tokenId !== undefined) levels.unshift(["token", { collection_id: input.collectionId, token_id: input.tokenId }])

  let chosen: { level: CompLevel; weighing: CompWeighing } | null = null
  for (const [level, scope] of levels) {
    const weighing = weighComps(deps.comps(scope, since), { now, sellerWallet: input.sellerWallet })
    if (weighing.used.length >= PRICING.MIN_COMPS) {
      chosen = { level, weighing }
      break
    }
  }
  if (!chosen) {
    incSecurityCounter("pricing_insufficient_comps")
    return { ok: false, code: "INSUFFICIENT_COMPS", message: copy.insufficient }
  }

  const { level, weighing } = chosen
  if (weighing.washExcluded + weighing.washDiscounted > 0) incSecurityCounter("pricing_wash_comps_discounted", weighing.washExcluded + weighing.washDiscounted)
  if (weighing.selfExcluded > 0) incSecurityCounter("pricing_self_comps_excluded", weighing.selfExcluded)
  if (weighing.outliersDropped > 0) incSecurityCounter("pricing_outlier_comps_dropped", weighing.outliersDropped)

  const points = weighing.used.map((c) => ({ value: c.amount_phaselq, weight: c.weight }))
  const median = round(weightedQuantile(points, 0.5))
  const p25 = round(weightedQuantile(points, 0.25))
  const p75 = round(weightedQuantile(points, 0.75))
  const bestBid = deps.liveBids(input.collectionId, now).find((b) => b.amount_phaselq > 0)
  const flooredByBid = level !== "global" && !!bestBid && bestBid.amount_phaselq > median
  const suggested = flooredByBid ? round(bestBid!.amount_phaselq) : median

  const split = computeRoyaltySplit(
    { seller_wallet: input.sellerWallet, creator_wallet: input.creatorWallet, royalty_bps: input.royaltyBps },
    suggested,
  )

  const cited = [...weighing.used].sort((a, b) => b.weight - a.weight).slice(0, PRICING.MAX_CITED)
  const compsOut = cited.map((c) => ({
    offer_id: c.offer_id,
    listing_id: c.listing_id,
    amount_phaselq: c.amount_phaselq,
    days_ago: Math.floor((now - c.sold_at) / DAY_MS),
    weight: Number(c.weight.toFixed(4)),
  }))

  const notes = [
    fillCopy(copy.rationaleFallback, { count: weighing.used.length, scope: copy.levels[level], median }),
    weighing.washExcluded > 0 ? fillCopy(copy.washNote, { count: weighing.washExcluded }) : "",
    weighing.selfExcluded > 0 ? fillCopy(copy.selfSalesNote, { count: weighing.selfExcluded }) : "",
  ].filter(Boolean)
  let rationale = notes.join(" ")
  let rationaleSource: PriceSuggestion["rationale_source"] = "template"

  const arm = assignArm(input.sellerWallet, controlPct())
  const suggestionId = randomUUID()

  if (arm === "treatment") {
    const prompt = buildPriceRationalePrompt({ lang: input.lang, level, suggested, p25, p75, comps: compsOut })
    try {
      const reply = await (deps.generate ?? generateJsonStep)({ prompt })
      chargeAiStep(`pricing:${suggestionId}`, "pricing.rationale", prompt.length, reply.outputChars)
      const allowedNumbers = [
        suggested, median, p25, p75, weighing.used.length, weighing.washExcluded, weighing.selfExcluded,
        ...compsOut.flatMap((c) => [c.amount_phaselq, c.days_ago]),
      ]
      if (rationaleIsGrounded(reply.json, new Set(compsOut.map((c) => c.offer_id)), allowedNumbers)) {
        rationale = reply.json.summary.trim()
        rationaleSource = "model"
      } else {
        incSecurityCounter("pricing_citation_rejected")
      }
    } catch {
      // Template rationale is already grounded.
    }
  }

  getDb()
    .prepare(
      `INSERT INTO price_suggestions
         (id, seller_wallet, collection_id, token_id, arm, level, suggested_phaselq,
          p25_phaselq, p75_phaselq, comp_ids_json, effective_comps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      suggestionId,
      input.sellerWallet.toUpperCase(),
      input.collectionId,
      input.tokenId ?? null,
      arm,
      level,
      suggested,
      p25,
      p75,
      JSON.stringify(weighing.used.map((c) => c.offer_id)),
      Number(weighing.used.reduce((s, c) => s + c.weight, 0).toFixed(4)),
      now,
    )

  // The control arm is measured but never shown a number.
  if (arm === "control") return { ok: true, suggestion: null, arm, suggestion_id: suggestionId }

  return {
    ok: true,
    arm,
    suggestion_id: suggestionId,
    suggestion: {
      suggestion_id: suggestionId,
      arm,
      level,
      suggested_phaselq: suggested,
      band: { p25_phaselq: p25, p75_phaselq: p75 },
      floored_by_bid: flooredByBid,
      net_proceeds: {
        royalty_bps: split.royalty_bps,
        royalty_phaselq: split.royalty_amount_phaselq,
        seller_phaselq: round(split.seller_amount_phaselq),
      },
      comps: compsOut,
      excluded: {
        wash: weighing.washExcluded,
        self: weighing.selfExcluded,
        outliers: weighing.outliersDropped,
        wash_discounted: weighing.washDiscounted,
      },
      rationale,
      rationale_source: rationaleSource,
      expires_at: now + PRICING.SUGGESTION_TTL_MS,
    },
  }
}

// ── outcome tracking ────────────────────────────────────────────────────────

export type SuggestionOutcome = "accepted" | "adjusted_up" | "adjusted_down" | "control_listed"

export type RecordOutcomeResult =
  | { recorded: true; outcome: SuggestionOutcome }
  | { recorded: false; reason: "NOT_FOUND" | "EXPIRED" | "ALREADY_RECORDED" | "MISMATCH" }

type SuggestionRow = {
  id: string
  seller_wallet: string
  collection_id: number
  arm: ExperimentArm
  suggested_phaselq: number | null
  created_at: number
  outcome: string | null
  listing_id: string | null
}

export function classifyOutcome(arm: ExperimentArm, suggested: number, listed: number): SuggestionOutcome {
  if (arm === "control") return "control_listed"
  const delta = (listed - suggested) / suggested
  if (Math.abs(delta) <= PRICING.ACCEPT_TOLERANCE) return "accepted"
  return delta > 0 ? "adjusted_up" : "adjusted_down"
}

/**
 * Record what the seller listed at, once. The write is a conditional UPDATE
 * (`outcome IS NULL`), the same claim-once shape as the settlement replay
 * guard, so a retried listing POST cannot record a second outcome. A replay
 * for the same listing is reported as ALREADY_RECORDED, not an error.
 */
export function recordSuggestionOutcome(input: {
  suggestionId: string
  sellerWallet: string
  collectionId: number
  listingId: string
  listedPrice: number
  now?: number
}): RecordOutcomeResult {
  const now = input.now ?? Date.now()
  const db = getDb()
  const row = db.prepare("SELECT * FROM price_suggestions WHERE id = ?").get(input.suggestionId) as SuggestionRow | undefined
  if (!row) return { recorded: false, reason: "NOT_FOUND" }
  if (row.seller_wallet !== input.sellerWallet.toUpperCase() || row.collection_id !== input.collectionId) {
    return { recorded: false, reason: "MISMATCH" }
  }
  if (row.outcome) {
    incSecurityCounter("pricing_outcome_replay")
    return { recorded: false, reason: "ALREADY_RECORDED" }
  }
  if (now - row.created_at > PRICING.SUGGESTION_TTL_MS) return { recorded: false, reason: "EXPIRED" }

  const outcome = classifyOutcome(row.arm, row.suggested_phaselq ?? input.listedPrice, input.listedPrice)
  const result = db
    .prepare(
      `UPDATE price_suggestions SET outcome = ?, listing_id = ?, listed_price = ?, outcome_at = ?
        WHERE id = ? AND outcome IS NULL`,
    )
    .run(outcome, input.listingId, input.listedPrice, now, input.suggestionId)
  if (Number(result.changes) !== 1) {
    incSecurityCounter("pricing_outcome_replay")
    return { recorded: false, reason: "ALREADY_RECORDED" }
  }
  incSecurityCounter("pricing_outcome_recorded")
  return { recorded: true, outcome }
}

/** Time-to-sale: stamped once when the suggested listing sells. */
export function markSuggestionSold(listingId: string, now: number = Date.now()): boolean {
  const result = getDb()
    .prepare("UPDATE price_suggestions SET sold_at = ? WHERE listing_id = ? AND sold_at IS NULL")
    .run(now, listingId)
  return Number(result.changes) > 0
}

/** Advisory warning when a listing sits far outside the latest band. Never blocks. */
export function priceWarningFor(
  listedPrice: number,
  band: { p25_phaselq: number; p75_phaselq: number },
  lang: "en" | "es",
): string | null {
  const copy = pickCopy(lang).pricing
  if (listedPrice > band.p75_phaselq * PRICING.WARN_FACTOR) return fillCopy(copy.priceWarningHigh, { high: band.p75_phaselq })
  if (listedPrice < band.p25_phaselq / PRICING.WARN_FACTOR) return fillCopy(copy.priceWarningLow, { low: band.p25_phaselq })
  return null
}

export function getSuggestionBand(suggestionId: string): { p25_phaselq: number; p75_phaselq: number } | null {
  const row = getDb()
    .prepare("SELECT p25_phaselq, p75_phaselq FROM price_suggestions WHERE id = ?")
    .get(suggestionId) as { p25_phaselq: number | null; p75_phaselq: number | null } | undefined
  return row && row.p25_phaselq != null && row.p75_phaselq != null ? { p25_phaselq: row.p25_phaselq, p75_phaselq: row.p75_phaselq } : null
}

export type ArmStats = {
  arm: ExperimentArm
  suggestions: number
  listed: number
  accepted: number
  accept_rate: number | null
  sold: number
  median_time_to_sale_ms: number | null
}

/** A/B readout: accept rate (treatment only) and time from listing to sale per arm. */
export function getPricingExperimentStats(since = 0): ArmStats[] {
  const db = getDb()
  return (["treatment", "control"] as const).map((arm) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS suggestions,
                SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS listed,
                SUM(CASE WHEN outcome = 'accepted' THEN 1 ELSE 0 END) AS accepted,
                SUM(CASE WHEN sold_at IS NOT NULL THEN 1 ELSE 0 END) AS sold
           FROM price_suggestions WHERE arm = ? AND created_at >= ?`,
      )
      .get(arm, since) as { suggestions: number; listed: number | null; accepted: number | null; sold: number | null }
    const durations = (
      db
        .prepare(
          `SELECT sold_at - outcome_at AS d FROM price_suggestions
            WHERE arm = ? AND created_at >= ? AND sold_at IS NOT NULL AND outcome_at IS NOT NULL ORDER BY d`,
        )
        .all(arm, since) as Array<{ d: number }>
    ).map((r) => r.d)
    const listed = Number(counts.listed ?? 0)
    const accepted = Number(counts.accepted ?? 0)
    return {
      arm,
      suggestions: Number(counts.suggestions ?? 0),
      listed,
      accepted,
      accept_rate: arm === "treatment" && listed > 0 ? Number((accepted / listed).toFixed(4)) : null,
      sold: Number(counts.sold ?? 0),
      median_time_to_sale_ms: durations.length ? durations[Math.floor(durations.length / 2)]! : null,
    }
  })
}

/**
 * Seller-agnostic collection band for the offer book: the same weighing as a
 * suggestion (wash, recency, outliers) but with no self-exclusion, and no row
 * written. Null when the collection has fewer than MIN_COMPS surviving comps.
 */
export function getCollectionPriceBand(
  comps: readonly SaleComp[],
  now: number = Date.now(),
): { median_phaselq: number; p25_phaselq: number; p75_phaselq: number; comps: number; wash_excluded: number } | null {
  const weighing = weighComps(comps, { now, sellerWallet: "" })
  if (weighing.used.length < PRICING.MIN_COMPS) return null
  const points = weighing.used.map((c) => ({ value: c.amount_phaselq, weight: c.weight }))
  return {
    median_phaselq: round(weightedQuantile(points, 0.5)),
    p25_phaselq: round(weightedQuantile(points, 0.25)),
    p75_phaselq: round(weightedQuantile(points, 0.75)),
    comps: weighing.used.length,
    wash_excluded: weighing.washExcluded,
  }
}
