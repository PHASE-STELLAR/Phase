import { NextRequest, NextResponse } from "next/server"
import { isNarrativeSearchEnabled, searchNarratives } from "@/lib/narrative-search"
import { isSearchAnalyticsEnabled, recordSearchQuery, searchQueryHash } from "@/lib/search-query-log"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  if (!isNarrativeSearchEnabled()) {
    return NextResponse.json({ error: "phase-110 flag disabled" }, { status: 404 })
  }

  const params = request.nextUrl.searchParams
  const entityRaw = params.get("entity")
  let entity: number | undefined
  if (entityRaw) {
    entity = Number(entityRaw)
    if (!Number.isInteger(entity) || entity <= 0) {
      return NextResponse.json({ error: "entity debe ser un entero positivo" }, { status: 400 })
    }
  }
  const location = params.get("location")?.trim() || undefined
  const text = params.get("q")?.trim() || undefined

  const startedAt = Date.now()
  const results = await searchNarratives({ entity, location, text })

  // Spike 613 (phase-175): non-blocking hashed query log — only free-text
  // searches are logged (entity/location filters are not typo-relevant).
  if (text && isSearchAnalyticsEnabled()) {
    const correctedFrom = params.get("q0")?.trim() || undefined
    void recordSearchQuery({
      surface: "world",
      kind: "query",
      query_hash: searchQueryHash(text),
      result_count: results.length,
      duration_ms: Date.now() - startedAt,
      session_id: params.get("sid")?.trim() || undefined,
      corrected_from_hash: correctedFrom ? searchQueryHash(correctedFrom) : undefined,
    }).catch(() => undefined)
  }

  return NextResponse.json({ results, total: results.length })
}
