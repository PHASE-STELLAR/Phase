import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getReaderProgress, markNarrativeRead, getNarrativeForToken } from "@/lib/narrative-world-store"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// phase-108: reader-progression tracking for narrative worlds
function isPhase108Enabled(): boolean {
  return isFeatureEnabled("phase-108")
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ collection_id: string }> },
) {
  if (!isPhase108Enabled()) {
    return NextResponse.json({ error: "phase-108 no habilitado" }, { status: 404 })
  }

  const { collection_id } = await context.params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "collection_id inválido" }, { status: 400 })
  }

  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "wallet inválido" }, { status: 400 })
  }

  const progress = await getReaderProgress(wallet, collectionId)
  return NextResponse.json(
    { progress },
    {
      headers: {
        "Cache-Control": "private, max-age=60, s-maxage=60",
      },
    }
  )
}

type ProgressBody = {
  wallet?: unknown
  token_id?: unknown
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ collection_id: string }> },
) {
  if (!isPhase108Enabled()) {
    return NextResponse.json({ error: "phase-108 no habilitado" }, { status: 404 })
  }

  const { collection_id } = await context.params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "collection_id inválido" }, { status: 400 })
  }

  let body: ProgressBody
  try {
    body = (await request.json()) as ProgressBody
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return NextResponse.json({ error: "wallet inválido" }, { status: 400 })
  }

  const tokenId = Number(body.token_id)
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return NextResponse.json({ error: "token_id inválido" }, { status: 400 })
  }

  const narrative = await getNarrativeForToken(tokenId)
  if (!narrative || narrative.collection_id !== collectionId) {
    return NextResponse.json({ error: "El artefacto no pertenece a este mundo" }, { status: 404 })
  }

  await markNarrativeRead(body.wallet, collectionId, tokenId)
  const progress = await getReaderProgress(body.wallet, collectionId)
  return NextResponse.json({ ok: true, progress })
}
