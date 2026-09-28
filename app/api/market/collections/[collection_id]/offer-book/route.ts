import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getCollectionOfferBook,
  createBulkOffer,
  getListing,
  isPhase139Enabled,
  MAX_BULK_OFFER_TARGETS,
} from "@/lib/market-store"
import { createNotification } from "@/lib/notification-store"
import { createApiRequestContext } from "@/lib/api-observability"
import { z } from "zod"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ collection_id: string }> },
) {
  const api = createApiRequestContext(request, "/api/market/collections/[collection_id]/offer-book")
  const { collection_id: rawId } = await params
  const collection_id = Number(rawId)

  if (!isPhase139Enabled()) {
    return api.json(
      { error: "Collection offer books disabled (phase-139 flag off)" },
      { status: 404, event: "market.offer_book.disabled" },
    )
  }
  if (!Number.isInteger(collection_id) || collection_id < 0) {
    return api.json(
      { error: "invalid collection_id" },
      { status: 400, event: "market.offer_book.validation_failed" },
    )
  }

  try {
    const book = await getCollectionOfferBook(collection_id)
    return api.json(
      { offerBook: book },
      { event: "market.offer_book.loaded", metadata: { collection_id } },
    )
  } catch (error) {
    return api.errorJson(error, 500, "market.offer_book.load_failed")
  }
}

const BulkOfferBodySchema = z.object({
  buyer_wallet: z.string().trim().refine((v) => StrKey.isValidEd25519PublicKey(v), "valid buyer_wallet required"),
  offers: z
    .array(
      z.object({
        listing_id: z.string().trim().min(1),
        amount_phaselq: z.number().finite().positive(),
      }),
    )
    .min(1)
    .max(MAX_BULK_OFFER_TARGETS),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ collection_id: string }> },
) {
  const api = createApiRequestContext(request, "/api/market/collections/[collection_id]/offer-book")
  const { collection_id: rawId } = await params
  const collection_id = Number(rawId)

  if (!isPhase139Enabled()) {
    return api.json(
      { error: "Bulk bidding disabled (phase-139 flag off)" },
      { status: 404, event: "market.bulk_offer.disabled" },
    )
  }
  if (!Number.isInteger(collection_id) || collection_id < 0) {
    return api.json(
      { error: "invalid collection_id" },
      { status: 400, event: "market.bulk_offer.validation_failed" },
    )
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "market.bulk_offer.invalid_json" })
  }

  const parsed = BulkOfferBodySchema.safeParse(json)
  if (!parsed.success) {
    return api.json(
      { error: "Invalid bulk offer request", details: parsed.error.flatten() },
      { status: 400, event: "market.bulk_offer.validation_failed" },
    )
  }

  try {
    const result = await createBulkOffer(parsed.data.buyer_wallet, parsed.data.offers)

    for (const offer of result.created) {
      const listing = await getListing(offer.listing_id)
      if (!listing) continue
      void createNotification(listing.seller_wallet, "new_offer", {
        listing_id: offer.listing_id,
        token_id: listing.token_id,
        amount: offer.amount_phaselq,
        buyer_wallet: offer.buyer_wallet,
        bulk: true,
      }).catch((error) => api.log("warn", "market.bulk_offer.notification_failed", { error }))
    }

    return api.json(
      { created: result.created, skipped: result.skipped },
      {
        status: 201,
        event: "market.bulk_offer.created",
        metadata: { collection_id, created: result.created.length, skipped: result.skipped.length },
      },
    )
  } catch (error) {
    return api.errorJson(error, 500, "market.bulk_offer.create_failed")
  }
}
