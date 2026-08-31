import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getListing,
  getOffers,
  updateOfferStatus,
  soldListing,
  isPhase140Enabled,
  computeRoyaltySplit,
  recordRoyaltyPayout,
} from "@/lib/market-store"
import { createNotification } from "@/lib/notification-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ActionBody = { action?: unknown; wallet?: unknown }

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; offer_id: string }> },
) {
  const { id, offer_id } = await params
  let body: ActionBody
  try { body = (await request.json()) as ActionBody }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "valid wallet required" }, { status: 400 })
  }

  const action = body.action
  if (action !== "accept" && action !== "reject") {
    return NextResponse.json({ error: "action must be accept or reject" }, { status: 400 })
  }

  const listing = await getListing(id)
  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 })
  if (listing.seller_wallet !== wallet) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const offers = await getOffers(id)
  const offer = offers.find((o) => o.id === offer_id)
  if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404 })
  if (offer.status !== "pending") return NextResponse.json({ error: "Offer not pending" }, { status: 409 })

  const newStatus = action === "accept" ? "accepted" : "rejected"
  const updated = await updateOfferStatus(offer_id, newStatus)

  // If accepted, mark listing as sold
  let royalty: Awaited<ReturnType<typeof recordRoyaltyPayout>> | null = null
  if (action === "accept") {
    await soldListing(id)

    // phase-140: split proceeds with the original creator on a secondary sale.
    if (isPhase140Enabled()) {
      const split = computeRoyaltySplit(listing, offer.amount_phaselq)
      if (split.is_secondary_sale && split.royalty_bps > 0) {
        royalty = await recordRoyaltyPayout(listing, offer.id, split)
        void createNotification(listing.creator_wallet!, "royalty_payout", {
          listing_id: id,
          token_id: listing.token_id,
          amount_phaselq: royalty.royalty_amount_phaselq,
          seller_wallet: listing.seller_wallet,
        }).catch(() => { /* silent */ })
      }
    }

    void createNotification(offer.buyer_wallet, "offer_accepted", { listing_id: id, token_id: listing.token_id })
      .catch(() => { /* silent */ })
  } else {
    void createNotification(offer.buyer_wallet, "offer_rejected", { listing_id: id, token_id: listing.token_id })
      .catch(() => { /* silent */ })
  }

  return NextResponse.json({ ok: true, offer: updated, ...(royalty ? { royalty } : {}) })
}
