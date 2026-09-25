import { NextRequest, NextResponse } from "next/server"
import { getNarrativeForTokenCached } from "@/lib/narrative-world-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token_id: string }> },
) {
  const { token_id } = await context.params
  const tokenId = Number(token_id)
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ error: "token_id inválido" }, { status: 400 })
  }

  const lang = request.nextUrl.searchParams.get("lang")?.trim() || "en"
  const narrative = await getNarrativeForTokenCached(tokenId, lang)
  return NextResponse.json({ narrative })
}