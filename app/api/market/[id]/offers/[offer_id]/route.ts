import { isFeatureEnabled } from "@/lib/feature-flags"
import { verifySignalSignature } from "@/lib/viewer-signature"
import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  decideOfferAtomic,
  getListing,
  getOffers,
  updateOfferStatus,
  soldListing,
  isPhase140Enabled,
  computeRoyaltySplit,
  recordRoyaltyPayout,
  computeCollabSplits,
  isPhaseCollabSplitsEnabled,
  recordCollabSplits,
} from "@/lib/market-store"
import { createNotification } from "@/lib/notification-store"
import { isPricingOracleEnabled, markSuggestionSold } from "@/lib/pricing-oracle"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ActionBody = { action?: unknown; wallet?: unknown; timestamp?: unknown; signature?: unknown }

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

  const atomic = isFeatureEnabled("phase-175") || isFeatureEnabled("phase-177")
  if (atomic) {
    const timestamp = body.timestamp
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 300_000 || typeof body.signature !== "string" ||
      !(await verifySignalSignature(wallet, { title: `market:${id}:${offer_id}:${action}`, body: wallet, timestamp }, body.signature))) {
      return NextResponse.json({ code: "INVALID_SIGNATURE" }, { status: 401 })
    }
  }
  const listing = await getListing(id)
  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 })
  if (listing.seller_wallet !== wallet) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const offers = await getOffers(id)
  const offer = offers.find((o) => o.id === offer_id)
  if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404 })
  if (offer.status !== "pending") return NextResponse.json({ error: "Offer not pending" }, { status: 409 })

  const newStatus = action === "accept" ? "accepted" : "rejected"
  let updated
  try { updated = atomic ? decideOfferAtomic(id, offer_id, wallet, action) : await updateOfferStatus(offer_id, newStatus) }
  catch (error) {
    return NextResponse.json({ code: "OFFER_CONFLICT", current_status: error instanceof Error && "current_status" in error ? error.current_status : "unavailable" }, { status: 409 })
  }

  // If accepted, mark listing as sold
  let royalty: Awaited<ReturnType<typeof recordRoyaltyPayout>> | null = null
  let splits: Awaited<ReturnType<typeof recordCollabSplits>> | null = null
  if (action === "accept") {
    if (!atomic) await soldListing(id)

    // phase-143: time-to-sale for the suggestion this listing was priced from.
    if (isPricingOracleEnabled()) {
      try {
        markSuggestionSold(id)
      } catch (error) {
        console.warn("[phase-143] time-to-sale not stamped:", error)
      }
    }

    // Spike 674 (flag-gated): N-way fan-out at accept (dust → first payee, idempotent per offer).
    if (isPhaseCollabSplitsEnabled() && listing.split_payees && listing.split_payees.length > 0) {
      const computed = computeCollabSplits(offer.amount_phaselq, listing.split_payees)
      splits = await recordCollabSplits(id, offer.id, computed)
    }

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
