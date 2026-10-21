import { NextRequest, NextResponse } from "next/server"
import { evaluateSurfaceBudgets } from "@/lib/cost-budgets"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function validateCronAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET?.trim()

  if (process.env.NODE_ENV === "development" && !cronSecret) {
    return true
  }
  if (req.headers.get("x-vercel-cron")) {
    return true
  }
  if (!cronSecret) return false
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false
  return authHeader.substring(7) === cronSecret
}

/**
 * GET /api/cron/cost-budgets — spike 614 (phase-176).
 *
 * Hourly evaluation of per-surface cost budgets: rolls windows, refreshes the
 * halt cache, and fires deduped webhook alerts on warning/critical/recovery
 * transitions. Response envelope matches the faucet-health cron.
 */
export async function GET(req: NextRequest) {
  if (!validateCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized - valid cron secret required" }, { status: 401 })
  }
  try {
    const evaluation = await evaluateSurfaceBudgets({ sendAlerts: true })
    return NextResponse.json({
      ok: true,
      status: evaluation.halted.length > 0 ? "halted" : evaluation.enabled ? "ok" : "disabled",
      message: evaluation.enabled
        ? `${evaluation.surfaces.length} surfaces evaluated, ${evaluation.halted.length} halted, ${evaluation.alerted.length} alerted`
        : "phase-176 flag disabled",
      results: evaluation,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
