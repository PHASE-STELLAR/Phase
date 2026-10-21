import { describe, it, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  DEFAULT_VITAL_BUDGETS,
  evaluateVital,
  getVitalsBudget,
  isWebVitalsBudgetsEnabled,
  summarizeVitals,
  webVitalsBudgetsRollbackNote,
} from "@/lib/web-vitals-budgets"

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_160 = "1"
    process.env.FEATURE_PHASE_160 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_160
    delete process.env.FEATURE_PHASE_160
  }
}

describe("phase-160 web vitals budgets", () => {
  beforeEach(() => enable(true))

  it("resolves exact, prefixed, and default budgets", () => {
    assert.equal(getVitalsBudget("/explore").CLS, 0.05)
    assert.deepEqual(getVitalsBudget("/world/123"), getVitalsBudget("/world/[collection_id]"))
    assert.deepEqual(getVitalsBudget("/unknown"), DEFAULT_VITAL_BUDGETS)
  })

  it("prefers the longest matching prefix", () => {
    assert.equal(getVitalsBudget("/explore/feed").LCP, 2500)
  })

  it("rates a sample as good, needs-improvement, or poor", () => {
    assert.equal(evaluateVital("/explore", "LCP", 2000).rating, "good")
    assert.equal(evaluateVital("/explore", "LCP", 4000).rating, "needs-improvement")
    assert.equal(evaluateVital("/explore", "LCP", 9000).rating, "poor")
  })

  it("flags a budget breach", () => {
    const pass = evaluateVital("/explore", "CLS", 0.04)
    const fail = evaluateVital("/explore", "CLS", 0.2)
    assert.equal(pass.withinBudget, true)
    assert.equal(fail.withinBudget, false)
  })

  it("summarizes the worst sample per vital and lists failures", () => {
    const summary = summarizeVitals("/explore", [
      { name: "LCP", value: 1800 },
      { name: "LCP", value: 5200 },
      { name: "CLS", value: 0.02 },
      { name: "INP", value: 150 },
    ])
    assert.equal(summary.worst.LCP!.value, 5200)
    assert.deepEqual(summary.failures, ["LCP"])
    assert.equal(summary.withinBudget, false)
  })

  it("treats an empty sample set as within budget", () => {
    const summary = summarizeVitals("/forge", [])
    assert.equal(summary.withinBudget, true)
    assert.deepEqual(summary.failures, [])
  })

  it("reflects the phase-160 flag and exposes a rollback note", () => {
    assert.equal(isWebVitalsBudgetsEnabled(), true)
    enable(false)
    assert.equal(isWebVitalsBudgetsEnabled(), false)
    assert.match(webVitalsBudgetsRollbackNote(), /phase-160/)
  })
})
