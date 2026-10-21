import { z } from "zod"
import { flagRollbackNote, isFeatureEnabled } from "@/lib/feature-flags"
import { updateStoreWithReader } from "@/lib/json-store"
import { sendWebhookAlert } from "@/lib/webhook-alerts"

// ── Spike 614 (phase-176): cost accounting per surface with budgets, burn-rate
// alerts and kill-switches ──
//
// Infra spend was attributed (phase-138 in-memory units, cost-attribution
// ledger estimates) but never bounded: nothing stopped a runaway surface from
// burning budget unattended, and there was no per-surface kill-switch on the
// server side (only the contract mainnet kill-switch exists). This module books
// cost units per closed surface into a persisted daily window, evaluates
// budgets with warning/critical thresholds, fires deduped webhook alerts on
// level transitions, and halts a surface when it exceeds budget so routes can
// refuse with 503 + Retry-After.
//
// Feature flag: phase-176 (NEXT_PUBLIC_FEATURE_PHASE_176 / FEATURE_PHASE_176)
// Rollback: unset the flag → chargeSurfaceCost is a no-op, isSurfaceHalted
//           always false, evaluate reports disabled; cost-budgets.json stays
//           inert on disk. No migration to undo.
//
// Closed labels only: surfaces and statuses come from as-const sets — never a
// wallet, request id or other unbounded value (see lib/security-counters.ts).

export function isCostBudgetsEnabled(): boolean {
  return isFeatureEnabled("phase-176")
}

export function costBudgetsRollbackNote(): string {
  return flagRollbackNote("phase-176")
}

export const COST_SURFACES = [
  "faucet",
  "forge",
  "agent",
  "chamber",
  "explore",
  "profile",
  "world",
  "market",
] as const
export type CostSurface = (typeof COST_SURFACES)[number]

export const BUDGET_STATUSES = ["ok", "warning", "critical", "halted"] as const
export type BudgetStatus = (typeof BUDGET_STATUSES)[number]

