import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getWorldRoles, setWorldRole } from "@/lib/narrative-world-store"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// phase-109: collaborative world permissions with role tiers
function isPhase109Enabled(): boolean {
  return isFeatureEnabled("phase-109")
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ collection_id: string }> },
) {
  if (!isPhase109Enabled()) {
    return NextResponse.json({ error: "phase-109 no habilitado" }, { status: 404 })
  }

  const { collection_id } = await context.params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "collection_id inválido" }, { status: 400 })
  }

  const roles = await getWorldRoles(collectionId)
  return NextResponse.json({ roles })
}

type RolesBody = {
  acting_wallet?: unknown
  target_wallet?: unknown
  role?: unknown
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ collection_id: string }> },
) {
  if (!isPhase109Enabled()) {
    return NextResponse.json({ error: "phase-109 no habilitado" }, { status: 404 })
  }

  const { collection_id } = await context.params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "collection_id inválido" }, { status: 400 })
  }

  let body: RolesBody
  try {
    body = (await request.json()) as RolesBody
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 })
  }

  if (!request.headers.get("x-wallet-signature")?.trim()) {
    return NextResponse.json({ error: "Se requiere firma de wallet (X-Wallet-Signature)" }, { status: 401 })
  }

  if (typeof body.acting_wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.acting_wallet)) {
    return NextResponse.json({ error: "acting_wallet inválido" }, { status: 400 })
  }
  if (typeof body.target_wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.target_wallet)) {
    return NextResponse.json({ error: "target_wallet inválido" }, { status: 400 })
  }
  if (body.role !== "editor" && body.role !== "viewer") {
    return NextResponse.json({ error: "role debe ser 'editor' o 'viewer'" }, { status: 400 })
  }

  try {
    const roles = await setWorldRole(collectionId, body.acting_wallet, body.target_wallet, body.role)
    return NextResponse.json({ ok: true, roles })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "No se pudo asignar el rol" }, { status: 403 })
  }
}
