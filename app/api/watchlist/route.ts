import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { resolveSessionWallet } from "@/lib/sep10-auth"
import { pickCopy } from "@/lib/phase-copy"
import {
  getWalletWatchlist,
  isWatchlistEnabled,
  removeWatchlistItem,
  upsertWatchlistItem,
  WatchlistUpsertSchema,
} from "@/lib/watchlist-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const WatchlistDeleteSchema = z.object({
  collectionId: z.number().int().min(0),
  tokenId: z.number().int().min(0),
  expectedVersion: z.number().int().min(0).optional(),
})

function resolveLang(request: NextRequest): string {
  return (
    request.nextUrl.searchParams.get("lang") ??
    request.headers.get("x-phase-lang") ??
    "en"
  )
}

/** GET /api/watchlist — fetch per-wallet watchlist + version (phase-255). */
export async function GET(request: NextRequest) {
  if (!isWatchlistEnabled()) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 })
  }

  const wallet = await resolveSessionWallet(request)
  const copy = pickCopy(resolveLang(request)).watchlist
  if (!wallet) {
    return NextResponse.json(
      { error: "SESSION_REQUIRED", message: copy.authRequiredError },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    )
  }

  const watchlist = await getWalletWatchlist(wallet)
  return NextResponse.json(
    { ok: true, wallet, ...watchlist, copy },
    { headers: { "Cache-Control": "no-store" } },
  )
}

/** POST /api/watchlist — add or update a watched item with version guard (phase-255). */
export async function POST(request: NextRequest) {
  if (!isWatchlistEnabled()) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 })
  }

  const wallet = await resolveSessionWallet(request)
  const copy = pickCopy(resolveLang(request)).watchlist
  if (!wallet) {
    return NextResponse.json(
      { error: "SESSION_REQUIRED", message: copy.authRequiredError },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "JSON_INVALID" }, { status: 400 })
  }

  const parsed = WatchlistUpsertSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_FAILED", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const res = await upsertWatchlistItem(wallet, parsed.data)
  return NextResponse.json(res, {
    status: res.status,
    headers: { "Cache-Control": "no-store" },
  })
}

/** DELETE /api/watchlist — remove a watched item with version guard (phase-255). */
export async function DELETE(request: NextRequest) {
  if (!isWatchlistEnabled()) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 })
  }

  const wallet = await resolveSessionWallet(request)
  const copy = pickCopy(resolveLang(request)).watchlist
  if (!wallet) {
    return NextResponse.json(
      { error: "SESSION_REQUIRED", message: copy.authRequiredError },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "JSON_INVALID" }, { status: 400 })
  }

  const parsed = WatchlistDeleteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_FAILED", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const res = await removeWatchlistItem(wallet, parsed.data)
  return NextResponse.json(res, {
    status: res.status,
    headers: { "Cache-Control": "no-store" },
  })
}
