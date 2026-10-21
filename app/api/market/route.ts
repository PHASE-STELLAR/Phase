import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getListings, createListing, isPhase140Enabled, denoteListingInPool } from "@/lib/market-store"
import {
  classicPoolIdForAssets,
  decimalToStroops,
  getClassicPoolSnapshot,
  isPhase182Enabled,
  quoteClassicPool,
  type PoolAsset,
} from "@/lib/liquidity-pool"
import { resolvePhaserLiqClassicAsset } from "@/lib/stellar"
import {
  getSuggestionBand,
  isPricingOracleEnabled,
  priceWarningFor,
  recordSuggestionOutcome,
} from "@/lib/pricing-oracle"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const collectionId = searchParams.get("collection")
  const sellerWallet = searchParams.get("seller")
  const sort = searchParams.get("sort") as "price_asc" | "price_desc" | "newest" | "edition_asc" | null
  const drop = searchParams.get("drop") as "live" | "upcoming" | "ended" | null
  const excludeAp = searchParams.get("exclude_ap") === "1"

  const listings = await getListings({
    collection_id: collectionId ? Number(collectionId) : undefined,
    seller_wallet: sellerWallet ?? undefined,
    sort: sort ?? "newest",
    drop: drop ?? undefined,
    exclude_artist_proof: excludeAp || undefined,
  })

  // Spike 574 (phase-182): PHASELQ-denominated prices can be read in XLM with
  // BOTH spot and execution price. One quote serves the whole page — never one
  // Horizon call per listing. A pool outage degrades to no conversion, never to
  // a failed market response.
  let poolPrice: ReturnType<typeof denoteListingInPool> | null = null
  let poolStale = false
  if (isPhase182Enabled() && searchParams.get("pool") === "1") {
    try {
      const resolved = resolvePhaserLiqClassicAsset()
      const base: PoolAsset = { kind: "credit", code: resolved.code, issuer: resolved.issuer }
      const counter: PoolAsset = { kind: "native" }
      const size = Number(searchParams.get("pool_size") ?? "10")
      const safeSize = Number.isFinite(size) && size > 0 && size <= 1_000_000 ? size : 10
      const snapshot = await getClassicPoolSnapshot(classicPoolIdForAssets(base, counter))
      const quote = quoteClassicPool(snapshot, {
        assetIn: base,
        amountInStroops: decimalToStroops(safeSize.toFixed(7)),
      })
      poolStale = quote.stale
      poolPrice = denoteListingInPool(1, quote, safeSize)
    } catch {
      poolPrice = null
    }
  }

  return NextResponse.json(
    { listings, ...(poolPrice ? { pool_price: poolPrice } : {}) },
    poolStale ? { headers: { "X-Phase-Pool-Stale": "1" } } : undefined,
  )
}

type CreateBody = {
  seller_wallet?: unknown
  token_id?: unknown
  collection_id?: unknown
  price_phaselq?: unknown
  accepts_offers?: unknown
  min_offer?: unknown
  image?: unknown
  name?: unknown
  creator_wallet?: unknown
  royalty_bps?: unknown
  suggestion_id?: unknown
  lang?: unknown
}

export async function POST(request: NextRequest) {
  let body: CreateBody
  try { body = (await request.json()) as CreateBody }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const seller_wallet = typeof body.seller_wallet === "string" ? body.seller_wallet.trim() : ""
  if (!seller_wallet || !StrKey.isValidEd25519PublicKey(seller_wallet)) {
    return NextResponse.json({ error: "valid seller_wallet required" }, { status: 400 })
  }

  const token_id = Number(body.token_id)
  const collection_id = Number(body.collection_id)
  const price_phaselq = Number(body.price_phaselq)

  if (!Number.isInteger(token_id) || token_id <= 0)
    return NextResponse.json({ error: "invalid token_id" }, { status: 400 })
  if (!Number.isInteger(collection_id) || collection_id < 0)
    return NextResponse.json({ error: "invalid collection_id" }, { status: 400 })
  if (!Number.isFinite(price_phaselq) || price_phaselq <= 0)
    return NextResponse.json({ error: "price_phaselq must be positive" }, { status: 400 })

  const min_offer = typeof body.min_offer === "number" ? body.min_offer : undefined

  // phase-140: creator/royalty on a listing are additive and only take
  // effect once the flag is on; a listing created with the flag off simply
  // carries no royalty and is never eligible for a split on resale.
  let creator_wallet: string | undefined
  let royalty_bps: number | undefined
  if (isPhase140Enabled() && typeof body.creator_wallet === "string" && body.creator_wallet.trim().length > 0) {
    const trimmed = body.creator_wallet.trim()
    if (!StrKey.isValidEd25519PublicKey(trimmed)) {
      return NextResponse.json({ error: "invalid creator_wallet" }, { status: 400 })
    }
    creator_wallet = trimmed
    const bps = Number(body.royalty_bps)
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      return NextResponse.json({ error: "royalty_bps must be an integer 0-10000" }, { status: 400 })
    }
    royalty_bps = bps
  }

  const listing = await createListing({
    token_id,
    collection_id,
    seller_wallet,
    price_phaselq,
    accepts_offers: body.accepts_offers === true,
    min_offer,
    image: typeof body.image === "string" ? body.image : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    creator_wallet,
    royalty_bps,
  })

  // phase-143: close the loop on a shown suggestion. Recorded after the listing
  // exists and never able to fail it — the listing is the user's action, the
  // outcome is measurement. The price warning is advisory only.
  let price_suggestion: ReturnType<typeof recordSuggestionOutcome> | undefined
  let price_warning: string | null = null
  if (isPricingOracleEnabled() && typeof body.suggestion_id === "string" && body.suggestion_id.trim()) {
    const suggestionId = body.suggestion_id.trim()
    try {
      price_suggestion = recordSuggestionOutcome({
        suggestionId,
        sellerWallet: seller_wallet,
        collectionId: collection_id,
        listingId: listing.id,
        listedPrice: price_phaselq,
      })
      const band = getSuggestionBand(suggestionId)
      if (band) price_warning = priceWarningFor(price_phaselq, band, body.lang === "es" ? "es" : "en")
    } catch (error) {
      console.warn("[phase-143] suggestion outcome not recorded:", error)
    }
  }

  return NextResponse.json(
    { listing, ...(price_suggestion ? { price_suggestion, price_warning } : {}) },
    { status: 201 },
  )
}
