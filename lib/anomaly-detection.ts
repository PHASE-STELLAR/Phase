/**
 * Anomaly detection on volume, counters and balances with alert routing.
 * Spike 619 / Issue #482.
 *
 * Three detectors over one sample (`AnomalySample`), each matched to how its
 * signal actually behaves:
 *
 *   - volume  — robust z-score (median + MAD, falling back to standard
 *               deviation, with a tiny sigma floor so a constant baseline and
 *               a sudden non-zero value still breach) against the persisted
 *               per-metric history.
 *   - counters — cumulative snapshots are reduced to per-run deltas first
 *               (a reset, `curr < prev`, is skipped), then z-scored like
 *               volume. Anomaly's own counters are excluded from the sample
 *               so the detector never alerts on itself.
 *   - balances — deterministic drop percentage vs the previous run: ≥35% is
 *               critical, ≥15% is warning. No baseline needed; a drain is a
 *               drain.
 *
 * Findings route through `sendWebhookAlert` (Discord/Telegram/Slack/generic,
 * 15-minute title dedup) via `routeAnomalyAlerts`, with a distinct title per
 * kind+metric so one flapping metric cannot suppress another.
 *
 * Baselines persist in the `anomalyBaselines` sidecar (capped ring buffer).
 * Flag: phase-181 — rollback: unset the flag, cron returns 404, stored
 * baselines stay inert.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { sendWebhookAlert, type WebhookAlertPayload, type WebhookAlertType } from "@/lib/webhook-alerts"
import { incSecurityCounter, snapshotSecurityCounters } from "@/lib/security-counters"
import { getHealthHistory } from "@/lib/distributor-health-store"
import { getDb } from "@/lib/sqlite-db"

export const ANOMALY_BASELINE_SCHEMA = "phase-anomaly-baselines"
export const ANOMALY_BASELINE_VERSION = "1.0.0"

export const ANOMALY_DEFAULTS = {
  zThreshold: 3.5,
  criticalZ: 6,
  minSamples: 8,
  maxHistory: 100,
  balanceDropWarnPct: 15,
  balanceDropCriticalPct: 35,
  volumeWindowMs: 24 * 60 * 60 * 1000,
} as const

export function isAnomalyDetectionEnabled(): boolean {
  return isFeatureEnabled("phase-181")
}

export function anomaly181RollbackNote(): string {
  return "Rollback phase-181: unset NEXT_PUBLIC_FEATURE_PHASE_181 / FEATURE_PHASE_181 or set 0/false and restart. The anomaly cron 404s; anomaly-baselines.json stays inert."
}

export class AnomalyDetectionError extends Error {
  readonly code: "FLAG_DISABLED" | "COLLECTION_FAILED"
  readonly details?: unknown
  constructor(code: AnomalyDetectionError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "AnomalyDetectionError"
    this.code = code
    this.details = details
  }
}

export type AnomalyKind = "volume" | "counter" | "balance"
export type AnomalySeverity = "warning" | "critical"

export type AnomalyFinding = {
  kind: AnomalyKind
  severity: AnomalySeverity
  metric: string
  message: string
  value: number
  z: number | null
}

export type AnomalySample = {
  ts: number
  volume: Record<string, number>
  counters: Record<string, number>
  balances: Record<string, number>
}

export type BaselineStore = {
  schema?: string
  version?: string
  metrics?: Record<string, number[]>
  counters_prev?: Record<string, number>
  balances_prev?: Record<string, number>
}

export function emptyBaselineStore(): BaselineStore {
  return {
    schema: ANOMALY_BASELINE_SCHEMA,
    version: ANOMALY_BASELINE_VERSION,
    metrics: {},
    counters_prev: {},
    balances_prev: {},
  }
}

export function normalizeBaselineStore(raw: unknown): BaselineStore {
  const parsed = (raw ?? {}) as Partial<BaselineStore>
  return {
    schema: ANOMALY_BASELINE_SCHEMA,
    version: ANOMALY_BASELINE_VERSION,
    metrics: parsed.metrics && typeof parsed.metrics === "object" ? parsed.metrics : {},
    counters_prev: parsed.counters_prev && typeof parsed.counters_prev === "object" ? parsed.counters_prev : {},
    balances_prev: parsed.balances_prev && typeof parsed.balances_prev === "object" ? parsed.balances_prev : {},
  }
}

// ─── Statistics (pure) ───────────────────────────────────────────────────────

export type RobustStats = {
  samples: number
  mean: number
  median: number
  sigma: number
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Median + MAD scaled by 1.4826 (robust to a single spike already in the
 * history), falling back to standard deviation when MAD is 0, then to a tiny
 * sigma floor so a flat baseline with a non-zero current value still scores.
 */
