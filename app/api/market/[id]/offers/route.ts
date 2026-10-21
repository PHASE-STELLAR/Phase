import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { createOffer, getListing, getOffers, isPhase100Enabled, recordCreatorProfileView, dropStatusForListing, currentDutchPrice, isPhaseTimedDropsEnabled, isPhaseDutchAuctionEnabled } from "@/lib/market-store"
import { createNotification } from "@/lib/notification-store"
import { createApiRequestContext } from "@/lib/api-observability"
import {
  classicPoolIdForAssets,
  decimalToStroops,
  getClassicPoolSnapshot,
  isPhase182Enabled,
  quoteClassicPool,
  type PoolAsset,
} from "@/lib/liquidity-pool"
import { resolvePhaserLiqClassicAsset } from "@/lib/stellar"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/market/[id]/offers")
  const { id } = await params

  try {
    const creatorWallet = request.nextUrl.searchParams.get("creator_wallet")?.trim() ?? ""
    const viewerWallet = request.nextUrl.searchParams.get("viewer_wallet")?.trim() ?? ""
    if (isPhase100Enabled() && creatorWallet && StrKey.isValidEd25519PublicKey(creatorWallet)) {
      await recordCreatorProfileView({
        creator_wallet: creatorWallet,
        viewer_wallet: viewerWallet && StrKey.isValidEd25519PublicKey(viewerWallet) ? viewerWallet : undefined,
        source: "market",
      }).catch((error) => api.log("warn", "market.profile_view.record_failed", { error }))
    }

    const offers = await getOffers(id)
    return api.json(
      { offers, profile_view_analytics_enabled: isPhase100Enabled() },
      { event: "market.offers.loaded", metadata: { listing_id: id } },
    )
  } catch (error) {
    return api.errorJson(error, 500, "market.offers.load_failed")
  }
}

