import { NextRequest, NextResponse } from "next/server"
import { buildWorldExportSnapshot, renderWorldExportMarkdown, renderWorldExportNdjson } from "@/lib/narrative-world-store"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// phase-112: world export to portable markdown and JSON
function isPhase112Enabled(): boolean {
  return isFeatureEnabled("phase-112")
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ collection_id: string }> },
) {
  if (!isPhase112Enabled()) {
    return NextResponse.json({ error: "phase-112 no habilitado" }, { status: 404 })
  }

  const { collection_id } = await context.params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "collection_id inválido" }, { status: 400 })
  }

  const snapshot = await buildWorldExportSnapshot(collectionId)
  if (!snapshot) {
    return NextResponse.json({ error: "Mundo no encontrado" }, { status: 404 })
  }

  const format = request.nextUrl.searchParams.get("format")?.trim().toLowerCase() ?? "json"

  if (format === "markdown" || format === "md") {
    const markdown = renderWorldExportMarkdown(snapshot)
    return new NextResponse(markdown, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="world-${collectionId}.md"`,
      },
    })
  }

  if (format === "ndjson") {
    const ndjson = renderWorldExportNdjson(snapshot)
    return new NextResponse(ndjson, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="world-${collectionId}.ndjson"`,
      },
    })
  }

  if (format !== "json") {
    return NextResponse.json({ error: "format debe ser 'json', 'markdown' o 'ndjson'" }, { status: 400 })
  }

  return NextResponse.json(snapshot, {
    headers: { "Content-Disposition": `attachment; filename="world-${collectionId}.json"` },
  })
}
