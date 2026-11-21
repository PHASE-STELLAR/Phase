import { type NextRequest, NextResponse } from "next/server"
import { checkAdminKey } from "@/lib/admin-key"
import { incSecurityCounter } from "@/lib/security-counters"
import {
  getSybilDecisionById,
  isSybilGatingEnabled,
  listRecentSybilDecisions,
  listSybilDecisionsByWallet,
} from "@/lib/sybil-resistance"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Operator inspect route for persisted sybil decisions (phase-246, issue #697).
 * Fail-closed: requires valid `x-admin-key` matching `PHASE_ADMIN_KEY`.
 */
export async function GET(request: NextRequest) {
  const auth = checkAdminKey(request)
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "PHASE_ADMIN_KEY is not configured" }, { status: 503 })
  }
  if (auth === "denied") {
    incSecurityCounter("admin_unauthorized_access")
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  if (!isSybilGatingEnabled()) {
    return NextResponse.json({ error: "phase-246 flag disabled" }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const decisionId = searchParams.get("decision_id")?.trim()
  const wallet = searchParams.get("wallet")?.trim()
  const limitRaw = searchParams.get("limit")?.trim()
  const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || 50)) : 50

  if (decisionId) {
    const decision = getSybilDecisionById(decisionId)
    if (!decision) {
      return NextResponse.json({ error: "Decision not found" }, { status: 404 })
    }
    return NextResponse.json({ decision })
  }

  if (wallet) {
    const decisions = listSybilDecisionsByWallet(wallet, limit)
    return NextResponse.json({ decisions, count: decisions.length })
  }

  const decisions = listRecentSybilDecisions(limit)
  return NextResponse.json({ decisions, count: decisions.length })
}