type OfferBody = {
  buyer_wallet?: unknown
  amount_phaselq?: unknown
  message?: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/market/[id]/offers")
  const { id } = await params
  let body: OfferBody
  try {
    body = (await request.json()) as OfferBody
  } catch {
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "market.offer.invalid_json" })
  }

  const buyer_wallet = typeof body.buyer_wallet === "string" ? body.buyer_wallet.trim() : ""
  if (!buyer_wallet || !StrKey.isValidEd25519PublicKey(buyer_wallet)) {
    return api.json(
      { error: "valid buyer_wallet required" },
      { status: 400, event: "market.offer.validation_failed", metadata: { reason: "buyer_wallet" } },
    )
  }

  const amount_phaselq = Number(body.amount_phaselq)
  if (!Number.isFinite(amount_phaselq) || amount_phaselq <= 0) {
    return api.json(
      { error: "amount_phaselq must be positive" },
      { status: 400, event: "market.offer.validation_failed", metadata: { reason: "amount_phaselq" } },
    )
  }

  try {
    const listing = await getListing(id)
    if (!listing) return api.json({ error: "Listing not found" }, { status: 404, event: "market.offer.listing_missing", metadata: { listing_id: id } })
    if (listing.status !== "active") return api.json({ error: "Listing not active" }, { status: 409, event: "market.offer.listing_inactive", metadata: { listing_id: id } })
    if (!listing.accepts_offers) return api.json({ error: "Listing does not accept offers" }, { status: 409, event: "market.offer.disabled", metadata: { listing_id: id } })
    if (listing.min_offer !== undefined && amount_phaselq < listing.min_offer) {
      return api.json(
        { error: `Minimum offer is ${listing.min_offer} PHASELQ` },
        { status: 400, event: "market.offer.validation_failed", metadata: { reason: "min_offer", listing_id: id } },
      )
    }
    // Issue #230: a direct self-deal is a 400, not a flag. There is no
    // legitimate reading of "bid on your own listing", so this one case blocks.
    // Everything subtler (circular, rapid-flip, sybil clusters) is flagged in
    // createOffer and excluded from volume rather than rejected, because
    // blocking those punishes legitimate buyers.
    // Spikes 672/675 (flag-gated): 412 DROP_NOT_STARTED (Retry-After) / 409 DROP_ENDED / 409 DUTCH_QUOTE_STALE.
    if (isPhaseTimedDropsEnabled() && dropStatusForListing(listing) !== "live") {
      const st = dropStatusForListing(listing);
      if (st === "upcoming") {
        const retryAfter = listing.drop_start_at != null ? Math.max(1, Math.min(3600, Math.ceil((listing.drop_start_at - Date.now()) / 1000))) : 60;
        try { const { incSecurityCounter } = await import("@/lib/security-counters"); incSecurityCounter("drop_claim_rejected"); } catch {}
        return api.json({ error: "DROP_NOT_STARTED", drop_start_at: listing.drop_start_at }, { status: 412, headers: { "Retry-After": String(retryAfter) }, metadata: { listing_id: id } });
      }
      try { const { incSecurityCounter } = await import("@/lib/security-counters"); incSecurityCounter("drop_claim_rejected"); } catch {}
      return api.json({ error: "DROP_ENDED" }, { status: 409, event: "market.offer.drop_ended", metadata: { listing_id: id } });
    }
    if (isPhaseDutchAuctionEnabled() && (listing.dutch_start_price != null || listing.dutch_floor_price != null)) {
      const current = currentDutchPrice(listing);
      if (amount_phaselq < current) {
        try { const { incSecurityCounter: inc2 } = await import("@/lib/security-counters"); inc2("dutch_quote_stale_rejected"); } catch {}
        return api.json({ error: "DUTCH_QUOTE_STALE", current_price_phaselq: current }, { status: 409, event: "market.offer.dutch_stale", metadata: { listing_id: id } });
      }
    }

    if (listing.seller_wallet.toUpperCase() === buyer_wallet.toUpperCase()) {
      return api.json(
        { error: "Wash Trade: buyer==seller" },
        { status: 400, event: "market.offer.wash_trade", metadata: { reason: "self_deal", listing_id: id } },
      )
    }

    const message = typeof body.message === "string" ? body.message.trim().slice(0, 200) : undefined
    const offer = await createOffer({ listing_id: id, buyer_wallet, amount_phaselq, message })

    // Spike 574 (phase-182): the offer is denominated in PHASELQ; the pool can
    // say what that amount would actually fetch in XLM. Advisory only — a pool
    // outage must never stop a legitimate offer. The thin-pool warning is what
    // prevents a "spot price" from being read as an executable price.
    let poolPrice: {
      amount_phaselq: number
      spot_price_xlm: number
      execution_price_xlm: number
      price_impact_bps: number
      quote_hash: string
      stale: boolean
      warning: string | null
    } | null = null
    if (isPhase182Enabled()) {
      try {
        const resolved = resolvePhaserLiqClassicAsset()
        const base: PoolAsset = { kind: "credit", code: resolved.code, issuer: resolved.issuer }
        const snapshot = await getClassicPoolSnapshot(classicPoolIdForAssets(base, { kind: "native" }))
        const quote = quoteClassicPool(snapshot, {
          assetIn: base,
          amountInStroops: decimalToStroops(amount_phaselq.toFixed(7)),
          maxPriceImpactBps: 10_000,
        })
        poolPrice = {
          amount_phaselq,
          spot_price_xlm: quote.spotPrice,
          execution_price_xlm: quote.executionPrice,
          price_impact_bps: quote.priceImpactBps,
          quote_hash: quote.quoteHash,
          stale: quote.stale,
          warning: quote.priceImpactBps > 500 ? "thin_pool" : null,
        }
      } catch {
        poolPrice = null
      }
    }

    void createNotification(listing.seller_wallet, "new_offer", {
      listing_id: id,
      token_id: listing.token_id,
      amount: amount_phaselq,
      buyer_wallet,
    }).catch((error) => api.log("warn", "market.offer.notification_failed", { error }))

    return api.json(
      // Issue #230: the wash screen is a flag, so the caller is told whether
      // their offer was excluded from volume rather than finding out from a
      // ranking that ignored them.
      { offer, washScreened: true, ...(poolPrice ? { pool_price: poolPrice } : {}) },
      { status: 201, event: "market.offer.created", metadata: { listing_id: id, offer_id: offer.id } },
    )
  } catch (error) {
    return api.errorJson(error, 500, "market.offer.create_failed")
  }
}
