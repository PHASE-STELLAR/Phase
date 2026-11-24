import { NextRequest, NextResponse } from "next/server"
import {
  isAnomalyDetectionEnabled,
  collectAnomalySample,
  detectAnomalies,
  normalizeBaselineStore,
  routeAnomalyAlerts,
} from "@/lib/anomaly-detection"
import { isRestoreInProgress } from "@/lib/backup-snapshot"
import { isCronBlockedInPreview, previewTrustsVercelCronHeader } from "@/lib/preview-isolation"
import { readStore, updateStore } from "@/lib/json-store"
import { incSecurityCounter } from "@/lib/security-counters"

export const dynamic = "force-dynamic"

function validateCronAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET?.trim()

  if (process.env.NODE_ENV === "development" && !cronSecret) {
    return true
  }

  const vercelCronHeader = req.headers.get("x-vercel-cron")
  if (vercelCronHeader && previewTrustsVercelCronHeader()) {
    return true
  }

  if (!cronSecret) return false
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false
  return authHeader.substring(7) === cronSecret
}

export async function GET(req: NextRequest) {
  if (!validateCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized - valid cron secret required" }, { status: 401 })
  }

  if (!isAnomalyDetectionEnabled()) {
    return NextResponse.json(
      { error: "Anomaly detection is disabled (set NEXT_PUBLIC_FEATURE_PHASE_181=1)" },
      { status: 404 },
    )
  }

  if (isCronBlockedInPreview()) {
    incSecurityCounter("preview_cron_blocked")
    return NextResponse.json({ ok: true, skipped: "preview_cron_disabled" })
  }

  // Baselines built on half-restored data would fire false alerts and poison history.
  if (await isRestoreInProgress()) {
    return NextResponse.json(
      { error: "Restore in progress" },
      { status: 503, headers: { "Retry-After": "60" } },
    )
  }

  const stored = await readStore<object>("anomalyBaselines", () => ({}))
  const baseline = normalizeBaselineStore(stored)
  const sample = await collectAnomalySample()
  const { findings, baseline: updated } = detectAnomalies(baseline, sample)

  await updateStore<object, void>("anomalyBaselines", (data) => {
    Object.assign(data, updated)
  })

  const { routed } = await routeAnomalyAlerts(findings)
  incSecurityCounter("anomaly_checks_run")

  return NextResponse.json({
    ok: true,
    checked_at: sample.ts,
    findings,
    alerts_routed: routed,
    timestamp: new Date().toISOString(),
  })
}
