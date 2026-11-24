/**
 * Module #50 (phase-50) — quest A/B variant experimentation framework.
 * Run: npx tsx tests/quest-ab-variant.test.ts
 */
import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import {
  QuestExperimentError,
  assignQuestVariant,
  auditQuestExperimentWiring,
  parseQuestExperimentConfig,
  questExperimentBucket,
  summarizeQuestExperiment,
} from "@/lib/env-validation"

const CONFIG = {
  experimentId: "faucet-daily-reward",
  holdoutPercent: 0,
  variants: [
    { id: "control", weight: 1, rewardAmount: 100 },
    { id: "generous", weight: 1, rewardAmount: 200 },
  ],
}

const WALLET_A = "GA" + "A".repeat(53) + "F"
const WALLET_B = "GB" + "B".repeat(53) + "F"

describe("phase-50 quest A/B variant experimentation", () => {
  before(() => {
    process.env.FEATURE_PHASE_50 = "1"
  })
  after(() => {
    process.env.FEATURE_PHASE_50 = ""
  })

  it("assigns deterministically for a stable wallet", () => {
    const first = assignQuestVariant(CONFIG, WALLET_A)
    const second = assignQuestVariant(CONFIG, WALLET_A)
    assert.equal(first.variantId, second.variantId)
    assert.equal(first.bucket, second.bucket)
    assert.ok(first.variant && first.variant.rewardAmount > 0)
  })

  it("spreads a population across both variants", () => {
    const counts: Record<string, number> = { control: 0, generous: 0 }
    for (let i = 0; i < 400; i++) {
      const wallet = `GA${String(i).padStart(53, "0")}F`
      counts[assignQuestVariant(CONFIG, wallet).variantId as string]++
    }
    assert.ok(counts.control > 100, `control got ${counts.control}`)
    assert.ok(counts.generous > 100, `generous got ${counts.generous}`)
  })

  it("honours weighting", () => {
    const weighted = {
      experimentId: "weighted",
      variants: [
        { id: "small", weight: 1, rewardAmount: 10 },
        { id: "big", weight: 9, rewardAmount: 10 },
      ],
    }
    let big = 0
    for (let i = 0; i < 500; i++) {
      const wallet = `GC${String(i).padStart(53, "0")}F`
      if (assignQuestVariant(weighted, wallet).variantId === "big") big++
    }
    assert.ok(big > 350, `expected ~90% big, got ${big}/500`)
  })

  it("routes a holdout slice to no variant", () => {
    const held = { ...CONFIG, experimentId: "held", holdoutPercent: 50 }
    let holdout = 0
    for (let i = 0; i < 400; i++) {
      const wallet = `GD${String(i).padStart(53, "0")}F`
      if (assignQuestVariant(held, wallet).holdout) holdout++
    }
    assert.ok(holdout > 120 && holdout < 280, `holdout share out of range: ${holdout}/400`)
  })

  it("rejects an invalid config with a typed error", () => {
    assert.throws(
      () => parseQuestExperimentConfig({ experimentId: "x", variants: [{ id: "a", weight: 1, rewardAmount: 1 }] }),
      (e: unknown) => e instanceof QuestExperimentError && e.code === "VALIDATION_FAILED",
    )
  })

  it("rejects duplicate variant ids", () => {
    assert.throws(
      () =>
        parseQuestExperimentConfig({
          experimentId: "dupe",
          variants: [
            { id: "a", weight: 1, rewardAmount: 1 },
            { id: "a", weight: 1, rewardAmount: 2 },
          ],
        }),
      (e: unknown) => e instanceof QuestExperimentError && e.code === "VALIDATION_FAILED",
    )
  })

  it("blocks assignment when the experiment is disabled", () => {
    assert.throws(
      () => assignQuestVariant({ ...CONFIG, enabled: false }, WALLET_B),
      (e: unknown) => e instanceof QuestExperimentError && e.code === "EXPERIMENT_DISABLED",
    )
  })

  it("blocks assignment when the flag is off", () => {
    process.env.FEATURE_PHASE_50 = ""
    assert.throws(
      () => assignQuestVariant(CONFIG, WALLET_A),
      (e: unknown) => e instanceof QuestExperimentError && e.code === "FLAG_DISABLED",
    )
    process.env.FEATURE_PHASE_50 = "1"
  })

  it("summarizes weight distribution without a wallet", () => {
    const summary = summarizeQuestExperiment(CONFIG)
    assert.equal(summary.variants.length, 2)
    assert.equal(summary.variants[0].sharePercent + summary.variants[1].sharePercent, 100)
  })

  it("bucket is bounded 0..9999", () => {
    for (let i = 0; i < 50; i++) {
      const b = questExperimentBucket("exp", `GA${i}`)
      assert.ok(b >= 0 && b < 10_000)
    }
  })

  it("diagnose-env wiring audit passes", () => {
    assert.equal(auditQuestExperimentWiring().ok, true)
  })
})
