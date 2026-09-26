import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getOffersByBuyer } from "@/lib/market-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const buyer = request.nextUrl.searchParams.get("buyer")?.trim() ?? ""
  if (!buyer || !StrKey.isValidEd25519PublicKey(buyer)) {
    return NextResponse.json({ error: "valid buyer required" }, { status: 400 })
  }
  const offers = await getOffersByBuyer(buyer)
  return NextResponse.json(
    { offers },
    {
      headers: {
        "Cache-Control": "public, max-age=30, s-maxage=30",
      },
    }
  )
}