export function robustStats(history: number[]): RobustStats {
  if (history.length === 0) return { samples: 0, mean: 0, median: 0, sigma: 0 }
  const mean = history.reduce((sum, v) => sum + v, 0) / history.length
  const med = median(history)
  const deviations = history.map((v) => Math.abs(v - med))
  let sigma = median(deviations) * 1.4826
  if (sigma === 0) {
    const variance = history.reduce((sum, v) => sum + (v - mean) ** 2, 0) / history.length
    sigma = Math.sqrt(variance)
  }
  if (sigma === 0) sigma = 1e-9
  return { samples: history.length, mean, median: med, sigma }
}

export function zScore(history: number[], value: number): number {
  const stats = robustStats(history)
  if (stats.samples === 0) return 0
  const z = (value - stats.median) / stats.sigma
  return Math.min(z, 999)
}

/** z-score finding against a metric's history; null while the baseline is thin or the value fits. */
export function detectValueFinding(
  kind: AnomalyKind,
  metric: string,
  history: number[],
  value: number,
  opts: Partial<typeof ANOMALY_DEFAULTS> = {},
): AnomalyFinding | null {
  const o = { ...ANOMALY_DEFAULTS, ...opts }
  if (history.length < o.minSamples) return null
  const z = zScore(history, value)
  if (z < o.zThreshold) return null
  const severity: AnomalySeverity = z >= o.criticalZ ? "critical" : "warning"
  const stats = robustStats(history)
  return {
    kind,
    severity,
    metric,
    value,
    z: Math.round(z * 10) / 10,
    message:
      `${kind} anomaly on ${metric}: ${value} vs baseline median ${Math.round(stats.median * 100) / 100} (z=${Math.round(z * 10) / 10})`,
  }
}

/** Per-run deltas for cumulative counters; resets and first-seen keys are skipped. */
export function counterDeltas(
  prev: Record<string, number>,
  curr: Record<string, number>,
): Record<string, number> {
  const deltas: Record<string, number> = {}
  for (const [name, value] of Object.entries(curr)) {
    const before = prev[name]
    if (before === undefined || !Number.isFinite(before) || !Number.isFinite(value)) continue
    if (value < before) continue
    deltas[name] = value - before
  }
  return deltas
}

/** Percentage-drop findings vs the previous run's balances. */
export function detectBalanceDrops(
  prev: Record<string, number>,
  curr: Record<string, number>,
  opts: Partial<typeof ANOMALY_DEFAULTS> = {},
): AnomalyFinding[] {
  const o = { ...ANOMALY_DEFAULTS, ...opts }
  const findings: AnomalyFinding[] = []
  for (const [metric, value] of Object.entries(curr)) {
    const before = prev[metric]
    if (before === undefined || !Number.isFinite(before) || before <= 0 || !Number.isFinite(value)) continue
    const dropPct = ((before - value) / before) * 100
    if (dropPct >= o.balanceDropWarnPct) {
      const severity: AnomalySeverity =
        dropPct >= o.balanceDropCriticalPct ? "critical" : "warning"
      findings.push({
        kind: "balance",
        severity,
        metric,
        value,
        z: null,
        message: `balance anomaly on ${metric}: dropped ${Math.round(dropPct)}% (${Math.round(before * 100) / 100} → ${Math.round(value * 100) / 100})`,
      })
    }
  }
  return findings
}

// ─── Detection over a sample ─────────────────────────────────────────────────

export type DetectionOutcome = {
  findings: AnomalyFinding[]
  baseline: BaselineStore
}

function pushHistory(history: number[], value: number, maxLen: number): number[] {
  const next = [...history, value]
  return next.length > maxLen ? next.slice(next.length - maxLen) : next
}

/**
 * Evaluates a sample against (and then extends) the baseline. Detection runs
 * BEFORE the current value is pushed, so a sample never pollutes the baseline
 * it is measured against.
 */
