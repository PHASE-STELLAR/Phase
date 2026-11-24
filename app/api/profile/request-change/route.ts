import { NextRequest, NextResponse } from "next/server"
import {
  isProfile2faEnabled,
  requestProfileChangeConfirmation,
  touchesHighValueField,
} from "@/lib/profile-2fa"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  if (!isProfile2faEnabled()) {
    return NextResponse.json({ error: "phase-104 flag disabled" }, { status: 404 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : ""
  if (!wallet || wallet.length < 10) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }
  if (!touchesHighValueField(body)) {
    return NextResponse.json({ error: "no high-value profile fields in payload" }, { status: 400 })
  }

  const { code, expiresAt } = requestProfileChangeConfirmation(wallet, body)

  // In production this code would be delivered over an out-of-band channel
  // (email/SMS/authenticator app tied to the wallet's registered contact).
  // No such channel exists in this codebase yet, so it is returned directly
  // here so the two-step confirmation flow can be exercised end-to-end.
  return NextResponse.json({ ok: true, code, expiresAt })
}
