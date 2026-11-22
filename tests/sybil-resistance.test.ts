/**
 * Module #45 (Issue #69) — Sybil-resistance on-chain history scoring.
 * Run: npx tsx tests/sybil-resistance.test.ts
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"

import {
  SybilScoreInputSchema,
  scoreWalletHistory,
  isSybilSuspect,
  SybilResistanceError,
  isSybilResistanceEnabled,
  isSybilGatingEnabled,
  evaluateAndRecordSybilDecision,
  getSybilDecisionById,
  listSybilDecisionsByWallet,
  assessWalletSybilRisk,
  type SybilScoreInput,
} from "@/lib/sybil-resistance"
import { Keypair } from "@stellar/stellar-sdk"
import { resetSecurityCounters, snapshotSecurityCounters, SYBIL_DECISION_REASONS } from "@/lib/security-counters"

function features(over: Partial<Record<string, number | boolean>> = {}): Record<string, unknown> {
  return {
    accountAgeDays: 120,
    transactionCount: 80,
    paymentCount: 40,
    distinctCounterparties: 15,
    nativeBalance: 250,
    hasHomeDomain: true,
    signerCount: 2,
    trustlineCount: 4,
    sponsoredReserves: 0,
    ...over,
  }
}

// ~55/100 — established enough to clear the suspect band, not enough for trusted.
function cautionFeatures(): Record<string, unknown> {
  return features({
    accountAgeDays: 40,
    transactionCount: 12,
    paymentCount: 6,
    distinctCounterparties: 4,
    nativeBalance: 25,
    hasHomeDomain: false,
    signerCount: 1,
    trustlineCount: 1,
  })
}

describe("schema", () => {
  it("applies defaults for optional config fields", () => {
    const parsed = SybilScoreInputSchema.parse({
      accountAgeDays: 1,
      transactionCount: 0,
      paymentCount: 0,
      distinctCounterparties: 0,
      nativeBalance: 0,
    })
    assert.equal(parsed.hasHomeDomain, false)
    assert.equal(parsed.signerCount, 1)
    assert.equal(parsed.trustlineCount, 0)
  })

  it("rejects negative counts", () => {
    assert.equal(SybilScoreInputSchema.safeParse(features({ transactionCount: -1 })).success, false)
  })
})

describe("scoreWalletHistory (pure)", () => {
  it("scores an established account as trusted", () => {
    const s = scoreWalletHistory(features())
    assert.ok(s.score >= 80, `expected high score, got ${s.score}`)
    assert.equal(s.band, "trusted")
    assert.equal(s.suspect, false)
    assert.ok(s.signals.includes("account_age>=90d"))
  })

  it("scores a freshly created empty wallet as suspect", () => {
    const s = scoreWalletHistory(
      features({
        accountAgeDays: 0.2,
        transactionCount: 0,
        paymentCount: 0,
        distinctCounterparties: 0,
        nativeBalance: 1,
        hasHomeDomain: false,
        signerCount: 1,
        trustlineCount: 0,
      }),
    )
    assert.ok(s.score <= 20, `expected low score, got ${s.score}`)
    assert.equal(s.band, "suspect")
    assert.equal(s.suspect, true)
    assert.ok(s.signals.includes("account_age<1d"))
  })

  it("puts a partially-established account in the caution band", () => {
    const s = scoreWalletHistory(cautionFeatures())
    assert.equal(s.band, "caution", `score was ${s.score}`)
  })

  it("applies the sponsored-dormant penalty", () => {
    const withPenalty = scoreWalletHistory(
      features({
        accountAgeDays: 2,
        transactionCount: 1,
        paymentCount: 0,
        distinctCounterparties: 0,
        nativeBalance: 0,
        hasHomeDomain: false,
        signerCount: 1,
        trustlineCount: 0,
        sponsoredReserves: 3,
      }),
    )
    assert.ok(withPenalty.signals.includes("sponsored_dormant"))
    assert.equal(withPenalty.score, 0)
  })

  it("clamps score into 0..100", () => {
    const s = scoreWalletHistory(
      features({ accountAgeDays: 100000, transactionCount: 1e6, distinctCounterparties: 1e6, nativeBalance: 1e9 }),
    )
    assert.ok(s.score >= 0 && s.score <= 100)
  })

  it("honours a custom suspect threshold", () => {
    const base = cautionFeatures()
    const lenient = scoreWalletHistory(base)
    const strict = scoreWalletHistory(base, { suspectThreshold: 90 })
    assert.equal(lenient.band, "caution")
    assert.equal(strict.band, "suspect")
  })

  it("throws a typed error on malformed input", () => {
    assert.throws(
      () => scoreWalletHistory({ nope: true }),
      (e: unknown) => e instanceof SybilResistanceError && e.code === "VALIDATION_FAILED",
    )
  })
})

describe("isSybilSuspect", () => {
  it("treats low scores as suspect at the default threshold", () => {
    assert.equal(isSybilSuspect(10), true)
    assert.equal(isSybilSuspect(70), false)
  })
})

describe("assessWalletSybilRisk (flag gate)", () => {
  it("returns null when phase-145 is disabled", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_145
    delete process.env.FEATURE_PHASE_145
    assert.equal(isSybilResistanceEnabled(), false)
    assert.equal(await assessWalletSybilRisk("GA" + "A".repeat(54)), null)
  })

  it("returns null for a malformed address even when enabled", async () => {
    process.env.FEATURE_PHASE_145 = "1"
    assert.equal(isSybilResistanceEnabled(), true)
    assert.equal(await assessWalletSybilRisk("not-an-address"), null)
    delete process.env.FEATURE_PHASE_145
  })
})

describe("phase-246 sybil gating for rewards and governance (#697)", () => {
  const wallet = Keypair.random().publicKey()

  it("skips gating and returns null when phase-246 flag is off", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_246
    delete process.env.FEATURE_PHASE_246
    assert.equal(isSybilGatingEnabled(wallet), false)
    const decision = await evaluateAndRecordSybilDecision(wallet, "reward_credit", {
      features: features({ accountAgeDays: 0, transactionCount: 0, distinctCounterparties: 0, nativeBalance: 0 }) as SybilScoreInput,
    })
    assert.equal(decision, null)
  })

  it("blocks below-threshold wallets on reward_credit and governance_vote and persists reason code", async () => {
    process.env.FEATURE_PHASE_246 = "1"
    process.env.FEATURE_PHASE_267 = "1"
    resetSecurityCounters()
    try {
      const lowFeatures = features({
        accountAgeDays: 0,
        transactionCount: 0,
        paymentCount: 0,
        distinctCounterparties: 0,
        nativeBalance: 0,
        hasHomeDomain: false,
        signerCount: 1,
        trustlineCount: 0,
        sponsoredReserves: 2,
      }) as SybilScoreInput

      const rewardDecision = await evaluateAndRecordSybilDecision(wallet, "reward_credit", {
        features: lowFeatures,
      })
      assert.ok(rewardDecision)
      assert.equal(rewardDecision.allowed, false)
      assert.equal(rewardDecision.reasonCode, "below_threshold")
      assert.ok((SYBIL_DECISION_REASONS as readonly string[]).includes(rewardDecision.reasonCode))

      const voteDecision = await evaluateAndRecordSybilDecision(wallet, "governance_vote", {
        features: lowFeatures,
      })
      assert.ok(voteDecision)
      assert.equal(voteDecision.allowed, false)
      assert.equal(voteDecision.reasonCode, "below_threshold")

      const stored = getSybilDecisionById(rewardDecision.decisionId)
      assert.ok(stored)
      assert.equal(stored.decisionId, rewardDecision.decisionId)
      assert.equal(stored.reasonCode, "below_threshold")

      const byWallet = listSybilDecisionsByWallet(wallet, 10)
      assert.ok(byWallet.length >= 2)

      // Ensure no wallet or CID appears in security counter labels
      const snap = snapshotSecurityCounters()
      const serialized = JSON.stringify(snap)
      assert.equal(serialized.includes(wallet), false)
    } finally {
      delete process.env.FEATURE_PHASE_246
      delete process.env.FEATURE_PHASE_267
    }
  })

  it("admits established wallets and fails closed when signals are unavailable", async () => {
    process.env.FEATURE_PHASE_246 = "1"
    try {
      const trustedDecision = await evaluateAndRecordSybilDecision(wallet, "governance_vote", {
        features: features() as SybilScoreInput,
      })
      assert.ok(trustedDecision)
      assert.equal(trustedDecision.allowed, true)
      assert.equal(trustedDecision.reasonCode, "allowed_trusted")

      const unavailableDecision = await evaluateAndRecordSybilDecision(wallet, "reward_credit", {
        features: null,
      })
      assert.ok(unavailableDecision)
      assert.equal(unavailableDecision.allowed, false)
      assert.equal(unavailableDecision.reasonCode, "signal_unavailable")
    } finally {
      delete process.env.FEATURE_PHASE_246
    }
  })
})
