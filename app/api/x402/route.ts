import { NextRequest, NextResponse } from "next/server"
import {
  PHASER_LIQ_SYMBOL,
  phaseProtocolContractIdForServer,
  REQUIRED_AMOUNT,
  stroopsToLiqDisplay,
  tokenContractIdForServer,
} from "@/lib/phase-protocol"

export const dynamic = 'force-dynamic'

const PHASE_PROTOCOL_CONTRACT = phaseProtocolContractIdForServer()
const PHASE_LIQ_TOKEN_CONTRACT = tokenContractIdForServer()

const X402_NETWORK = "stellar:testnet"

function localShimEnabled(): boolean {
  return process.env.X402_LOCAL_SHIM_ENABLED?.trim().toLowerCase() === "true"
}

type LocalX402Token = {
  invoice?: string
  amount?: number | string
  token?: string
  network?: string
  resource?: string
  user_address?: string
  contract_id?: string
}

function parseRequiredAmount(): number {
  const parsed = Number.parseInt(REQUIRED_AMOUNT, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function facilitatorUrl(request: NextRequest): string {
  const configured = process.env.X402_FACILITATOR_URL?.trim()
  if (configured) return configured
  return `${request.nextUrl.origin}/api/x402`
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

function isSatisfiedPayment(payload: LocalX402Token | null): boolean {
  if (!payload) return false
  const amount = Number(payload.amount)
  return Boolean(payload.invoice) && Number.isFinite(amount) && amount >= parseRequiredAmount()
}

export async function GET(request: NextRequest) {
  if (!localShimEnabled()) {
    return NextResponse.json({ error: "x402 local shim disabled" }, { status: 503 })
  }
  const authHeader = request.headers.get("authorization")
  const facilitator = facilitatorUrl(request)

  if (authHeader && authHeader.startsWith("x402 ")) {
    const token = authHeader.replace("x402 ", "").trim()
    const payload = decodeX402Token(token)
    if (isSatisfiedPayment(payload)) {
      return NextResponse.json({
        status: "success",
        data: {
          protected_content: "DECRYPTED_PROTOCOL_DATA",
          phase_id: Math.floor(Math.random() * 1000),
          message: "x402 payment accepted by local verifier",
        },
      })
    }
    return NextResponse.json({ error: "Invalid payment token" }, { status: 401 })
  }

  const challenge = {
    protocol: "x402",
    version: "2",
    network: X402_NETWORK,
    token: PHASE_LIQ_TOKEN_CONTRACT,
    contract_id: PHASE_PROTOCOL_CONTRACT,
    token_contract: PHASE_LIQ_TOKEN_CONTRACT,
    amount: parseRequiredAmount(),
    priceDisplay: `${stroopsToLiqDisplay(REQUIRED_AMOUNT)} ${PHASER_LIQ_SYMBOL}`,
    facilitator,
    invoice: `inv_${Date.now()}`,
    resource: request.nextUrl.pathname,
  }

  const challengeBase64 = Buffer.from(JSON.stringify(challenge)).toString("base64")

  return NextResponse.json(
    {
      error: "Payment Required",
      message: "This protected resource requires x402 payment",
      challenge,
    },
    {
      status: 402,
      headers: {
        "WWW-Authenticate": `x402 token="${challengeBase64}", amount="${challenge.amount}", facilitator="${facilitator}", network="${X402_NETWORK}"`,
        "X-Required-Amount": REQUIRED_AMOUNT,
        "X-Token-Address": PHASE_LIQ_TOKEN_CONTRACT,
        "X-Facilitator": facilitator,
        "X-X402-Network": X402_NETWORK,
      },
    }
  )
}

export async function POST(request: NextRequest) {
  if (!localShimEnabled()) {
    return NextResponse.json({ error: "x402 local shim disabled" }, { status: 503 })
  }
  try {
    const facilitator = facilitatorUrl(request)
    const body = await request.json()
    const { payment_token, user_address } = body as {
      payment_token?: string
      user_address?: string
    }

    if (!payment_token || !user_address) {
      return NextResponse.json(
        { error: "Missing payment_token or user_address" },
        { status: 400 }
      )
    }

    const payload = decodeX402Token(payment_token)
    if (!payload || !isSatisfiedPayment(payload)) {
      return NextResponse.json({ error: "Invalid or insufficient x402 payment token" }, { status: 401 })
    }

    return NextResponse.json({
      status: "payment_received",
      invoice_id: payload.invoice,
      amount: payload.amount,
      payer: user_address,
      verified: true,
      network: payload.network || X402_NETWORK,
      facilitator,
    })
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    )
  }
}