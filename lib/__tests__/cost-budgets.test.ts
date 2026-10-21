import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/webhook-alerts", () => ({
  sendWebhookAlert: vi.fn(async () => ({ sent: ["test"], failed: [] })),
}))

import {
  chargeSurfaceCost,
  evaluateSurfaceBudgets,
  isSurfaceHalted,
  resetCostBudgetCountersForTests,
  snapshotCostBudgetCounters,
  SurfaceHaltedError,
  assertSurfaceOpen,
} from "@/lib/cost-budgets"
import { sendWebhookAlert } from "@/lib/webhook-alerts"

describe("cost-budgets (spike 614 / phase-176)", () => {
  let dataDir: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-cost-budgets-"))
    process.env.PHASE_SERVER_DATA_DIR = dataDir
    for (const key of [
      "FEATURE_PHASE_176",
      "NEXT_PUBLIC_FEATURE_PHASE_176",
      "PHASE_COST_BUDGET_FORGE",
      "PHASE_COST_BUDGET_WINDOW_MS",
      "PHASE_COST_BUDGET_WARNING_RATIO",
    ]) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.FEATURE_PHASE_176 = "1"
    vi.mocked(sendWebhookAlert).mockClear()
    resetCostBudgetCountersForTests()
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetCostBudgetCountersForTests()
    await rm(dataDir, { recursive: true, force: true })
  })

  it("flag off makes charging inert and never halts", async () => {
    delete process.env.FEATURE_PHASE_176
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_176
    process.env.PHASE_COST_BUDGET_FORGE = "10"
    const result = await chargeSurfaceCost("forge", 100)
    expect(result.ok).toBe(true)
    expect(result.reason).toBe("flag_disabled")
    expect(isSurfaceHalted("forge")).toBe(false)
    const evaluation = await evaluateSurfaceBudgets()
    expect(evaluation.enabled).toBe(false)
  })

  it("charges accumulate and halt at budget with alert", async () => {
    process.env.PHASE_COST_BUDGET_FORGE = "30"
    await chargeSurfaceCost("forge", 10, { now: 1_000 })
    const warn = await chargeSurfaceCost("forge", 14, { now: 2_000 }) // 24/30 = 80% → warning
    expect(warn.status).toBe("warning")
    const halt = await chargeSurfaceCost("forge", 6, { now: 3_000 }) // 30/30 → halted
    expect(halt.status).toBe("halted")
    expect(halt.ok).toBe(false)
    expect(isSurfaceHalted("forge")).toBe(true)
    expect(() => assertSurfaceOpen("forge")).toThrowError(SurfaceHaltedError)

    const evaluation = await evaluateSurfaceBudgets({ now: 3_500 })
    expect(evaluation.halted).toContain("forge")
    expect(vi.mocked(sendWebhookAlert).mock.calls.length).toBeGreaterThanOrEqual(1)
    const critical = vi.mocked(sendWebhookAlert).mock.calls.find((c) => c[0] === "critical")
    expect(critical).toBeTruthy()
  })

  it("refuses charges once halted and counts the refusal", async () => {
    process.env.PHASE_COST_BUDGET_FORGE = "5"
    await chargeSurfaceCost("forge", 5, { now: 1_000 })
    const refused = await chargeSurfaceCost("forge", 1, { now: 2_000 })
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe("halted")
    expect(snapshotCostBudgetCounters().budget_halt_refusal).toBe(1)
  })

  it("unbudgeted surfaces stay ok", async () => {
    const result = await chargeSurfaceCost("explore", 10_000)
    expect(result.status).toBe("ok")
    expect(result.ok).toBe(true)
    expect(isSurfaceHalted("explore")).toBe(false)
  })

  it("burns off a new window after windowMs", async () => {
    process.env.PHASE_COST_BUDGET_FORGE = "10"
    process.env.PHASE_COST_BUDGET_WINDOW_MS = "60000"
    const start = 1_000_000
    await chargeSurfaceCost("forge", 10, { now: start })
    expect(isSurfaceHalted("forge")).toBe(true)
    resetCostBudgetCountersForTests()
    // Next charge after the window rolls: spent resets, surface un-halts.
    const after = await chargeSurfaceCost("forge", 1, { now: start + 61_000 })
    expect(after.ok).toBe(true)
    expect(after.spentUnits).toBe(1)
    expect(isSurfaceHalted("forge")).toBe(false)
  })

  it("alerts only on level transitions", async () => {
    process.env.PHASE_COST_BUDGET_FORGE = "100"
    process.env.PHASE_COST_BUDGET_WARNING_RATIO = "0.5"
    await chargeSurfaceCost("forge", 60, { now: 1_000 })
    const first = await evaluateSurfaceBudgets({ now: 2_000 })
    expect(first.alerted).toContain("forge")
    const second = await evaluateSurfaceBudgets({ now: 3_000 })
    expect(second.alerted).not.toContain("forge")
  })

  it("rejects invalid surface/units", async () => {
    const result = await chargeSurfaceCost("nope" as never, 5)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("invalid")
  })
})
