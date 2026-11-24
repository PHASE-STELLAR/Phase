/**
 * GET  /api/fractional          — list co-ownership listings (flag-gated)
 * POST /api/fractional          — create a co-ownership listing (flag-gated)
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_80 / FEATURE_PHASE_80
 * Rollback: unset flag — both methods return 404.
 * No on-chain escrow exists; all listings are off-chain only.
 */

import { NextRequest, NextResponse } from "next/server"
import { isPhase80Enabled } from "@/lib/fractional-ownership"
import { CreateFractionalListingSchema } from "@/lib/fractional-ownership"
import {
  createFractionalListing,
  getFractionalListings,
} from "@/lib/fractional-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  if (!isPhase80Enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  const { searchParams } = request.nextUrl
  const status = searchParams.get("status") as
    | "listing"
    | "fully_owned"
    | "cancelled"
    | null
  const creator = searchParams.get("creator") ?? undefined

  const listings = await getFractionalListings({
    status: status ?? undefined,
    creator,
  })

  return NextResponse.json({ listings })
}

export async function POST(request: NextRequest) {
  if (!isPhase80Enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }

  const parsed = CreateFractionalListingSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const result = await createFractionalListing(parsed.data)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ artifact: result.artifact }, { status: 201 })
}
