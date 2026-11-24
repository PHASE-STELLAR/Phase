/**
 * Web Vitals budgets — partial slice of spike 657 (issue #520), extended by
 * phase-213 with a closed-label RUM pipeline and a CI budget gate.
 *
 * The phase-160 slice shipped the per-route budget table and pure evaluation.
 * phase-213 adds:
 *   - `normalizeRoute` / `createRumEvent` — PII-free wire format for the client
 *   - `parseFieldData` / `evaluateFieldData` — p75 evaluation of recorded field
 *     data against those budgets (plus a baseline delta check) for CI
 *   - `formatVitalsMarkdown` — the PR comment body
 *
 * This module is dependency-free apart from the flag registry so it can be
 * imported by the browser collector and by the Node CI evaluator alike. No
 * wallet address, URL, IP or user agent ever enters the pipeline.
 *
 * Feature flag: phase-160 (budget table, rollback: table inert) and phase-213
 * (collector + ingest + gate, rollback: unset flag → no collection/evaluation).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

export type VitalName = "LCP" | "INP" | "CLS"
export type VitalMetric = VitalName
export type VitalRating = "good" | "needs-improvement" | "poor"

export type VitalBudgetMap = Record<VitalName, number>

/** Budgets mirror the Core Web Vitals "good" thresholds, tightened per route. */
export const DEFAULT_VITAL_BUDGETS: VitalBudgetMap = { LCP: 2500, INP: 200, CLS: 0.1 }

export const WEB_VITALS_ROUTE_BUDGETS: Record<string, VitalBudgetMap> = {
  "/": { LCP: 2500, INP: 200, CLS: 0.1 },
  "/explore": { LCP: 2500, INP: 200, CLS: 0.05 },
  "/forge": { LCP: 3000, INP: 300, CLS: 0.1 },
  "/chamber": { LCP: 3000, INP: 300, CLS: 0.1 },
  "/world/[collection_id]": { LCP: 3000, INP: 300, CLS: 0.1 },
  "/profile/[wallet]": { LCP: 3000, INP: 300, CLS: 0.1 },
}

/** Alias retained for the phase-213 evaluator. */
export const ROUTE_VITALS_BUDGETS = WEB_VITALS_ROUTE_BUDGETS

export function isWebVitalsBudgetsEnabled(): boolean {
  return isFeatureEnabled("phase-160")
}

export function isRumCollectorEnabled(): boolean {
  return isFeatureEnabled("phase-213")
}

/**
 * Segment-wise prefix match where a `[param]` pattern segment matches any
 * single path segment (e.g. `/world/[collection_id]` matches `/world/123`).
 */
function matchesRoute(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/").filter(Boolean)
  const pathSegments = path.split("/").filter(Boolean)
  if (patternSegments.length > pathSegments.length) return false
  return patternSegments.every((segment, index) => {
    const isDynamic = segment.startsWith("[") && segment.endsWith("]")
    return isDynamic || segment === pathSegments[index]
  })
}

/** Resolve a route's budget, preferring the most specific matching prefix. */
export function getVitalsBudget(route: string): VitalBudgetMap {
  if (WEB_VITALS_ROUTE_BUDGETS[route]) return WEB_VITALS_ROUTE_BUDGETS[route]
  let best: string | null = null
  for (const candidate of Object.keys(WEB_VITALS_ROUTE_BUDGETS)) {
    if (matchesRoute(candidate, route) && (best === null || candidate.length > best.length)) {
      best = candidate
    }
  }
  return best ? WEB_VITALS_ROUTE_BUDGETS[best] : DEFAULT_VITAL_BUDGETS
}

export type VitalEvaluation = {
  route: string
  name: VitalName
  value: number
  budget: number
  withinBudget: boolean
  rating: VitalRating
}

/** Rate a single vital sample against its route budget (good ≤ budget ≤ poor). */
export function evaluateVital(route: string, name: VitalName, value: number): VitalEvaluation {
  const budget = getVitalsBudget(route)[name]
  const withinBudget = value <= budget
  let rating: VitalRating
  if (withinBudget) rating = "good"
  else if (value <= budget * 2) rating = "needs-improvement"
  else rating = "poor"
  return { route, name, value, budget, withinBudget, rating }
}

export type VitalsSummary = {
  route: string
  withinBudget: boolean
  worst: Record<VitalName, VitalEvaluation | null>
  failures: VitalName[]
}

/**
 * Summarize a batch of samples for one route, keeping the worst reading per
 * vital (the value a budget is actually judged against) and listing failures.
 */
