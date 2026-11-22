/**
 * GET  /api/fractional/:artifactId          — inspect a co-ownership listing
 * POST /api/fractional/:artifactId/purchase — buy shares (concurrent → 409)
 *
 * Both routes 404 when phase-80 is disabled.
 * No on-chain escrow exists; share balances are off-chain only.
 */

import { NextRequest, NextResponse } from "next/server"
import { isPhase80Enabled, PurchaseSharesSchema } from "@/lib/fractional-ownership"
import {
  getFractionalListing,
  purchaseFractionalShares,
} from "@/lib/fractional-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  { params }: { params: { artifactId: string } }
) {
  if (!isPhase80Enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  const artifact = await getFractionalListing(params.artifactId)
  if (!artifact) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  return NextResponse.json({ artifact })
}

export async function POST(
  request: NextRequest,
  { params }: { params: { artifactId: string } }
) {
  if (!isPhase80Enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }

  const parsed = PurchaseSharesSchema.safeParse({
    ...(body as object),
    artifactId: params.artifactId,
  })
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const result = await purchaseFractionalShares(parsed.data)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ artifact: result.artifact })
}
