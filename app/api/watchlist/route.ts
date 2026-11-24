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

const NO_STORE_HEADERS = { "Cache-Control": "no-store" }

function resolveLang(request: NextRequest): string {
  return (
    request.nextUrl.searchParams.get("lang") ??
    request.headers.get("x-phase-lang") ??
    "en"
  )
}

async function requireWatchlistSession(request: NextRequest) {
  if (!isWatchlistEnabled()) {
    return { error: NextResponse.json({ error: "NOT_FOUND" }, { status: 404 }) }
  }

  const wallet = await resolveSessionWallet(request)
  const copy = pickCopy(resolveLang(request)).watchlist
  if (!wallet) {
    return {
      error: NextResponse.json(
        { error: "SESSION_REQUIRED", message: copy.authRequiredError },
        { status: 401, headers: NO_STORE_HEADERS },
      ),
    }
  }

  return { wallet, copy }
}

async function parseJsonBody<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
): Promise<{ data: T } | { error: NextResponse }> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { error: NextResponse.json({ error: "JSON_INVALID" }, { status: 400 }) }
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return {
      error: NextResponse.json(
        { error: "VALIDATION_FAILED", issues: parsed.error.flatten() },
        { status: 400 },
      ),
    }
  }

  return { data: parsed.data }
}

/** GET /api/watchlist — fetch per-wallet watchlist + version (phase-255). */
export async function GET(request: NextRequest) {
  const session = await requireWatchlistSession(request)
  if ("error" in session) return session.error

  const watchlist = await getWalletWatchlist(session.wallet)
  return NextResponse.json(
    { ok: true, wallet: session.wallet, ...watchlist, copy: session.copy },
    { headers: NO_STORE_HEADERS },
  )
}

/** POST /api/watchlist — add or update a watched item with version guard (phase-255). */
export async function POST(request: NextRequest) {
  const session = await requireWatchlistSession(request)
  if ("error" in session) return session.error

  const parsed = await parseJsonBody(request, WatchlistUpsertSchema)
  if ("error" in parsed) return parsed.error

  const res = await upsertWatchlistItem(session.wallet, parsed.data)
  return NextResponse.json(res, {
    status: res.status,
    headers: NO_STORE_HEADERS,
  })
}

/** DELETE /api/watchlist — remove a watched item with version guard (phase-255). */
export async function DELETE(request: NextRequest) {
  const session = await requireWatchlistSession(request)
  if ("error" in session) return session.error

  const parsed = await parseJsonBody(request, WatchlistDeleteSchema)
  if ("error" in parsed) return parsed.error

  const res = await removeWatchlistItem(session.wallet, parsed.data)
  return NextResponse.json(res, {
    status: res.status,
    headers: NO_STORE_HEADERS,
  })
}
