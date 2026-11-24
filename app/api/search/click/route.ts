import { NextRequest, NextResponse } from "next/server"
import {
  isSearchAnalyticsEnabled,
  recordSearchClick,
  searchQueryHash,
  type SearchSurface,
} from "@/lib/search-query-log"

export const dynamic = "force-dynamic"

/**
 * POST /api/search/click — spike 613 (phase-175).
 *
 * Clickthrough beacon for search results. Body: { surface, query, result_ref?, session_id? }.
 * Only the sha256 of the query and result reference are stored. 404 when the
 * flag is off; 400 on invalid input; 204 on accept.
 */
export async function POST(request: NextRequest) {
  if (!isSearchAnalyticsEnabled()) {
    return NextResponse.json({ error: "phase-175 flag disabled" }, { status: 404 })
  }
  let body: { surface?: string; query?: string; result_ref?: string; session_id?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }
  const surface = body.surface?.trim() as SearchSurface | undefined
  const query = body.query?.trim() ?? ""
  if (!surface || !query) {
    return NextResponse.json({ error: "surface and query are required" }, { status: 400 })
  }
  try {
    const event = await recordSearchClick({
      surface,
      query,
      resultRef: body.result_ref?.trim() || undefined,
      sessionId: body.session_id?.trim() || undefined,
    })
    return NextResponse.json(
      { ok: true, recorded: event !== null, query_hash: searchQueryHash(query) },
      { status: 200 },
    )
  } catch {
    return NextResponse.json({ error: "invalid search click payload" }, { status: 400 })
  }
}
