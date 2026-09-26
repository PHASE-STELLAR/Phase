import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getWorldRoles, setWorldRole } from "@/lib/narrative-world-store"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { verifyWorldRoleSignature, type WorldRoleProofPayload } from "@/lib/viewer-signature"

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
  /** Timestamp the client signed over, so a captured signature can't be replayed. */
  timestamp?: unknown
}

/** A role-assignment proof older than this is rejected (replay window). */
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000

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

  const signature = request.headers.get("x-wallet-signature")?.trim()
  if (!signature) {
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

  // #247: a present-but-unverified signature header proves nothing — acting_wallet
  // comes from the request body, so anyone could claim to be the world owner and
  // assign themselves a role. Verify the SEP-53 signature over this exact action.
  const timestamp = typeof body.timestamp === "number" ? body.timestamp : Number(body.timestamp)
  if (!Number.isFinite(timestamp)) {
    return NextResponse.json({ error: "timestamp de la firma requerido" }, { status: 400 })
  }
  if (Math.abs(Date.now() - timestamp) > SIGNATURE_MAX_AGE_MS) {
    return NextResponse.json({ error: "Firma de wallet expirada" }, { status: 401 })
  }

  const proof: WorldRoleProofPayload = {
    action: "world-role-assign",
    collection_id: collectionId,
    target_wallet: body.target_wallet,
    role: body.role,
    timestamp,
  }
  const signatureValid = await verifyWorldRoleSignature(body.acting_wallet, proof, signature)
  if (!signatureValid) {
    return NextResponse.json(
      { error: "Firma de wallet inválida para esta operación" },
      { status: 401 },
    )
  }

  try {
    const roles = await setWorldRole(collectionId, body.acting_wallet, body.target_wallet, body.role)
    return NextResponse.json({ ok: true, roles })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "No se pudo asignar el rol" }, { status: 403 })
  }
}
