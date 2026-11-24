/**
 * Spike 611 (#474, phase-177) — Funnel analytics v2 with retention cohorts:
 * Day-N, wallet-age bands, time-to-convert tracking, and sybil-weighted cohorts.
 *
 * NOTE: Written as part of the spike implementation (static review, not executed per strict constraints).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  computeFunnelRetention,
  auditFunnelRetentionWiring,
  RETENTION_DAYS,
} from "@/lib/funnel-retention"
import { isFunnelRetentionEnabled, phase177RollbackNote } from "@/lib/feature-flags"
import { classifyWalletAgeBand } from "@/lib/horizon-bulkhead"
import { streakCohortCategory } from "@/lib/quest-streak"

describe("Funnel Analytics v2 with Retention Cohorts (Spike 611 / phase-177)", () => {
  const saved177 = process.env.FEATURE_PHASE_177

  beforeEach(() => {
    process.env.FEATURE_PHASE_177 = "1"
  })

  afterEach(() => {
    if (saved177 === undefined) delete process.env.FEATURE_PHASE_177
    else process.env.FEATURE_PHASE_177 = saved177
  })

  it("checks feature flag enabling and rollback notes", () => {
    expect(isFunnelRetentionEnabled()).toBe(true)
    const note = phase177RollbackNote()
    expect(note).toContain("phase-177")
  })

  it("classifies wallet age bands correctly", () => {
    expect(classifyWalletAgeBand(0.5)).toBe("<24h")
    expect(classifyWalletAgeBand(3)).toBe("1-7d")
    expect(classifyWalletAgeBand(14)).toBe("7-30d")
    expect(classifyWalletAgeBand(45)).toBe(">30d")
  })

  it("categorizes streak cohorts properly", () => {
    expect(streakCohortCategory(1)).toBe("day1_2")
    expect(streakCohortCategory(5)).toBe("day3_6")
    expect(streakCohortCategory(10)).toBe("day7_13")
    expect(streakCohortCategory(20)).toBe("day14_29")
    expect(streakCohortCategory(35)).toBe("day30_plus")
  })

  it("defines standard Day-N retention windows (1, 3, 7, 14, 30)", () => {
    expect(RETENTION_DAYS).toEqual([1, 3, 7, 14, 30])
  })

  it("computes funnel retention report structure", async () => {
    const report = await computeFunnelRetention({ force: true })
    expect(typeof report.totalSubjects).toBe("number")
    expect(Array.isArray(report.timeToConvert)).toBe(true)
    expect(Array.isArray(report.cohorts)).toBe(true)
    expect(typeof report.overallDay7Retention).toBe("number")
    expect(typeof report.overallDay30Retention).toBe("number")
    expect(typeof report.sybilWeightedRetention.trustedRetentionDay7).toBe("number")
  })

  it("fails when phase-177 is disabled without force flag", async () => {
    process.env.FEATURE_PHASE_177 = "0"
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_177

    await expect(computeFunnelRetention({ force: false })).rejects.toThrow(
      /phase-177 flag disabled/,
    )
  })

  it("audits the retention wiring successfully when flag is active", () => {
    process.env.FEATURE_PHASE_177 = "1"
    const audit = auditFunnelRetentionWiring()
    expect(audit.ok).toBe(true)
    expect(audit.note).toContain("[phase-177]")
  })
})