const SurfaceSchema = z.enum(COST_SURFACES)

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Budget per surface in cost units; unset/0 → unlimited (inert surface). */
export function surfaceBudgetUnits(surface: CostSurface): number {
  const raw = process.env[`PHASE_COST_BUDGET_${surface.toUpperCase()}`]?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function budgetWindowMs(): number {
  const parsed = Number.parseInt(process.env.PHASE_COST_BUDGET_WINDOW_MS ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_WINDOW_MS
}

function warningRatio(): number {
  const parsed = Number.parseFloat(process.env.PHASE_COST_BUDGET_WARNING_RATIO ?? "")
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : 0.8
}

type SurfaceWindow = {
  windowStart: number
  spentUnits: number
  /** Last emitted alert level; drives transition-only alerting. */
  alertLevel: BudgetStatus
  updatedAt: number
}

type CostBudgetsStore = {
  version: number
  windows: Partial<Record<CostSurface, SurfaceWindow>>
}

function emptyStore(): CostBudgetsStore {
  return { version: 1, windows: {} }
}

function normalizeStore(raw: unknown): CostBudgetsStore {
  const s = raw as CostBudgetsStore | undefined
  if (!s || typeof s !== "object" || !s.windows || typeof s.windows !== "object") return emptyStore()
  return { version: typeof s.version === "number" && s.version > 0 ? s.version : 1, windows: s.windows }
}

// Process-local halt cache: routes check isSurfaceHalted() on the hot path and
// must not hit disk per request. chargeSurfaceCost / evaluateSurfaceBudgets
// refresh it under the file lock; a cold process re-learns on first charge or
// cron evaluation.
const haltedCache = new Set<CostSurface>()

export function isSurfaceHalted(surface: CostSurface): boolean {
  return isCostBudgetsEnabled() && haltedCache.has(surface)
}

export class SurfaceHaltedError extends Error {
  code: "SURFACE_HALTED"
  surface: CostSurface
  constructor(surface: CostSurface) {
    super(`Cost budget exceeded for surface "${surface}"`)
    this.name = "SurfaceHaltedError"
    this.code = "SURFACE_HALTED"
    this.surface = surface
  }
}

export function assertSurfaceOpen(surface: CostSurface): void {
  if (isSurfaceHalted(surface)) throw new SurfaceHaltedError(surface)
}

// Closed counter names — no wallet/token/request cardinality.
const counters = new Map<string, number>()

export function snapshotCostBudgetCounters(): Record<string, number> {
  return Object.fromEntries(counters)
}

export function resetCostBudgetCountersForTests(): void {
  counters.clear()
  haltedCache.clear()
}

function bump(name: "budget_charge_total" | "budget_halt_refusal" | "budget_alert_sent" | "budget_window_rolled", by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by)
}

function levelFor(spent: number, budget: number): BudgetStatus {
  if (budget <= 0) return "ok"
  if (spent >= budget) return "halted"
  if (spent >= budget * warningRatio()) return "warning"
  return "ok"
}

function rollIfNeeded(win: SurfaceWindow, now: number): SurfaceWindow {
  if (now - win.windowStart < budgetWindowMs()) return win
  return { windowStart: now, spentUnits: 0, alertLevel: "ok", updatedAt: now }
}

export type SurfaceChargeResult = {
  ok: boolean
  surface: CostSurface
  spentUnits: number
  budgetUnits: number
  status: BudgetStatus
  reason?: "flag_disabled" | "halted" | "invalid"
}

/**
 * Books cost units against a surface's daily window. No-op (ok, flag_disabled)
 * when the flag is off. Refuses (ok=false, halted) when the surface is already
 * halted so expensive work stops before it starts.
 */
export async function chargeSurfaceCost(
  surface: CostSurface,
  units: number,
  opts: { requestId?: string; now?: number } = {},
): Promise<SurfaceChargeResult> {
  const parsedSurface = SurfaceSchema.safeParse(surface)
  const parsedUnits = Number.isFinite(units) && units >= 0
  const budget = parsedSurface.success ? surfaceBudgetUnits(parsedSurface.data) : 0
  if (!parsedSurface.success || !parsedUnits) {
    return { ok: false, surface: (parsedSurface.success ? surface : "forge"), spentUnits: 0, budgetUnits: budget, status: "ok", reason: "invalid" }
  }
  if (!isCostBudgetsEnabled()) {
    return { ok: true, surface, spentUnits: 0, budgetUnits: budget, status: "ok", reason: "flag_disabled" }
  }
  if (haltedCache.has(surface)) {
    bump("budget_halt_refusal")
    return { ok: false, surface, spentUnits: 0, budgetUnits: budget, status: "halted", reason: "halted" }
  }

  const now = opts.now ?? Date.now()
  const result = await updateStoreWithReader<CostBudgetsStore, SurfaceChargeResult>(
    "costBudgets",
    normalizeStore,
    (store) => {
      let win = store.windows[surface] ?? { windowStart: now, spentUnits: 0, alertLevel: "ok", updatedAt: now }
      if (now - win.windowStart >= budgetWindowMs()) {
        bump("budget_window_rolled")
        win = { windowStart: now, spentUnits: 0, alertLevel: "ok", updatedAt: now }
      }
      win.spentUnits += units
      win.updatedAt = now
      const status = levelFor(win.spentUnits, budget)
      store.windows[surface] = win
      store.version += 1
      if (status === "halted") haltedCache.add(surface)
      bump("budget_charge_total")
      return { ok: status !== "halted", surface, spentUnits: win.spentUnits, budgetUnits: budget, status }
    },
  )
  return result
}

export type SurfaceBudgetReport = {
  surface: CostSurface
  budgetUnits: number
  spentUnits: number
  remainingUnits: number
  burnPerHour: number
  status: BudgetStatus
  windowStart: number
}

export type BudgetEvaluation = {
  enabled: boolean
  windowMs: number
  surfaces: SurfaceBudgetReport[]
  halted: CostSurface[]
  alerted: CostSurface[]
}

async function fireAlert(surface: CostSurface, report: SurfaceBudgetReport): Promise<void> {
  const type = report.status === "halted" ? "critical" : report.status === "warning" ? "warning" : "info"
  try {
    await sendWebhookAlert(type, {
      title:
        report.status === "halted"
          ? `🔴 Cost budget halted: ${surface}`
          : report.status === "warning"
            ? `🟠 Cost budget warning: ${surface}`
            : `✅ Cost budget recovered: ${surface}`,
      message: `Surface ${surface}: ${report.spentUnits}/${report.budgetUnits} units this window (burn ${report.burnPerHour.toFixed(1)}/h).`,
      surface,
      spentUnits: report.spentUnits,
      budgetUnits: report.budgetUnits,
      burnPerHour: Number(report.burnPerHour.toFixed(2)),
      status: report.status,
    })
    bump("budget_alert_sent")
  } catch {
    // Alerting must never fail the evaluation path.
  }
}

/**
 * Evaluates every surface budget, refreshes the halt cache, and fires a
 * webhook alert on alert-level transitions only (ok→warning, warning→halted,
 * *→ok recovery). Called from the cost-budgets cron.
 */
export async function evaluateSurfaceBudgets(
  opts: { now?: number; sendAlerts?: boolean } = {},
): Promise<BudgetEvaluation> {
  if (!isCostBudgetsEnabled()) {
    return { enabled: false, windowMs: budgetWindowMs(), surfaces: [], halted: [], alerted: [] }
  }
  const now = opts.now ?? Date.now()
  const sendAlerts = opts.sendAlerts ?? true

  const { reports, transitions } = await updateStoreWithReader<
    CostBudgetsStore,
    { reports: SurfaceBudgetReport[]; transitions: SurfaceBudgetReport[] }
  >("costBudgets", normalizeStore, (store) => {
    const reports: SurfaceBudgetReport[] = []
    const transitions: SurfaceBudgetReport[] = []
    for (const surface of COST_SURFACES) {
      const budget = surfaceBudgetUnits(surface)
      const rawWin = store.windows[surface]
      const win = rawWin ? rollIfNeeded(rawWin, now) : { windowStart: now, spentUnits: 0, alertLevel: "ok" as BudgetStatus, updatedAt: now }
      // Keep the live object in the store so alertLevel mutations persist.
      store.windows[surface] = win
      win.updatedAt = now
      const status = levelFor(win.spentUnits, budget)
      const elapsedH = Math.max(0.001, (now - win.windowStart) / 3_600_000)
      const report: SurfaceBudgetReport = {
        surface,
        budgetUnits: budget,
        spentUnits: win.spentUnits,
        remainingUnits: budget > 0 ? Math.max(0, budget - win.spentUnits) : Number.MAX_SAFE_INTEGER,
        burnPerHour: win.spentUnits / elapsedH,
        status,
        windowStart: win.windowStart,
      }
      reports.push(report)
      if (status !== win.alertLevel) {
        transitions.push(report)
        win.alertLevel = status
      }
      if (status === "halted") haltedCache.add(surface)
      else haltedCache.delete(surface)
    }
    store.version += 1
    return { reports, transitions }
  })

  const alerted: CostSurface[] = []
  if (sendAlerts) {
    for (const report of transitions) {
      await fireAlert(report.surface, report)
      alerted.push(report.surface)
    }
  }

  return {
    enabled: true,
    windowMs: budgetWindowMs(),
    surfaces: reports,
    halted: reports.filter((r) => r.status === "halted").map((r) => r.surface),
    alerted,
  }
}