export function summarizeVitals(
  route: string,
  samples: ReadonlyArray<{ name: VitalName; value: number }>,
): VitalsSummary {
  const worst: Record<VitalName, VitalEvaluation | null> = { LCP: null, INP: null, CLS: null }
  for (const sample of samples) {
    const evaluation = evaluateVital(route, sample.name, sample.value)
    const current = worst[sample.name]
    if (!current || evaluation.value > current.value) {
      worst[sample.name] = evaluation
    }
  }
  const failures = (Object.keys(worst) as VitalName[]).filter(
    (name) => worst[name] !== null && !worst[name]!.withinBudget,
  )
  return { route, withinBudget: failures.length === 0, worst, failures }
}

/** Closed event names for whatever reporter consumes these evaluations (no PII). */
export const WEB_VITALS_EVENT_NAMES = [
  "web_vitals.sample",
  "web_vitals.budget_exceeded",
] as const
export type WebVitalsEventName = (typeof WEB_VITALS_EVENT_NAMES)[number]

export function webVitalsBudgetsRollbackNote(): string {
  return "Rollback phase-160: unset NEXT_PUBLIC_FEATURE_PHASE_160 / FEATURE_PHASE_160 or set 0/false and restart. No persisted state."
}

export function rumRollbackNote(): string {
  return "Rollback phase-213: unset NEXT_PUBLIC_FEATURE_PHASE_213 / FEATURE_PHASE_213 or set 0/false and restart. No vitals collected or evaluated; rum-events.json can be deleted."
}

// ─── phase-213: closed-label RUM wire format + CI evaluation ─────────────────

export const VITAL_METRICS: readonly VitalName[] = ["LCP", "INP", "CLS"] as const

/** Minimum samples before a route/metric bucket is evaluated at all. */
export const MIN_SAMPLES_PER_BUCKET = 5
/** A p75 regression beyond this fraction of the baseline also fails the gate. */
export const MAX_ALLOWED_DELTA_PCT = 0.1
export const DELTA_FLOOR: Record<VitalName, number> = { LCP: 50, INP: 10, CLS: 0.01 }

const SESSION_HASH_RE = /^[a-f0-9]{64}$/
const MAX_ROUTE_LENGTH = 120
const MAX_VALUE: Record<VitalName, number> = {
  LCP: 60_000,
  INP: 30_000,
  CLS: 10,
}

/** Segment prefixes whose next path segment is always an identifier. */
const DYNAMIC_PREFIXES = [
  "/signals", "/collection", "/profile", "/world", "/forge", "/chamber", "/nft", "/market",
]

function looksLikeIdentifier(segment: string): boolean {
  if (segment.length >= 32) return true
  if (/^[A-Z0-9]{56}$/.test(segment)) return true
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true
  if (segment.includes("@")) return true
  return false
}

/**
 * Reduce a browser pathname to a PII-free route template. Query strings,
 * fragments, wallet addresses, CIDs and long opaque ids are dropped.
 */
export function normalizeRoute(pathname: unknown): string | null {
  if (typeof pathname !== "string") return null
  let clean = pathname.split(/[?#]/, 1)[0]
  if (!clean.startsWith("/")) clean = `/${clean}`
  const rawSegments = clean.split("/").filter(Boolean)
  const segments: string[] = []
  for (let i = 0; i < Math.min(rawSegments.length, 6); i += 1) {
    const segment = rawSegments[i]
    if (looksLikeIdentifier(segment) || /^\d+$/.test(segment)) {
      segments.push(":id")
      continue
    }
    if (i > 0 && DYNAMIC_PREFIXES.some((prefix) => `/${segments.join("/")}` === prefix)) {
      segments.push(":id")
      continue
    }
    segments.push(segment.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48))
  }
  const route = `/${segments.join("/")}`
  return route.length <= MAX_ROUTE_LENGTH ? route : "/"
}

/** The only payload shape the ingest route accepts. */
export interface RumEvent {
  route: string
  metric: VitalName
  value: number
  sessionHash: string
  ts: number
}

/**
 * Build the wire payload. Extra input keys are discarded, so no PII can ride
 * along. Returns `null` for malformed input rather than throwing in browser.
 */
export function createRumEvent(input: {
  route?: unknown
  metric?: unknown
  value?: unknown
  sessionHash?: unknown
  ts?: unknown
}): RumEvent | null {
  const route = normalizeRoute(input.route)
  if (!route) return null
  const metric = input.metric
  if (metric !== "LCP" && metric !== "INP" && metric !== "CLS") return null
  const value = input.value
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_VALUE[metric]) {
    return null
  }
  const sessionHash = input.sessionHash
  if (typeof sessionHash !== "string" || !SESSION_HASH_RE.test(sessionHash)) return null
  const ts = input.ts
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 60_000) {
    return null
  }
  return { route, metric, value, sessionHash, ts: Math.floor(ts) }
}

