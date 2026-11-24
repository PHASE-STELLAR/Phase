import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { createApiRequestContext } from "@/lib/api-observability"
import { getLiveBids, getSaleComps } from "@/lib/market-store"
import { isPricingOracleEnabled, suggestListPrice } from "@/lib/pricing-oracle"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

const ROUTE = "/api/market/price-suggestion"

const BodySchema = z.object({
  seller_wallet: z.string().trim().refine((v) => StrKey.isValidEd25519PublicKey(v), "valid seller_wallet required"),
  collection_id: z.number().int().min(0),
  token_id: z.number().int().positive().optional(),
  royalty_bps: z.number().int().min(0).max(10_000).optional(),
  creator_wallet: z
    .string()
    .trim()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), "invalid creator_wallet")
    .optional(),
  lang: z.enum(["en", "es"]).default("en"),
})

/**
 * POST — a list-price suggestion for a token the seller is about to list.
 * Always records a suggestion row (the A/B denominator); the control arm gets
 * `suggestion: null`. Thin markets answer 200 with `code: INSUFFICIENT_COMPS`
 * and no suggestion — an explicit non-result, never a made-up price.
 */
export async function POST(request: NextRequest) {
  const api = createApiRequestContext(request, ROUTE)
  if (!isPricingOracleEnabled()) {
    return api.json({ error: "PRICING_DISABLED" }, { status: 404, event: "pricing.disabled" })
  }
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return api.json({ error: "INVALID_JSON" }, { status: 400, event: "pricing.invalid_json" })
  }
  const parsed = BodySchema.safeParse(json)
  if (!parsed.success) {
    return api.json({ error: "VALIDATION_FAILED", details: parsed.error.flatten() }, { status: 400, event: "pricing.validation_failed" })
  }
  const body = parsed.data
  try {
    const result = await suggestListPrice(
      {
        sellerWallet: body.seller_wallet,
        collectionId: body.collection_id,
        tokenId: body.token_id,
        royaltyBps: body.royalty_bps,
        creatorWallet: body.creator_wallet,
        lang: body.lang,
      },
      { comps: (scope, since) => getSaleComps(scope, { since }), liveBids: getLiveBids },
    )
    if (!result.ok) {
      return api.json(
        { suggestion: null, code: result.code, message: result.message },
        { event: "pricing.insufficient_comps", headers: { "Cache-Control": "no-store" } },
      )
    }
    return api.json(
      { suggestion: result.suggestion, suggestion_id: result.suggestion_id, arm: result.arm },
      {
        status: 201,
        event: "pricing.suggested",
        metadata: { arm: result.arm, level: result.suggestion?.level ?? null, rationale_source: result.suggestion?.rationale_source ?? null },
        headers: { "Cache-Control": "no-store" },
      },
    )
  } catch (error) {
    return api.errorJson(error, 500, "pricing.suggest_failed")
  }
}
