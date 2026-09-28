import { NextRequest, NextResponse } from "next/server"
import { diffLoreVersions, getLoreVersions, isLoreVersioningEnabled } from "@/lib/lore-versioning"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token_id: string }> },
) {
  if (!isLoreVersioningEnabled()) {
    return NextResponse.json({ error: "phase-106 flag disabled" }, { status: 404 })
  }

  const { token_id } = await context.params
  const tokenId = Number(token_id)
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ error: "token_id inválido" }, { status: 400 })
  }

  const versions = await getLoreVersions(tokenId)

  const fromRaw = request.nextUrl.searchParams.get("from")
  const toRaw = request.nextUrl.searchParams.get("to")
  let diff = null
  if (fromRaw && toRaw) {
    diff = await diffLoreVersions(tokenId, Number(fromRaw), Number(toRaw))
  }

  return NextResponse.json({ versions, diff })
}