/** Accepts parsed JSON and returns only well-formed events. */
export function parseFieldData(raw: unknown): RumEvent[] {
  if (!Array.isArray(raw)) return []
  const out: RumEvent[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const event = createRumEvent(entry as Record<string, unknown>)
    if (event) out.push(event)
  }
  return out
}

/** 75th percentile (nearest-rank), or `null` for an empty sample. */
export function computeP75(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(0.75 * sorted.length))
  return sorted[rank - 1]
}

export interface FieldVitalEvaluation {
  route: string
  metric: VitalName
  p75: number
  budget: number
  samples: number
  baselineP75: number | null
  deltaPct: number | null
  overBudget: boolean
  regressed: boolean
}

export interface VitalsReport {
  generatedAt: string
  evaluations: FieldVitalEvaluation[]
  regressions: string[]
}

function groupP75(events: readonly RumEvent[]): Map<string, { p75: number; samples: number }> {
  const grouped = new Map<string, number[]>()
  for (const event of events) {
    const key = `${event.route}\u0000${event.metric}`
    const bucket = grouped.get(key) ?? []
    bucket.push(event.value)
    grouped.set(key, bucket)
  }
  const result = new Map<string, { p75: number; samples: number }>()
  for (const [key, values] of grouped) {
    if (values.length < MIN_SAMPLES_PER_BUCKET) continue
    const p75 = computeP75(values)
    if (p75 !== null) result.set(key, { p75, samples: values.length })
  }
  return result
}

/**
 * Evaluate recorded field data against the per-route budgets and an optional
 * baseline. Budget breaches and large positive deltas both fail the gate.
 */
export function evaluateFieldData(
  events: readonly RumEvent[],
  baselineEvents: readonly RumEvent[] = [],
): VitalsReport {
  const current = groupP75(events)
  const baseline = groupP75(baselineEvents)
  const evaluations: FieldVitalEvaluation[] = []
  const regressions: string[] = []

  for (const key of Array.from(current.keys()).sort()) {
    const [route, rawMetric] = key.split("\u0000")
    const metric = rawMetric as VitalName
    if (!VITAL_METRICS.includes(metric)) continue
    const { p75, samples } = current.get(key)!
    const budget = getVitalsBudget(route)[metric]
    const baselineP75 = baseline.get(key)?.p75 ?? null
    const deltaPct = baselineP75 && baselineP75 > 0 ? (p75 - baselineP75) / baselineP75 : null
    const overBudget = p75 > budget
    const regressed =
      overBudget ||
      (deltaPct !== null &&
        deltaPct > MAX_ALLOWED_DELTA_PCT &&
        p75 - (baselineP75 ?? 0) > DELTA_FLOOR[metric])
    evaluations.push({
      route, metric, p75, budget, samples, baselineP75, deltaPct, overBudget, regressed,
    })
    if (regressed) regressions.push(`${route} ${metric} p75=${p75} budget=${budget}`)
  }

  return { generatedAt: new Date().toISOString(), evaluations, regressions }
}

/** Non-zero regressions block the PR. */
export function hasRegression(report: VitalsReport): boolean {
  return report.regressions.length > 0
}

function formatNumber(metric: VitalName, value: number): string {
  return metric === "CLS" ? value.toFixed(3) : `${Math.round(value)} ms`
}

/** Markdown body for the PR comment. */
export function formatVitalsMarkdown(report: VitalsReport): string {
  const lines: string[] = [
    "## Web Vitals budget (phase-213)",
    "",
    "| Route | Metric | p75 | Budget | Δ vs baseline | Samples | Status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ]
  if (report.evaluations.length === 0) {
    lines.push("| _no route reached the minimum sample count_ | — | — | — | — | — | — |")
  }
  for (const evaluation of report.evaluations) {
    const delta =
      evaluation.deltaPct === null
        ? "—"
        : `${evaluation.deltaPct >= 0 ? "+" : ""}${(evaluation.deltaPct * 100).toFixed(1)}%`
    lines.push(
      `| \`${evaluation.route}\` | ${evaluation.metric} | ${formatNumber(evaluation.metric, evaluation.p75)} ` +
        `| ${formatNumber(evaluation.metric, evaluation.budget)} | ${delta} | ${evaluation.samples} ` +
        `| ${evaluation.regressed ? "FAIL" : "PASS"} |`,
    )
  }
  lines.push("")
  if (report.regressions.length > 0) {
    lines.push(`**Gate: FAIL** — ${report.regressions.length} regression(s):`)
    for (const regression of report.regressions) lines.push(`- ${regression}`)
  } else {
    lines.push("**Gate: PASS** — no configured budget regressions.")
  }
  return lines.join("\n")
}
