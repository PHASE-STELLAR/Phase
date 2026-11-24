import { NextResponse } from "next/server"
import {
  COST_SURFACES,
  evaluateSurfaceBudgets,
  isCostBudgetsEnabled,
  isSurfaceHalted,
  snapshotCostBudgetCounters,
} from "@/lib/cost-budgets"

export const dynamic = "force-dynamic"

/**
 * GET /api/cost-budgets/health — spike 614 (phase-176).
 *
 * Operator view of per-surface budgets, burn rate and kill-switch state.
 * Evaluation runs without alerts (alerts belong to the cron) so a dashboard
 * poll cannot spam webhooks.
 */
export async function GET() {
  if (!isCostBudgetsEnabled()) {
    return NextResponse.json({ error: "phase-176 flag disabled" }, { status: 404 })
  }
  const evaluation = await evaluateSurfaceBudgets({ sendAlerts: false })
  return NextResponse.json({
    ok: true,
    surfaces: evaluation.surfaces,
    halted: evaluation.halted,
    killSwitch: Object.fromEntries(COST_SURFACES.map((s) => [s, isSurfaceHalted(s)])),
    counters: snapshotCostBudgetCounters(),
    timestamp: new Date().toISOString(),
  })
}
