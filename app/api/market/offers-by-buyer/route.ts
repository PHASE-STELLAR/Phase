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
  const limit = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 50) || 50))
  const cursor = Math.max(0, Number(request.nextUrl.searchParams.get("cursor") ?? 0) || 0)
  const offers = await getOffersByBuyer(buyer, { limit, cursor })
  return NextResponse.json(
    { offers, nextCursor: offers.length === limit ? cursor + offers.length : null },
    {
      headers: {
        "Cache-Control": "public, max-age=30, s-maxage=30",
      },
    }
  )
}