export function detectAnomalies(
  rawBaseline: BaselineStore,
  sample: AnomalySample,
  opts: Partial<typeof ANOMALY_DEFAULTS> = {},
): DetectionOutcome {
  const o = { ...ANOMALY_DEFAULTS, ...opts }
  const baseline = normalizeBaselineStore(rawBaseline)
  const metrics = baseline.metrics ?? {}
  const findings: AnomalyFinding[] = []

  for (const [metric, value] of Object.entries(sample.volume)) {
    const key = `volume:${metric}`
    const finding = detectValueFinding("volume", metric, metrics[key] ?? [], value, o)
    if (finding) {
      findings.push(finding)
      incSecurityCounter("anomaly_volume_breaches")
    }
    metrics[key] = pushHistory(metrics[key] ?? [], value, o.maxHistory)
  }

  const deltas = counterDeltas(baseline.counters_prev ?? {}, sample.counters)
  for (const [name, delta] of Object.entries(deltas)) {
    const key = `counter:${name}`
    const finding = detectValueFinding("counter", name, metrics[key] ?? [], delta, o)
    if (finding) {
      findings.push(finding)
      incSecurityCounter("anomaly_counter_breaches")
    }
    metrics[key] = pushHistory(metrics[key] ?? [], delta, o.maxHistory)
  }

  const drops = detectBalanceDrops(baseline.balances_prev ?? {}, sample.balances, o)
  for (const finding of drops) {
    findings.push(finding)
    incSecurityCounter("anomaly_balance_breaches")
  }

  baseline.counters_prev = { ...sample.counters }
  baseline.balances_prev = { ...sample.balances }
  baseline.metrics = metrics

  return { findings, baseline }
}

// ─── Data collection (cron) ──────────────────────────────────────────────────

/** Anomaly's own counters are excluded so the detector cannot alert on itself. */
const SELF_COUNTER_PREFIX = "anomaly_"

export async function collectAnomalySample(
  opts: { now?: number; volumeWindowMs?: number } = {},
): Promise<AnomalySample> {
  const now = opts.now ?? Date.now()
  const since = now - (opts.volumeWindowMs ?? ANOMALY_DEFAULTS.volumeWindowMs)

  const volume: Record<string, number> = {}
  try {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(amount_phaselq), 0) AS total, COUNT(*) AS offers
           FROM offers
          WHERE status = 'accepted' AND wash_flagged = 0 AND created_at >= ?`,
      )
      .get(since) as { total: number; offers: number }
    volume.market_volume_phaselq_24h = Number(row?.total ?? 0)
    volume.market_offers_accepted_24h = Number(row?.offers ?? 0)
  } catch {
    // No database yet — volume metrics are simply absent from this sample.
  }

  const counters: Record<string, number> = {}
  for (const [name, value] of Object.entries(snapshotSecurityCounters())) {
    if (name.startsWith(SELF_COUNTER_PREFIX)) continue
    counters[name] = value
  }

  const balances: Record<string, number> = {}
  try {
    const latest = (await getHealthHistory(1))[0]
    if (latest) {
      if (typeof latest.distributorXlm === "number") balances.distributor_xlm = latest.distributorXlm
      if (latest.distributorPhaseLiqStroops !== null) {
        balances.distributor_phase_liq = Number(latest.distributorPhaseLiqStroops) / 10_000_000
      }
      if (typeof latest.issuerXlm === "number") balances.issuer_xlm = latest.issuerXlm
    }
  } catch {
    // Health store unreadable — balance checks skip this run.
  }

  return { ts: now, volume, counters, balances }
}

// ─── Alert routing ───────────────────────────────────────────────────────────

export type AlertRouter = (
  type: WebhookAlertType,
  payload: WebhookAlertPayload,
) => Promise<{ sent: string[]; failed: string[] }>

export function anomalyAlertFor(finding: AnomalyFinding): {
  type: WebhookAlertType
  payload: WebhookAlertPayload
} {
  return {
    type: finding.severity,
    payload: {
      // Distinct per kind+metric: webhook dedup keys on type+title.
      title: `Anomaly ${finding.kind}: ${finding.metric}`,
      message: finding.message,
      kind: finding.kind,
      severity: finding.severity,
      metric: finding.metric,
      value: finding.value,
      ...(finding.z !== null ? { z: finding.z } : {}),
    },
  }
}

export async function routeAnomalyAlerts(
  findings: AnomalyFinding[],
  router: AlertRouter = sendWebhookAlert,
): Promise<{ routed: number; sent: number }> {
  let routed = 0
  let sent = 0
  for (const finding of findings) {
    const { type, payload } = anomalyAlertFor(finding)
    const result = await router(type, payload)
    routed++
    if (result.sent.length > 0) sent++
  }
  if (routed > 0) incSecurityCounter("anomaly_alerts_routed", routed)
  return { routed, sent }
}
