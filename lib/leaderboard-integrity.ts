/**
 * Leaderboard integrity: anti-farm scoring with decay and sybil discount.
 * Spike 616 / Issue #479.
 *
 * A points table is trivially gameable without three safeguards:
 *   1. Anti-farm signals — burst posting, counterparty concentration and
 *      point velocity each multiply the score down (floor at
 *      `farmPenaltyFloor`) so a campaign earns less per unit of effort than
 *      a steady participant.
 *   2. Time decay — every event's points are weighted by an exponential
 *      half-life (`0.5 ** (age / halfLifeMs)`, same shape as the pricing
 *      oracle's wash discount), so stale activity cannot pin a wallet to the
 *      top of the table forever.
 *   3. Sybil discount — the caller supplies the band from
 *      `lib/sybil-resistance.ts:scoreWalletHistory`; suspect wallets keep a
 *      fixed fraction of their points. A missing band is treated as
 *      `caution` so an unscored wallet never gets trusted-rate points.
 *
 * All scoring is pure and deterministic (given `now`), so the leaderboard
 * route and tests share one code path. Flag: phase-178.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_178 / FEATURE_PHASE_178 — routes
 * 404 and no persisted state is required to revert.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

export const LEADERBOARD_SCHEMA_VERSION = "1.0.0"

export function isLeaderboardIntegrityEnabled(): boolean {
  return isFeatureEnabled("phase-178")
}

export function leaderboard178RollbackNote(): string {
  return "Rollback phase-178: unset NEXT_PUBLIC_FEATURE_PHASE_178 / FEATURE_PHASE_178 or set 0/false and restart. leaderboard-entries.json stays inert."
}

export type SybilBand = "trusted" | "caution" | "suspect"

export type LeaderboardEvent = {
  points: number
  at: number
  counterparty?: string
}

export type LeaderboardCandidate = {
  wallet: string
  events: LeaderboardEvent[]
  sybilBand?: SybilBand
}

export const LEADERBOARD_DEFAULTS = {
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,
  burstWindowMs: 60 * 60 * 1000,
  burstMaxEvents: 12,
  maxCounterpartyShare: 0.8,
  minConcentrationEvents: 6,
  velocityMaxPointsPerDay: 1000,
  farmPenaltyFloor: 0.15,
} as const

export const SYBIL_BAND_DISCOUNT: Record<SybilBand, number> = {
  trusted: 1,
  caution: 0.7,
  suspect: 0.35,
}

/** No band supplied means unknown — unknown wallets never score at trusted rate. */
export const UNKNOWN_SYBIL_BAND: SybilBand = "caution"

export type LeaderboardIntegrityOptions = Partial<typeof LEADERBOARD_DEFAULTS>

