import { NextRequest, NextResponse } from "next/server"
import { isPhase227Enabled, phase227RollbackNote } from "@/lib/backup-shipping"
import { runScheduledBackup } from "@/lib/backup-scheduler"
import { isRestoreInProgress, BackupError } from "@/lib/backup-snapshot"
import { isCronBlockedInPreview, previewTrustsVercelCronHeader } from "@/lib/preview-isolation"
import { incSecurityCounter } from "@/lib/security-counters"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

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

  if (!isPhase227Enabled()) {
    return NextResponse.json(
      { error: `Scheduled off-box backups disabled (phase-227 flag off). ${phase227RollbackNote()}`, code: "FLAG_DISABLED" },
      { status: 404 },
    )
  }

  if (isCronBlockedInPreview()) {
    incSecurityCounter("preview_cron_blocked")
    return NextResponse.json({ ok: true, skipped: "preview_cron_disabled" })
  }

  if (await isRestoreInProgress()) {
    return NextResponse.json(
      { error: "Restore in progress" },
      { status: 503, headers: { "Retry-After": "60" } },
    )
  }

  try {
    const result = await runScheduledBackup()
    return NextResponse.json({
      ok: true,
      result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    if (error instanceof BackupError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 })
    }
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: msg, code: "BACKUP_FAILED" }, { status: 500 })
  }
}
