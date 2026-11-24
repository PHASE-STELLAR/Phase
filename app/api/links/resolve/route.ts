import { NextRequest, NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { parsePhaseLink } from "@/lib/deep-links"
import { getListing, getOffers } from "@/lib/market-store"
import { getQuestRegistry } from "@/lib/quest-registry"
import { incSecurityCounter } from "@/lib/security-counters"

export const runtime = "nodejs"
export async function GET(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" }
  if (!isFeatureEnabled("phase-175")) return NextResponse.json({ code: "DISABLED" }, { status: 404, headers })
  let intent
  try { intent = parsePhaseLink(request.nextUrl.searchParams.get("link") ?? "", request.nextUrl.origin) }
  catch {
    incSecurityCounter("deep_link_rejected")
    return NextResponse.json({ code: "INVALID_LINK" }, { status: 400, headers })
  }
  try {
    let href: string
    let context: Record<string, unknown> = {}
    if (intent.kind === "offer") {
      const listing = await getListing(intent.id)
      const offer = (await getOffers(intent.id)).find(o => o.id === intent.offerId)
      if (!listing || listing.status !== "active" || !offer || offer.status !== "pending" || offer.expires_at <= Date.now()) {
        return NextResponse.json({ code: "INTENT_UNAVAILABLE" }, { status: 410, headers })
      }
      href = `/dashboard?listing=${encodeURIComponent(intent.id)}&offer=${encodeURIComponent(intent.offerId!)}`
      context = { seller: listing.seller_wallet, buyer: offer.buyer_wallet, amount: offer.amount_phaselq, status: offer.status }
    } else if (intent.kind === "quest") {
      const quest = (await getQuestRegistry()).quests.find(q => q.id === intent.id && q.enabled)
      if (!quest) return NextResponse.json({ code: "INTENT_UNAVAILABLE" }, { status: 410, headers })
      href = `/forge?quest=${encodeURIComponent(intent.id)}`
      context = { questId: quest.id }
    } else href = `/chamber?collection=${intent.id}`
    // Recipient/referral values are review context, never transaction authority.
    incSecurityCounter("deep_link_resolved")
    return NextResponse.json({ intent, href, context }, { headers })
  } catch {
    return NextResponse.json({ code: "INTENT_LOOKUP_UNAVAILABLE" }, { status: 503, headers: { ...headers, "Retry-After": "5" } })
  }
}
