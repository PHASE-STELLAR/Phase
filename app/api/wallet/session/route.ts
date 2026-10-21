import { NextRequest, NextResponse } from "next/server"
import { isWcResilienceEnabled } from "@/lib/walletconnect-resilience"
import { recordSecurityCounter } from "@/lib/security-counters"

/**
 * POST /api/wallet/session
 *
 * Telemetry endpoint for tracking wallet session transitions:
 * connects, drops, reconnect attempts, and chain mismatches.
 * Gated behind phase-167.
 */
export async function POST(req: NextRequest) {
  if (!isWcResilienceEnabled()) {
    return NextResponse.json({ error: "WalletConnect resilience disabled (phase-167 off)" }, { status: 404 })
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      walletType?: string
      event?: "connect" | "disconnect" | "expire" | "reconnect_success" | "reconnect_fail" | "chain_mismatch"
      topic?: string
      chain?: string
      peerName?: string
      latencyMs?: number
    }

    if (!body.event) {
      return NextResponse.json({ error: "Missing event parameter" }, { status: 400 })
    }

    switch (body.event) {
      case "connect":
        recordSecurityCounter("wc_session_restored")
        break
      case "expire":
        recordSecurityCounter("wc_session_expired")
        break
      case "reconnect_success":
        recordSecurityCounter("wc_reconnect_success")
        break
      case "reconnect_fail":
        recordSecurityCounter("wc_reconnect_failed")
        break
      case "chain_mismatch":
        recordSecurityCounter("wc_chain_mismatch_blocked")
        break
    }

    return NextResponse.json({ ok: true, recorded: body.event })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "Failed to record session telemetry", message }, { status: 500 })
  }
}
