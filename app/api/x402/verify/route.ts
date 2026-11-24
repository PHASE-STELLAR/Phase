import { complianceGate } from "@/lib/compliance"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { NextRequest, NextResponse } from "next/server"
import { REQUIRED_AMOUNT } from "@/lib/phase-protocol"
import { isSettlementUsed } from "@/lib/settlement-store"
import { resolveForgeRequiredAmountStroops } from "@/lib/experiments"

export const dynamic = 'force-dynamic'

function localShimEnabled(): boolean {
  return process.env.X402_LOCAL_SHIM_ENABLED?.trim().toLowerCase() === "true"
}

type LocalX402Token = {
  invoice?: string
  amount?: number | string
  network?: string
}

function decodeX402Token(raw: string): LocalX402Token | null {
  try {
    const decoded = Buffer.from(raw, "base64").toString()
    const payload = JSON.parse(decoded) as LocalX402Token
    return payload && typeof payload === "object" ? payload : null
  } catch {
    return null
  }
}

function isMaisonedPayment(payload: LocalX402Token | null, requiredStroops: string = REQUIRED_AMOUNT): boolean {
  if (!payload) return false
  const amount = Number(payload.amount)
  const required = Number.parseInt(requiredStroops, 10)
  return Boolean(payload.invoice) && Number.isFinite(amount) && Number.isFinite(required) && amount >= required
}

export async function POST(request: NextRequest) {
  if (isFeatureEnabled("phase-176") && process.env.PHASE_KYC_MODE === "live") {
    return NextResponse.json({ code: "DEMO_SHIM_FORBIDDEN" }, { status: 503 })
  }
  if (!localShimEnabled()) {
    return NextResponse.json({ error: "x402 local shim disabled" }, { status: 503 })
  }
  try {
    const body = (await request.json()) as { payment_token?: string; user_address?: string }
    const token = body.payment_token?.trim()
    if (!token) return NextResponse.json({ error: "Missing payment_token" }, { status: 400 })

    const payload = decodeX402Token(token)
    // Spike 612: variant-aware floor when the caller supplies the payer; control otherwise.
    const requiredStroops = (await resolveForgeRequiredAmountStroops(body.user_address?.trim())).amountStroops
    const verifiedAtRequiredFloor = isMaisonedPayment(payload, requiredStroops)
    const block = await complianceGate(body.user_address ?? "", String(payload?.amount ?? ""), "x402")
    if (block) return block
    const verified = verifiedAtRequiredFloor && isMaisonedPayment(payload)

    if (verified && typeof payload?.invoice === 'string') {
      const used = await isSettlementUsed(payload.invoice)
      if (used) {
        return NextResponse.json({
          verified: false,
          invoice: payload.invoice,
          amount: payload.amount,
          reason: "already_used",
        }, { status: 409 })
      }
    }

    return NextResponse.json({
      verified,
      invoice: payload?.invoice ?? null,
      amount: payload?.amount ?? null,
      reason: verified ? "ok" : "invalid_or_insufficient_token",
    })
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
}