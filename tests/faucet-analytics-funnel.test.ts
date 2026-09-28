/**
 * Module #53 (phase-53) — faucet analytics: claim funnel metrics.
 * Run: npx tsx tests/faucet-analytics-funnel.test.ts
 */
import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  FaucetFunnelError,
  auditFaucetAnalyticsWiring,
  computeClaimFunnel,
  getFaucetFunnelAnalytics,
  recordFaucetFunnelEvent,
} from "@/lib/notification-store"

let dataDir: string
before(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "phase-funnel-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_53 = "1"
})
after(() => {
  process.env.FEATURE_PHASE_53 = ""
  delete process.env.PHASE_SERVER_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

type Ev = Parameters<typeof computeClaimFunnel>[0][number]

const EVENTS: Ev[] = [
  { stage: "viewed", wallet: null, session_id: "s1", ts: 10, reason: null },
  { stage: "viewed", wallet: null, session_id: "s2", ts: 10, reason: null },
  { stage: "viewed", wallet: null, session_id: "s3", ts: 10, reason: null },
  { stage: "viewed", wallet: null, session_id: "s4", ts: 10, reason: null },
  { stage: "wallet_connected", wallet: "GA", session_id: "s1", ts: 20, reason: null },
  { stage: "wallet_connected", wallet: "GB", session_id: "s2", ts: 20, reason: null },
  { stage: "wallet_connected", wallet: "GC", session_id: "s3", ts: 20, reason: null },
  { stage: "claim_started", wallet: "GA", session_id: "s1", ts: 30, reason: null },
  { stage: "claim_started", wallet: "GB", session_id: "s2", ts: 30, reason: null },
  { stage: "claim_signed", wallet: "GA", session_id: "s1", ts: 40, reason: null },
  { stage: "claim_confirmed", wallet: "GA", session_id: "s1", ts: 50, reason: null },
  { stage: "claim_failed", wallet: "GB", session_id: "s2", ts: 45, reason: "insufficient trustline" },
]

describe("phase-53 faucet claim funnel", () => {
  it("computes per-stage unique counts and step conversion", () => {
    const report = computeClaimFunnel(EVENTS)
    const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s]))
    assert.equal(byStage.viewed.uniqueSubjects, 4)
    assert.equal(byStage.wallet_connected.uniqueSubjects, 3)
    assert.equal(byStage.wallet_connected.conversionFromPrev, 0.75)
    assert.equal(byStage.claim_confirmed.uniqueSubjects, 1)
    assert.equal(report.overallConversion, 0.25)
  })

  it("tracks the failed branch separately", () => {
    const report = computeClaimFunnel(EVENTS)
    assert.equal(report.failed.events, 1)
    assert.equal(report.failed.uniqueSubjects, 1)
  })

  it("honours a time window", () => {
    const report = computeClaimFunnel(EVENTS, { windowMs: 15, now: 50 })
    // only ts >= 35 kept: claim_signed, claim_confirmed, claim_failed
    assert.equal(report.totalEvents, 3)
  })

  it("persists events and aggregates them back", async () => {
    await recordFaucetFunnelEvent({ stage: "viewed", session_id: "p1" })
    await recordFaucetFunnelEvent({ stage: "wallet_connected", wallet: "GZ", session_id: "p1" })
    const report = await getFaucetFunnelAnalytics()
    assert.equal(report.totalEvents, 2)
    assert.equal(report.stages.find((s) => s.stage === "viewed")?.uniqueSubjects, 1)
  })

  it("rejects an unknown stage with a typed error", async () => {
    await assert.rejects(
      () => recordFaucetFunnelEvent({ stage: "not_a_stage" }),
      (e: unknown) => e instanceof FaucetFunnelError && e.code === "VALIDATION_FAILED",
    )
  })

  it("throws FLAG_DISABLED when phase-53 is off", async () => {
    process.env.FEATURE_PHASE_53 = ""
    await assert.rejects(
      () => recordFaucetFunnelEvent({ stage: "viewed" }),
      (e: unknown) => e instanceof FaucetFunnelError && e.code === "FLAG_DISABLED",
    )
    process.env.FEATURE_PHASE_53 = "1"
  })

  it("diagnose-env wiring audit passes", () => {
    assert.equal(auditFaucetAnalyticsWiring().ok, true)
  })
})
