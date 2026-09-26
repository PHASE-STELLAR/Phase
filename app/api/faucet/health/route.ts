import { NextResponse } from "next/server"
import { getHealthSummary } from "@/lib/distributor-health-store"

/**
 * GET /api/faucet/health
 *
 * Returns distributor health status for UI display
 * - Current health status
 * - Recent history
 * - Time until next check
 */

export const dynamic = 'force-dynamic'

let lastHealthCheckTime = 0
const MIN_CHECK_INTERVAL_MS = 5000

export async function GET() {
  const now = Date.now()
  if (now - lastHealthCheckTime < MIN_CHECK_INTERVAL_MS) {
    return NextResponse.json(
      { ok: false, error: "Rate limited - check again in a moment" },
      { status: 429, headers: { "Retry-After": "5" } }
    )
  }
  lastHealthCheckTime = now

  try {
    const summary = await getHealthSummary()
    
    // Calculate human-readable status
    const status = summary.current?.status ?? "unknown"
    const statusMessages = {
      healthy: "All systems operational",
      warning: "Low balance warning - auto-refill may be triggered",
      critical: "Critical - manual intervention may be required",
      error: "Unable to check status",
      unknown: "Status unknown - health check not yet run",
    }

    return NextResponse.json({
      ok: true,
      status,
      message: statusMessages[status as keyof typeof statusMessages] ?? statusMessages.unknown,
      current: summary.current ? {
        distributorPhaseLiq: summary.current.distributorPhaseLiqStroops 
          ? (Number(summary.current.distributorPhaseLiqStroops) / 10_000_000).toFixed(2)
          : null,
        distributorXlm: summary.current.distributorXlm?.toFixed(2) ?? null,
        issuerPhaseLiq: summary.current.issuerPhaseLiqStroops
          ? (Number(summary.current.issuerPhaseLiqStroops) / 10_000_000).toFixed(2)
          : null,
        issuerXlm: summary.current.issuerXlm?.toFixed(2) ?? null,
        checkedAt: new Date(summary.current.checkedAt).toISOString(),
        message: summary.current.message,
      } : null,
      recentHistory: summary.recentHistory.map(record => ({
        status: record.status,
        message: record.message,
        checkedAt: new Date(record.checkedAt).toISOString(),
      })),
      lastRefillAt: summary.lastRefillAt ? new Date(summary.lastRefillAt).toISOString() : null,
      nextCheckIn: summary.timeUntilNextCheck > 0 
        ? {
            ms: summary.timeUntilNextCheck,
            minutes: Math.ceil(summary.timeUntilNextCheck / 60000),
            humanReadable: formatDuration(summary.timeUntilNextCheck),
          }
        : null,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 }
    )
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}
