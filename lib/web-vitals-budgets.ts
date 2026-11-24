/**
 * Web Vitals budgets — partial slice of spike 657 (issue #520).
 *
 * The layout ships a page-view beacon only; there is no per-route budget and no
 * assertion that a route regressed. This module defines the client-side budget
 * table and the pure evaluation used to rate a sample and decide pass/fail, so
 * a `web-vitals` reporter (or a CI Lighthouse run) has one source of truth.
 *
 * Scope: the budget table + evaluation + rating. Wiring a live `onCLS/onINP/onLCP`
 * collector, RUM transport, CSP allow-listing, and PR-blocking gates are spike
 * 657 follow-ups.
 *
 * Feature flag: phase-160. Rollback: unset → no vitals are evaluated/reported;
 * the table stays inert (no persisted state).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

export type VitalName = "LCP" | "INP" | "CLS"
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

export function isWebVitalsBudgetsEnabled(): boolean {
  return isFeatureEnabled("phase-160")
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
