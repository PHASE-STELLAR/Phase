import { NextRequest, NextResponse } from "next/server"
import { isNarrativeSearchEnabled, searchNarratives } from "@/lib/narrative-search"

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

  const results = await searchNarratives({ entity, location, text })
  return NextResponse.json({ results, total: results.length })
}