export class LeaderboardIntegrityError extends Error {
  readonly code: "FLAG_DISABLED" | "VALIDATION_FAILED"
  readonly details?: unknown
  constructor(code: LeaderboardIntegrityError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "LeaderboardIntegrityError"
    this.code = code
    this.details = details
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Exponential half-life decay: 1 at age 0, 0.5 at one half-life, → 0. */
export function decayFactor(ageMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 1
  const age = Math.max(0, ageMs)
  return Math.pow(0.5, age / halfLifeMs)
}

export type FarmDetection = {
  signals: string[]
  penalty: number
  farmed: boolean
}

/**
 * Pure farm-pattern detector. Each matched rule multiplies the penalty
 * (`burst` ×0.5, `concentration` ×0.6, `velocity` ×0.7), floored so a wallet
 * is never zeroed out — the goal is to compress campaign ROI, not to make a
 * single rule irreversible.
 */
export function detectFarmPatterns(
  candidate: Pick<LeaderboardCandidate, "events">,
  opts: LeaderboardIntegrityOptions = {},
): FarmDetection {
  const o = { ...LEADERBOARD_DEFAULTS, ...opts }
  const events = [...candidate.events].sort((a, b) => a.at - b.at)
  const signals: string[] = []
  let penalty = 1

  if (events.length > 0) {
    let maxInWindow = 0
    for (let i = 0; i < events.length; i++) {
      let count = 0
      for (let j = i; j < events.length; j++) {
        if (events[j].at - events[i].at > o.burstWindowMs) break
        count++
      }
      if (count > maxInWindow) maxInWindow = count
    }
    if (maxInWindow > o.burstMaxEvents) {
      signals.push("event_burst")
      penalty *= 0.5
    }

    const withCounterparty = events.filter((e) => Boolean(e.counterparty))
    if (withCounterparty.length >= o.minConcentrationEvents) {
      const counts = new Map<string, number>()
      for (const e of withCounterparty) {
        const key = e.counterparty as string
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const largest = Math.max(...counts.values())
      if (largest / withCounterparty.length > o.maxCounterpartyShare) {
        signals.push("counterparty_concentration")
        penalty *= 0.6
      }
    }

    const rawPoints = events.reduce((sum, e) => sum + e.points, 0)
    const spanMs = events[events.length - 1].at - events[0].at
    const spanDays = Math.max(spanMs, 24 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000)
    if (rawPoints / spanDays > o.velocityMaxPointsPerDay) {
      signals.push("point_velocity")
      penalty *= 0.7
    }
  }

  return {
    signals,
    penalty: round2(Math.max(o.farmPenaltyFloor, penalty)),
    farmed: signals.length > 0,
  }
}

export function sybilDiscountFor(band?: SybilBand): number {
  return SYBIL_BAND_DISCOUNT[band ?? UNKNOWN_SYBIL_BAND]
}

export type LeaderboardScore = {
  wallet: string
  events: number
  rawPoints: number
  decayedPoints: number
  farmPenalty: number
  sybilDiscount: number
  finalScore: number
  signals: string[]
}

export function scoreLeaderboardCandidate(
  candidate: LeaderboardCandidate,
  opts: LeaderboardIntegrityOptions = {},
  now: number = Date.now(),
): LeaderboardScore {
  if (typeof candidate.wallet !== "string" || candidate.wallet.trim().length === 0) {
    throw new LeaderboardIntegrityError("VALIDATION_FAILED", "candidate wallet is required")
  }
  if (!Array.isArray(candidate.events)) {
    throw new LeaderboardIntegrityError("VALIDATION_FAILED", "candidate events must be an array")
  }
  const halfLifeMs = opts.halfLifeMs ?? LEADERBOARD_DEFAULTS.halfLifeMs

  let rawPoints = 0
  let decayedPoints = 0
  for (const event of candidate.events) {
    if (!Number.isFinite(event?.points) || !Number.isFinite(event?.at)) {
      throw new LeaderboardIntegrityError(
        "VALIDATION_FAILED",
        "every event needs finite points and an epoch-ms `at` timestamp",
      )
    }
    rawPoints += event.points
    decayedPoints += event.points * decayFactor(now - event.at, halfLifeMs)
  }

  const farm = detectFarmPatterns(candidate, opts)
  const sybilDiscount = sybilDiscountFor(candidate.sybilBand)

  const signals = [...farm.signals]
  const band = candidate.sybilBand ?? UNKNOWN_SYBIL_BAND
  if (sybilDiscount < 1) signals.push(`sybil_${band}`)

  return {
    wallet: candidate.wallet,
    events: candidate.events.length,
    rawPoints: round2(rawPoints),
    decayedPoints: round2(decayedPoints),
    farmPenalty: farm.penalty,
    sybilDiscount,
    finalScore: round2(decayedPoints * farm.penalty * sybilDiscount),
    signals,
  }
}

export function rankLeaderboard(
  candidates: LeaderboardCandidate[],
  opts: LeaderboardIntegrityOptions = {},
  now: number = Date.now(),
): LeaderboardScore[] {
  return candidates
    .map((candidate) => scoreLeaderboardCandidate(candidate, opts, now))
    .sort((a, b) => b.finalScore - a.finalScore || a.wallet.localeCompare(b.wallet))
}

export function topLeaderboard(
  candidates: LeaderboardCandidate[],
  limit: number,
  opts: LeaderboardIntegrityOptions = {},
  now: number = Date.now(),
): LeaderboardScore[] {
  const capped = Math.max(0, Math.min(Math.floor(limit), 200))
  return rankLeaderboard(candidates, opts, now).slice(0, capped)
}
