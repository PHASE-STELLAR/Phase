import { NextRequest, NextResponse } from "next/server"
import { isRetentionErasureEnabled, runRetentionSweeps, RetentionErasureError } from "@/lib/retention-erasure"
import { isRestoreInProgress } from "@/lib/backup-snapshot"
import { isCronBlockedInPreview, previewTrustsVercelCronHeader } from "@/lib/preview-isolation"
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

  if (!isRetentionErasureEnabled()) {
    return NextResponse.json(
      { error: "Retention sweeps are disabled (set NEXT_PUBLIC_FEATURE_PHASE_179=1)" },
      { status: 404 },
    )
  }

  if (isCronBlockedInPreview()) {
    incSecurityCounter("preview_cron_blocked")
    return NextResponse.json({ ok: true, skipped: "preview_cron_disabled" })
  }

  // Sweeping prunes sidecars — running mid-restore would fight the restore write.
  if (await isRestoreInProgress()) {
    return NextResponse.json(
      { error: "Restore in progress" },
      { status: 503, headers: { "Retry-After": "60" } },
    )
  }

  try {
    const result = await runRetentionSweeps()
    return NextResponse.json({
      ok: true,
      total_removed: result.total_removed,
      sweeps: result.sweeps,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    if (error instanceof RetentionErasureError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 })
    }
    throw error
  }
}
