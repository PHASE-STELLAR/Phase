import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { cancelScheduledSignal, getScheduledSignals } from "@/lib/signal-store"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const CancelSchema = z.object({
  id: z.string().trim().min(1).max(64),
  wallet: z.string().refine((value) => StrKey.isValidEd25519PublicKey(value), "Invalid wallet"),
  signature: z.string().trim().min(1),
})

function disabled() {
  return NextResponse.json({ error: "Signal scheduling is disabled" }, { status: 404 })
}

export async function GET(request: NextRequest) {
  if (!isFeatureEnabled("phase-89")) return disabled()
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 })
  }
  if (!request.headers.get("x-wallet-signature")?.trim()) {
    return NextResponse.json({ error: "Wallet signature required" }, { status: 401 })
  }
  return NextResponse.json({ signals: await getScheduledSignals(wallet) })
}

export async function DELETE(request: NextRequest) {
  if (!isFeatureEnabled("phase-89")) return disabled()
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const parsed = CancelSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 })
  }
  try {
    const signal = await cancelScheduledSignal(parsed.data.id, parsed.data.wallet)
    return NextResponse.json({ signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to cancel signal"
    return NextResponse.json({ error: message }, { status: message === "Not signal owner" ? 403 : 409 })
  }
}
