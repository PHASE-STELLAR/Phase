import { describe, it, beforeEach, afterEach, vi } from "vitest"
import * as assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ANOMALY_DEFAULTS,
  ANOMALY_BASELINE_SCHEMA,
  collectAnomalySample,
  counterDeltas,
  detectAnomalies,
  detectBalanceDrops,
  detectValueFinding,
  emptyBaselineStore,
  isAnomalyDetectionEnabled,
  anomaly181RollbackNote,
  anomalyAlertFor,
  normalizeBaselineStore,
  robustStats,
  routeAnomalyAlerts,
  zScore,
  type AnomalyFinding,
} from "@/lib/anomaly-detection"
import type { WebhookAlertPayload, WebhookAlertType } from "@/lib/webhook-alerts"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"
import { resetSecurityCounters, incSecurityCounter, getSecurityCounter } from "@/lib/security-counters"

const NOW = Date.parse("2026-06-01T00:00:00.000Z")
const HISTORY = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_181 = "1"
    process.env.FEATURE_PHASE_181 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_181
    delete process.env.FEATURE_PHASE_181
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-anomaly-"))
  vi.stubEnv("PHASE_SERVER_DATA_DIR", dir)
  resetDbForTests()
  resetSecurityCounters()
  enable(true)
})

afterEach(() => {
  enable(false)
  resetDbForTests()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe("phase-181 anomaly statistics", () => {
  it("gates on the feature flag and ships a rollback note", () => {
    assert.equal(isAnomalyDetectionEnabled(), true)
    enable(false)
    assert.equal(isAnomalyDetectionEnabled(), false)
    assert.match(anomaly181RollbackNote(), /phase-181/)
  })

  it("computes robust median/MAD stats with a sigma floor", () => {
    const flat = robustStats(HISTORY)
    assert.equal(flat.samples, 10)
    assert.equal(flat.median, 10)
    assert.ok(flat.sigma > 0)

    const varied = robustStats([10, 12, 11, 9, 10, 13, 8, 10, 11, 12])
    assert.ok(varied.sigma > 0 && varied.sigma < 10)

    assert.equal(robustStats([]).samples, 0)
  })

  it("scores a spike against a flat baseline and a matching value as zero", () => {
    assert.ok(zScore(HISTORY, 500) >= ANOMALY_DEFAULTS.criticalZ)
    assert.equal(zScore(HISTORY, 10), 0)
    assert.equal(zScore([], 10), 0)
  })

  it("emits findings only past the sample floor and severity thresholds", () => {
    assert.equal(detectValueFinding("volume", "m", HISTORY.slice(0, 3), 500), null)
    assert.equal(detectValueFinding("volume", "m", HISTORY, 10), null)

    // Varied baseline (median 10, sigma≈1.48): 11 fits, 16 is a warning (z≈4.0),
    // 500 is critical.
    const fits = [10, 11, 9, 10, 12, 8, 10, 11, 9, 10]
    assert.equal(detectValueFinding("volume", "m", fits, 11), null)

    const warning = detectValueFinding("volume", "m", fits, 16)
    assert.ok(warning)
    assert.equal(warning.severity, "warning")
    assert.equal(warning.kind, "volume")

    const critical = detectValueFinding("counter", "m", fits, 500)
    assert.ok(critical)
    assert.equal(critical.severity, "critical")
    assert.equal(critical.kind, "counter")
    assert.match(critical.message, /counter anomaly on m/)
  })

  it("reduces counters to deltas and skips resets and first-seen keys", () => {
    const deltas = counterDeltas(
      { wash_volume_excluded: 100, market_volume_drift: 50, stale: 10 },
      { wash_volume_excluded: 130, market_volume_drift: 40, stale: 10, fresh: 999 },
    )
    assert.deepEqual(deltas, { wash_volume_excluded: 30, stale: 0 })
  })

  it("rates balance drops by percentage with warning and critical tiers", () => {
    assert.deepEqual(detectBalanceDrops({ distributor_xlm: 100 }, { distributor_xlm: 90 }), [])
    assert.deepEqual(detectBalanceDrops({ distributor_xlm: 0 }, { distributor_xlm: 100 }), [])

    const warning = detectBalanceDrops({ distributor_xlm: 100 }, { distributor_xlm: 80 })
    assert.equal(warning.length, 1)
    assert.equal(warning[0].severity, "warning")
    assert.equal(warning[0].kind, "balance")

    const critical = detectBalanceDrops({ distributor_xlm: 100 }, { distributor_xlm: 60 })
    assert.equal(critical.length, 1)
    assert.equal(critical[0].severity, "critical")
    assert.match(critical[0].message, /dropped 40%/)
  })
})

describe("phase-181 detection runs", () => {
  it("normalizes garbage baselines and ships an empty store", () => {
    const store = normalizeBaselineStore({ metrics: "nope", counters_prev: null })
    assert.equal(store.schema, ANOMALY_BASELINE_SCHEMA)
    assert.deepEqual(store.metrics, {})
    assert.deepEqual(normalizeBaselineStore(undefined).balances_prev, {})
    assert.deepEqual(emptyBaselineStore().metrics, {})
  })

  it("detects a volume breach only after the baseline has enough samples", () => {
    let baseline = emptyBaselineStore()
    let outcome = detectAnomalies(
      baseline,
      { ts: NOW, volume: { market_volume_phaselq_24h: 100 }, counters: {}, balances: {} },
    )
    assert.deepEqual(outcome.findings, [])
    baseline = outcome.baseline

    for (let i = 0; i < ANOMALY_DEFAULTS.minSamples; i++) {
      outcome = detectAnomalies(
        baseline,
        { ts: NOW + i, volume: { market_volume_phaselq_24h: 100 }, counters: {}, balances: {} },
      )
      assert.deepEqual(outcome.findings, [])
      baseline = outcome.baseline
    }
    assert.equal(baseline.metrics?.["volume:market_volume_phaselq_24h"]?.length, ANOMALY_DEFAULTS.minSamples + 1)

    outcome = detectAnomalies(baseline, {
      ts: NOW + 99,
      volume: { market_volume_phaselq_24h: 5000 },
      counters: {},
      balances: {},
    })
    const finding = outcome.findings.find((f) => f.kind === "volume")
    assert.ok(finding, "expected a volume finding on the spike")
    assert.equal(finding.value, 5000)
    assert.equal(getSecurityCounter("anomaly_volume_breaches"), 1)
    // Detection ran before the push, so the spike is now part of the history.
    const history = outcome.baseline.metrics?.["volume:market_volume_phaselq_24h"] ?? []
    assert.equal(history[history.length - 1], 5000)
  })

  it("detects counter delta breaches on the second run and balances by drop", () => {
    const first = detectAnomalies(emptyBaselineStore(), {
      ts: NOW,
      volume: {},
      counters: { wash_trades_flagged: 10 },
      balances: { distributor_xlm: 100 },
    })
    assert.deepEqual(first.findings, [])
    assert.deepEqual(first.baseline.counters_prev, { wash_trades_flagged: 10 })

    // Warm the counter-delta history with quiet runs, then spike the counter.
    let baseline = first.baseline
    for (let i = 0; i < ANOMALY_DEFAULTS.minSamples; i++) {
      baseline = detectAnomalies(baseline, {
        ts: NOW + i,
        volume: {},
        counters: { wash_trades_flagged: 10 },
        balances: { distributor_xlm: 100 },
      }).baseline
    }
    const spike = detectAnomalies(baseline, {
      ts: NOW + 50,
      volume: {},
      counters: { wash_trades_flagged: 1000 },
      balances: { distributor_xlm: 55 },
    })
    const counterFinding = spike.findings.find((f) => f.kind === "counter")
    assert.ok(counterFinding, "expected a counter-delta finding")
    assert.equal(counterFinding.value, 990)
    const balanceFinding = spike.findings.find((f) => f.kind === "balance")
    assert.ok(balanceFinding, "expected a balance-drop finding")
    assert.equal(balanceFinding.severity, "critical")
    assert.equal(getSecurityCounter("anomaly_counter_breaches"), 1)
    assert.equal(getSecurityCounter("anomaly_balance_breaches"), 1)
  })

  it("caps baseline history at maxHistory", () => {
    let baseline = emptyBaselineStore()
    for (let i = 0; i < 20; i++) {
      baseline = detectAnomalies(
        baseline,
        { ts: NOW + i, volume: { m: i }, counters: {}, balances: {} },
        { maxHistory: 5, zThreshold: 9999 },
      ).baseline
    }
    assert.equal(baseline.metrics?.["volume:m"]?.length, 5)
  })
})

describe("phase-181 alert routing", () => {
  const finding = (over: Partial<AnomalyFinding> = {}): AnomalyFinding => ({
    kind: "volume",
    severity: "warning",
    metric: "market_volume_phaselq_24h",
    message: "volume anomaly on market_volume_phaselq_24h",
    value: 5000,
    z: 7.2,
    ...over,
  })

  it("maps findings to webhook payloads with a distinct title per kind and metric", () => {
    const warning = anomalyAlertFor(finding())
    assert.equal(warning.type, "warning")
    assert.equal(warning.payload.title, "Anomaly volume: market_volume_phaselq_24h")
    assert.equal(warning.payload.z, 7.2)

    const critical = anomalyAlertFor(finding({ kind: "balance", severity: "critical", metric: "distributor_xlm", z: null }))
    assert.equal(critical.type, "critical")
    assert.equal(critical.payload.title, "Anomaly balance: distributor_xlm")
    assert.equal("z" in critical.payload, false)
  })

  it("routes every finding through the router and counts the attempts", async () => {
    const seen: Array<{ type: string; title: string }> = []
    const router = async (type: WebhookAlertType, payload: WebhookAlertPayload) => {
      seen.push({ type, title: payload.title })
      return { sent: ["discord"], failed: [] }
    }
    const result = await routeAnomalyAlerts(
      [
        finding(),
        finding({ kind: "counter", metric: "wash_trades_flagged" }),
        finding({ kind: "balance", severity: "critical", metric: "distributor_xlm" }),
      ],
      router,
    )
    assert.equal(result.routed, 3)
    assert.equal(result.sent, 3)
    assert.equal(seen.length, 3)
    assert.equal(new Set(seen.map((s) => s.title)).size, 3, "titles must not collide across metrics")
    assert.equal(seen.filter((s) => s.type === "critical").length, 1)
    assert.equal(getSecurityCounter("anomaly_alerts_routed"), 3)

    assert.deepEqual(await routeAnomalyAlerts([], router), { routed: 0, sent: 0 })
    assert.equal(getSecurityCounter("anomaly_alerts_routed"), 3, "empty routing must not inflate the counter")
  })
})

describe("phase-181 sample collection", () => {
  it("excludes anomaly's own counters so the detector cannot alert on itself", async () => {
    incSecurityCounter("anomaly_checks_run")
    incSecurityCounter("wash_trades_flagged")
    const sample = await collectAnomalySample({ now: NOW })
    assert.equal("anomaly_checks_run" in sample.counters, false)
    assert.equal(sample.counters.wash_trades_flagged, 1)
    assert.equal(sample.ts, NOW)
    assert.ok("market_volume_phaselq_24h" in sample.volume)
    assert.ok(Number.isFinite(sample.volume.market_volume_phaselq_24h))
  })

  it("tolerates an unreadable database by omitting volume metrics", async () => {
    getDb().exec("DROP TABLE offers")
    const sample = await collectAnomalySample({ now: NOW })
    assert.deepEqual(sample.volume, {})
  })
})
