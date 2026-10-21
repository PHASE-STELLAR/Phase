import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { fetchOwnedPhaseTokenIdsForWallet, phaseProtocolContractIdForServer } from "@/lib/phase-protocol"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function resolveUpstreamBaseUrl(): string {
  const explicit = process.env.PHASE_OWNER_TOKENS_ENDPOINT?.trim()
  if (explicit) return explicit

  const base = process.env.PHASE_API_BASE_URL?.trim() || process.env.PHASE_INDEXER_BASE_URL?.trim()
  if (!base) return ""

  return `${base.replace(/\/+$/, "")}/get_owner_tokens/index`
}

function buildUpstreamUrl(req: NextRequest, upstreamBaseUrl: string): URL {
  const incoming = req.nextUrl
  const owner = incoming.searchParams.get("owner")?.trim() || incoming.searchParams.get("ownerAddress")?.trim()
  if (!owner) throw new Error("Missing required query param: owner")

  const upstream = new URL(upstreamBaseUrl)
  upstream.searchParams.set("owner", owner)

  const cursor = incoming.searchParams.get("cursor")?.trim()
  if (cursor) upstream.searchParams.set("cursor", cursor)

  const limit = incoming.searchParams.get("limit")?.trim()
  if (limit) upstream.searchParams.set("limit", limit)

  return upstream
}

export async function GET(req: NextRequest) {
  const owner =
    req.nextUrl.searchParams.get("owner")?.trim() ||
    req.nextUrl.searchParams.get("ownerAddress")?.trim() ||
    ""

  if (!owner || !StrKey.isValidEd25519PublicKey(owner)) {
    return NextResponse.json({ error: "Missing or invalid query param: owner" }, { status: 400 })
  }

  // Issue #298 fix: Add pagination support with cursor and limit
  const limitParam = req.nextUrl.searchParams.get("limit")?.trim()
  const cursorParam = req.nextUrl.searchParams.get("cursor")?.trim()
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 100, 1000) : 100
  const cursor = cursorParam ? parseInt(cursorParam, 10) || 0 : 0

  // ── Intenta upstream indexer si está configurado ──
  const upstreamBaseUrl = resolveUpstreamBaseUrl()
  if (upstreamBaseUrl) {
    let upstreamUrl: URL
    try {
      upstreamUrl = buildUpstreamUrl(req, upstreamBaseUrl)
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid request." }, { status: 400 })
    }
    try {
      const upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      })
      const raw = await upstreamResponse.text()
      if (!upstreamResponse.ok) {
        // Upstream falló → caemos al RPC fallback en lugar de devolver error directamente
        console.warn("[get_owner_tokens] upstream failed, falling back to RPC", upstreamResponse.status)
      } else {
        try {
          return NextResponse.json(JSON.parse(raw), { status: 200 })
        } catch {
          // JSON inválido → fallback al RPC
          console.warn("[get_owner_tokens] upstream returned non-JSON, falling back to RPC")
        }
      }
    } catch (e) {
      console.warn("[get_owner_tokens] upstream unreachable, falling back to RPC", e instanceof Error ? e.message : String(e))
    }
  }

  // ── Fallback: Soroban RPC directo con paginación ──
  try {
    const contractId = phaseProtocolContractIdForServer()
    const allTokenIds = await fetchOwnedPhaseTokenIdsForWallet(owner, {
      contractId,
      maxTokenIdCap: 10000,
      concurrency: 8,
    })

    // Aplicar paginación
    const paginatedTokenIds = allTokenIds.slice(cursor, cursor + limit)
    const hasMore = cursor + limit < allTokenIds.length
    const nextCursor = hasMore ? cursor + limit : null

    return NextResponse.json(
      {
        owner,
        contractId,
        tokenIds: paginatedTokenIds,
        tokens: paginatedTokenIds.map((id) => ({ token_id: id })),
        pagination: {
          cursor,
          limit,
          total: allTokenIds.length,
          hasMore,
          nextCursor,
        },
        indexedVia: "soroban-rpc",
      },
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (e) {
    return NextResponse.json(
      {
        error: "RPC scan failed.",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    )
  }
}
