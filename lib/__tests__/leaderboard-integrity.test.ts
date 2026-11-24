import { describe, it, beforeEach, afterEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  decayFactor,
  detectFarmPatterns,
  isLeaderboardIntegrityEnabled,
  leaderboard178RollbackNote,
  rankLeaderboard,
  scoreLeaderboardCandidate,
  sybilDiscountFor,
  topLeaderboard,
  LeaderboardIntegrityError,
  LEADERBOARD_DEFAULTS,
  SYBIL_BAND_DISCOUNT,
  type LeaderboardCandidate,
} from "@/lib/leaderboard-integrity"

const NOW = Date.parse("2026-06-01T00:00:00.000Z")
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WALLET = `G${"A".repeat(55)}`
const WHALE = `G${"B".repeat(55)}`
const OTHER_CP = `G${"C".repeat(55)}`

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_178 = "1"
    process.env.FEATURE_PHASE_178 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_178
    delete process.env.FEATURE_PHASE_178
  }
}

function candidate(over: Partial<LeaderboardCandidate> = {}): LeaderboardCandidate {
  return {
    wallet: WALLET,
    events: [{ points: 10, at: NOW }],
    ...over,
  }
}

describe("phase-178 leaderboard integrity", () => {
  beforeEach(() => enable(true))
  afterEach(() => enable(false))

  it("gates on the feature flag and ships a rollback note", () => {
    assert.equal(isLeaderboardIntegrityEnabled(), true)
    enable(false)
    assert.equal(isLeaderboardIntegrityEnabled(), false)
    assert.match(leaderboard178RollbackNote(), /phase-178/)
  })

  it("applies exponential half-life decay", () => {
    const halfLife = LEADERBOARD_DEFAULTS.halfLifeMs
    assert.equal(decayFactor(0, halfLife), 1)
    assert.equal(decayFactor(halfLife, halfLife), 0.5)
    assert.equal(decayFactor(2 * halfLife, halfLife), 0.25)
    // Negative ages (clock skew) clamp to fresh, never boost.
    assert.equal(decayFactor(-DAY, halfLife), 1)
  })

  it("discounts sybil bands and treats a missing band as caution", () => {
    assert.equal(sybilDiscountFor("trusted"), 1)
    assert.equal(sybilDiscountFor("caution"), 0.7)
    assert.equal(sybilDiscountFor("suspect"), 0.35)
    assert.equal(sybilDiscountFor(undefined), SYBIL_BAND_DISCOUNT.caution)
  })

  it("flags a burst of events inside one window", () => {
    const events = Array.from({ length: 13 }, (_, i) => ({ points: 1, at: NOW - 30 * 60 * 1000 + i * 1000 }))
    const farm = detectFarmPatterns({ events })
    assert.ok(farm.signals.includes("event_burst"))
    assert.equal(farm.farmed, true)
    assert.equal(farm.penalty, 0.5)
  })

  it("flags counterparty concentration when one wallet dominates", () => {
    const events = Array.from({ length: 8 }, (_, i) => ({
      points: 5,
      at: NOW - (i + 1) * 6 * HOUR,
      counterparty: i < 7 ? WHALE : OTHER_CP,
    }))
    const farm = detectFarmPatterns({ events })
    assert.ok(farm.signals.includes("counterparty_concentration"))
    assert.equal(farm.penalty, 0.6)
  })

  it("flags point velocity over the per-day cap", () => {
    const events = [
      { points: 800, at: NOW - 2 * DAY },
      { points: 800, at: NOW - DAY },
      { points: 800, at: NOW },
    ]
    const farm = detectFarmPatterns({ events })
    assert.ok(farm.signals.includes("point_velocity"))
    assert.equal(farm.penalty, 0.7)
  })

  it("floors the combined farm penalty", () => {
    const events = [
      ...Array.from({ length: 13 }, (_, i) => ({ points: 100, at: NOW - 30 * 60 * 1000 + i * 1000 })),
      ...Array.from({ length: 13 }, (_, i) => ({ points: 100, at: NOW - 40 * 60 * 1000 + i * 1000 })),
    ]
    const farm = detectFarmPatterns({ events }, { farmPenaltyFloor: 0.9 })
    assert.ok(farm.signals.includes("event_burst"))
    assert.equal(farm.penalty, 0.9)
  })

  it("scores decay, farm penalty and sybil discount multiplicatively", () => {
    const score = scoreLeaderboardCandidate(
      candidate({
        events: [
          { points: 50, at: NOW },
          { points: 50, at: NOW - LEADERBOARD_DEFAULTS.halfLifeMs },
        ],
        sybilBand: "trusted",
      }),
      {},
      NOW,
    )
    assert.equal(score.rawPoints, 100)
    assert.equal(score.decayedPoints, 75)
    assert.equal(score.farmPenalty, 1)
    assert.equal(score.sybilDiscount, 1)
    assert.equal(score.finalScore, 75)

    const suspect = scoreLeaderboardCandidate(
      candidate({
        events: [
          { points: 50, at: NOW },
          { points: 50, at: NOW - LEADERBOARD_DEFAULTS.halfLifeMs },
        ],
        sybilBand: "suspect",
      }),
      {},
      NOW,
    )
    assert.equal(suspect.finalScore, 26.25)
    assert.ok(suspect.signals.includes("sybil_suspect"))

    const unknownBand = scoreLeaderboardCandidate(candidate(), {}, NOW)
    assert.equal(unknownBand.sybilDiscount, 0.7)
    assert.ok(unknownBand.signals.includes("sybil_caution"))
  })

  it("multiplies farm penalty with the sybil discount", () => {
    const events = Array.from({ length: 20 }, () => ({ points: 1, at: NOW }))
    const score = scoreLeaderboardCandidate(candidate({ events, sybilBand: "suspect" }), {}, NOW)
    assert.equal(score.farmPenalty, 0.5)
    assert.equal(score.sybilDiscount, 0.35)
    assert.equal(score.finalScore, 3.5)
    assert.ok(score.signals.includes("event_burst"))
    assert.ok(score.signals.includes("sybil_suspect"))
  })

  it("ranks descending with a stable wallet tie-break and caps the top list", () => {
    const a = candidate({ wallet: "GAAAA", events: [{ points: 10, at: NOW }] })
    const b = candidate({ wallet: "GBBBB", events: [{ points: 10, at: NOW }] })
    const c = candidate({ wallet: "GCCCC", events: [{ points: 100, at: NOW }] })
    const ranked = rankLeaderboard([a, b, c], {}, NOW)
    assert.deepEqual(ranked.map((s) => s.wallet), ["GCCCC", "GAAAA", "GBBBB"])
    assert.equal(topLeaderboard([a, b, c], 2, {}, NOW).length, 2)
    assert.equal(topLeaderboard([a, b, c], 999, {}, NOW).length, 3)
  })

  it("rejects malformed candidates instead of guessing", () => {
    assert.throws(
      () => scoreLeaderboardCandidate(candidate({ wallet: "" })),
      (err: unknown) => err instanceof LeaderboardIntegrityError && err.code === "VALIDATION_FAILED",
    )
    assert.throws(
      () => scoreLeaderboardCandidate(candidate({ events: [{ points: NaN, at: NOW }] })),
      (err: unknown) => err instanceof LeaderboardIntegrityError && err.code === "VALIDATION_FAILED",
    )
    assert.throws(
      () => scoreLeaderboardCandidate({ ...candidate(), events: "nope" as never }),
      (err: unknown) => err instanceof LeaderboardIntegrityError && err.code === "VALIDATION_FAILED",
    )
  })
})
