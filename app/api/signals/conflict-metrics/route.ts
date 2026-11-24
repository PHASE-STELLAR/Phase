/**
 * GET /api/signals/conflict-metrics
 *
 * Read-only summary of signal version conflict counters (#734).
 * Returns the current in-process snapshot — no authentication required
 * since all values are aggregate counts with no user-identifiable data.
 */
import { NextResponse } from "next/server"
import { snapshotSignalVersionMetrics } from "@/lib/signal-version-metrics"

export const dynamic = "force-dynamic"

export async function GET() {
  const snapshot = snapshotSignalVersionMetrics()
  return NextResponse.json(snapshot, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  })
}
