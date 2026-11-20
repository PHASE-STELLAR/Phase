import { NextRequest, NextResponse } from "next/server"
import {
  buildWorldExportSnapshot,
  countWorldNarratives,
  getWorldForCollection,
  getWorldNarrativesPage,
  renderWorldExportMarkdown,
  streamWorldExportNdjson,
  WORLD_EXPORT_PAGE_SIZE,
} from "@/lib/narrative-world-store"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { readableStreamFromAsyncIterable } from "@/lib/phase-streaming"
import { pickCopy } from "@/lib/phase-copy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const MAX_WORLD_EXPORT_BYTES = 1024 * 1024

// phase-112: world export to portable markdown and JSON
function isPhase112Enabled(): boolean {
  return isFeatureEnabled("phase-112")
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ collection_id: string }> },
) {
  if (!isPhase112Enabled()) {
    return NextResponse.json({ error: pickCopy(request.nextUrl.searchParams.get("lang")).worldExport.disabled }, { status: 404 })
  }

  const { collection_id } = await context.params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: pickCopy(request.nextUrl.searchParams.get("lang")).worldExport.invalidCollection }, { status: 400 })
  }

  const format = request.nextUrl.searchParams.get("format")?.trim().toLowerCase() ?? "json"
  const copy = pickCopy(request.nextUrl.searchParams.get("lang")).worldExport
  const rawCursor = request.nextUrl.searchParams.get("cursor")
  const cursor = rawCursor === null ? null : Number(rawCursor)
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) {
    return NextResponse.json({ error: copy.invalidCursor }, { status: 400 })
  }
  if (format !== "json" && format !== "markdown" && format !== "md" && format !== "ndjson") {
    return NextResponse.json({ error: copy.invalidFormat }, { status: 400 })
  }

  // NDJSON is streamed page by page so a large world is never serialised into a
  // single in-memory string (#239).
  if (format === "ndjson") {
    const world = await getWorldForCollection(collectionId)
    if (!world) {
      return NextResponse.json({ error: copy.notFound }, { status: 404 })
    }
    const source = streamWorldExportNdjson(collectionId, { cursor })
    const stream = isFeatureEnabled("phase-264")
      ? readableStreamFromAsyncIterable(source, { readTimeoutMs: 30_000 })
      : new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder()
            try {
              for await (const line of source) controller.enqueue(encoder.encode(line))
              controller.close()
            } catch (error) {
              controller.error(error)
            }
          },
        })
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="world-${collectionId}.ndjson"`,
        "X-Phase-Page-Size": String(WORLD_EXPORT_PAGE_SIZE),
      },
    })
  }

  const total = await countWorldNarratives(collectionId)
  const pageSize = WORLD_EXPORT_PAGE_SIZE
  const narrativePage = await getWorldNarrativesPage(collectionId, {
    cursor,
    limit: pageSize,
    maxBytes: MAX_WORLD_EXPORT_BYTES - 32 * 1024,
  })
  if (narrativePage.oversized) {
    return NextResponse.json({ error: copy.tooLarge, code: "WORLD_EXPORT_PAGE_TOO_LARGE" }, { status: 413 })
  }
  const snapshot = await buildWorldExportSnapshot(
    collectionId,
    { cursor, limit: pageSize, maxBytes: MAX_WORLD_EXPORT_BYTES - 32 * 1024 },
  )
  if (!snapshot) {
    return NextResponse.json({ error: copy.notFound }, { status: 404 })
  }
  const isPaginated = total > pageSize || narrativePage.nextCursor !== null || cursor !== null
  const pageHeaders: Record<string, string> = isPaginated
    ? {
        "X-Phase-Page-Size": String(narrativePage.items.length),
        "X-Phase-Total": String(total),
        ...(narrativePage.nextCursor === null
          ? {}
          : { "X-Phase-Next-Cursor": String(narrativePage.nextCursor) }),
      }
    : {}

  if (format === "markdown" || format === "md") {
    const markdown = renderWorldExportMarkdown(snapshot, copy)
    const markdownBytes = new TextEncoder().encode(markdown).byteLength
    if (markdownBytes > MAX_WORLD_EXPORT_BYTES) {
      return NextResponse.json({ error: copy.tooLarge, code: "WORLD_EXPORT_PAGE_TOO_LARGE" }, { status: 413 })
    }
    return new NextResponse(markdown, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="world-${collectionId}.md"`,
        "Content-Length": String(markdownBytes),
        ...pageHeaders,
      },
    })
  }

  const json = JSON.stringify(snapshot)
  const jsonBytes = new TextEncoder().encode(json).byteLength
  if (jsonBytes > MAX_WORLD_EXPORT_BYTES) {
    return NextResponse.json({ error: copy.tooLarge, code: "WORLD_EXPORT_PAGE_TOO_LARGE" }, { status: 413 })
  }
  return new NextResponse(json, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="world-${collectionId}.json"`,
      "Content-Length": String(jsonBytes),
      ...pageHeaders,
    },
  })
}
