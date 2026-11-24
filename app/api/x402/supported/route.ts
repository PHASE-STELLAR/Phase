import { NextRequest, NextResponse } from "next/server"
import { REQUIRED_AMOUNT, tokenContractIdForServer } from "@/lib/phase-protocol"

export const dynamic = 'force-dynamic'

const PHASE_LIQ_TOKEN_CONTRACT = tokenContractIdForServer()

const X402_NETWORK = "stellar:testnet"

function facilitatorUrl(request: NextRequest): string {
  const configured = process.env.X402_FACILITATOR_URL?.trim()
  if (configured) return configured
  return `${request.nextUrl.origin}/api/x402`
}

export async function GET(request: NextRequest) {
  const facilitator = facilitatorUrl(request)
  return NextResponse.json({
    protocol: "x402",
    version: "2",
    network: X402_NETWORK,
    facilitator,
    endpoints: {
      verify: `${facilitator}/verify`,
      settle: `${facilitator}/settle`,
      supported: `${facilitator}/supported`,
    },
    assets: [
      {
        token_contract: PHASE_LIQ_TOKEN_CONTRACT,
        amount: Number.parseInt(REQUIRED_AMOUNT, 10),
        decimals: 7,
      },
    ],
  })
}
