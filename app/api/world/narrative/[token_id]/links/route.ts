import { NextRequest, NextResponse } from "next/server"
import { addLoreLink, getLoreLinksForToken } from "@/lib/narrative-world-store"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// phase-115: cross-artifact lore linking with back-references
function isPhase115Enabled(): boolean {
  return isFeatureEnabled("phase-115")
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token_id: string }> },
) {
  if (!isPhase115Enabled()) {
    return NextResponse.json({ error: "phase-115 no habilitado" }, { status: 404 })
  }

  const { token_id } = await context.params
  const tokenId = Number(token_id)
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ error: "token_id inválido" }, { status: 400 })
  }

  const links = await getLoreLinksForToken(tokenId)
  return NextResponse.json(links)
}

type LinkBody = {
  to_token_id?: unknown
  note?: unknown
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token_id: string }> },
) {
  if (!isPhase115Enabled()) {
    return NextResponse.json({ error: "phase-115 no habilitado" }, { status: 404 })
  }

  const { token_id } = await context.params
  const fromTokenId = Number(token_id)
  if (!Number.isInteger(fromTokenId) || fromTokenId <= 0) {
    return NextResponse.json({ error: "token_id inválido" }, { status: 400 })
  }

  let body: LinkBody
  try {
    body = (await request.json()) as LinkBody
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 })
  }

  const toTokenId = Number(body.to_token_id)
  if (!Number.isInteger(toTokenId) || toTokenId <= 0) {
    return NextResponse.json({ error: "to_token_id inválido" }, { status: 400 })
  }

  const note = typeof body.note === "string" && body.note.trim().length > 0 ? body.note.trim().slice(0, 280) : undefined

  try {
    const link = await addLoreLink(fromTokenId, toTokenId, note)
    return NextResponse.json({ ok: true, link })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "No se pudo crear el enlace" }, { status: 400 })
  }
}
