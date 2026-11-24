import { describe, it, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  DEFAULT_VITAL_BUDGETS,
  createRumEvent,
  evaluateFieldData,
  evaluateVital,
  formatVitalsMarkdown,
  getVitalsBudget,
  hasRegression,
  isRumCollectorEnabled,
  isWebVitalsBudgetsEnabled,
  normalizeRoute,
  parseFieldData,
  rumRollbackNote,
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

// ─── phase-213: closed-label RUM + CI gate ───────────────────────────────────

function enable213(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_213 = "1"
    process.env.FEATURE_PHASE_213 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_213
    delete process.env.FEATURE_PHASE_213
  }
}

const HASH = "a".repeat(64)

describe("phase-213 RUM wire format", () => {
  beforeEach(() => enable213(true))

  it("normalizes routes and strips PII", () => {
    assert.equal(normalizeRoute("/world/123?wallet=GABC&ref=abc"), "/world/:id")
    assert.equal(normalizeRoute("/profile/GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "/profile/:id")
    assert.equal(normalizeRoute("/explore/"), "/explore")
    assert.equal(normalizeRoute(null), null)
  })

  it("emits only the five whitelisted fields", () => {
    const withPii = {
      route: "/world/42?secret=1",
      metric: "LCP",
      value: 2100,
      sessionHash: HASH,
      ts: Date.now(),
      wallet: "GSECRET",
      email: "someone@example.com",
    }
    const event = createRumEvent(withPii)
    assert.ok(event)
    assert.deepEqual(Object.keys(event!).sort(), ["metric", "route", "sessionHash", "ts", "value"])
    assert.equal(JSON.stringify(event).includes("GSECRET"), false)
    assert.equal(JSON.stringify(event).includes("someone@example.com"), false)
    assert.equal(event!.route, "/world/:id")
  })

  it("rejects malformed / raw session ids", () => {
    assert.equal(createRumEvent({ route: "/", metric: "LCP", value: 1, sessionHash: "raw-session", ts: Date.now() }), null)
    assert.equal(createRumEvent({ route: "/", metric: "FCP", value: 1, sessionHash: HASH, ts: Date.now() }), null)
    assert.equal(createRumEvent({ route: "/", metric: "CLS", value: 99, sessionHash: HASH, ts: Date.now() }), null)
  })

  it("drops unexpected fields when parsing recorded data", () => {
    const parsed = parseFieldData([
      { route: "/", metric: "INP", value: 100, sessionHash: HASH, ts: Date.now(), ip: "1.2.3.4" },
      { route: "/", metric: "INP", value: -1, sessionHash: HASH, ts: Date.now() },
    ])
    assert.equal(parsed.length, 1)
    assert.equal("ip" in parsed[0], false)
  })

  it("reflects the phase-213 flag and exposes a rollback note", () => {
    assert.equal(isRumCollectorEnabled(), true)
    enable213(false)
    assert.equal(isRumCollectorEnabled(), false)
    assert.match(rumRollbackNote(), /phase-213/)
  })
})

describe("phase-213 CI budget evaluation", () => {
  beforeEach(() => enable213(true))

  const events = Array.from({ length: 8 }, (_, i) => ({
    route: "/explore",
    metric: "CLS" as const,
    value: 0.04 + i * 0.001,
    sessionHash: HASH,
    ts: 1760000000000 + i,
  }))

  it("passes recorded data that stays within budget", () => {
    const report = evaluateFieldData(events)
    assert.equal(hasRegression(report), false)
    assert.equal(report.evaluations[0].budget, 0.05)
  })

  it("blocks a deliberate budget regression", () => {
    const regressed = events.map((e) => ({ ...e, value: 0.2 }))
    const report = evaluateFieldData(regressed)
    assert.equal(hasRegression(report), true)
    assert.match(formatVitalsMarkdown(report), /Gate: FAIL/)
  })

  it("ignores buckets below the minimum sample count", () => {
    const report = evaluateFieldData(events.slice(0, 2))
    assert.equal(report.evaluations.length, 0)
    assert.equal(hasRegression(report), false)
  })
})

