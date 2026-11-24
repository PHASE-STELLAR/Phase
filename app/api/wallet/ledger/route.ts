import { NextRequest, NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { recordSecurityCounter } from "@/lib/security-counters"

/**
 * POST /api/wallet/ledger
 *
 * Telemetry endpoint for tracking Ledger clear-signing lifecycle events:
 * review requested, user approved, user rejected, blind-signing blocked,
 * and gate #13 pre-empted invocations.
 * Gated behind phase-169.
 */
export async function POST(req: NextRequest) {
  if (!isFeatureEnabled("phase-169")) {
    return NextResponse.json({ error: "Ledger clear-signing disabled (phase-169 off)" }, { status: 404 })
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      event?: "review" | "approved" | "rejected" | "blind_blocked" | "gate13_blocked"
      functionName?: string
      contractId?: string
      verificationCode?: string
      account?: string
    }

    if (!body.event) {
      return NextResponse.json({ error: "Missing event parameter" }, { status: 400 })
    }

    switch (body.event) {
      case "review":
        recordSecurityCounter("ledger_clear_signing_reviewed")
        break
      case "approved":
        recordSecurityCounter("ledger_clear_signing_approved")
        break
      case "rejected":
        recordSecurityCounter("ledger_clear_signing_rejected")
        break
      case "blind_blocked":
        recordSecurityCounter("ledger_blind_signing_blocked")
        break
      case "gate13_blocked":
        recordSecurityCounter("ledger_gate13_preempted")
        break
    }

    return NextResponse.json({ ok: true, recorded: body.event })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "Failed to record Ledger telemetry", message }, { status: 500 })
  }
}
