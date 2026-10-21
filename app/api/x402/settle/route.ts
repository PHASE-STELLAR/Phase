import { complianceGate } from "@/lib/compliance"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { NextRequest, NextResponse } from "next/server"
import { REQUIRED_AMOUNT, tokenContractIdForServer } from "@/lib/phase-protocol"
import { resolveForgeRequiredAmountStroops } from "@/lib/experiments"

export const dynamic = 'force-dynamic'

const PHASE_LIQ_TOKEN_CONTRACT = tokenContractIdForServer()

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

function isSatisfiedPayment(payload: LocalX402Token | null, requiredStroops: string = REQUIRED_AMOUNT): boolean {
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
    const user = body.user_address?.trim()
    if (!token || !user) {
      return NextResponse.json({ error: "Missing payment_token or user_address" }, { status: 400 })
    }

    const payload = decodeX402Token(token)
    // Spike 612: variant-aware floor for the settling payer; control otherwise.
    const requiredStroops = (await resolveForgeRequiredAmountStroops(user)).amountStroops
    if (!isSatisfiedPayment(payload, requiredStroops)) {
    const block = await complianceGate(body.user_address ?? "", String(payload?.amount ?? ""), "x402")
    if (block) return block
    if (!isSatisfiedPayment(payload)) {
      return NextResponse.json({ error: "Invalid or insufficient x402 payment token" }, { status: 401 })
    }

    return NextResponse.json({
      settled: true,
      invoice: payload?.invoice ?? null,
      amount: payload?.amount ?? null,
      payer: user,
      token_contract: PHASE_LIQ_TOKEN_CONTRACT,
      note: "Local settlement shim (demo compatibility)",
    })
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
}

// ── Spike 674 (flag-gated): N-way fan-out happens off-chain at accept/settle time via
// recordCollabSplits (see lib/market-store.ts). This shim still returns demo-settled; when
// phase-collab-splits is on, callers attach `split_payees` (sum bps <= 10000, dust → first
// payee) and idempotency stays txHash-based via markSettlementUsedIfUnused. No payout change
// when flag off.
