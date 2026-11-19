import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getWorldRoles, setWorldRole } from "@/lib/narrative-world-store"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { verifyWorldRoleSignature, type WorldRoleProofPayload } from "@/lib/viewer-signature"
import { updateStore } from "@/lib/json-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type WorldRolesMetricsStore = {
  assignments_total: number
  assignments_failed: number
  version: number
}

// phase-109: collaborative world permissions with role tiers
function isPhase109Enabled(): boolean {
  return isFeatureEnabled("phase-109")
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ collection_id: string }> },
) {
  if (!isPhase109Enabled()) {
    return NextResponse.json({ error: "World roles feature not enabled" }, { status: 404 })
  }

  const { collection_id } = await context.params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "Invalid collection_id" }, { status: 400 })
  }

  const roles = await getWorldRoles(collectionId)
  return NextResponse.json({ roles, version: 1 })
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
    return NextResponse.json({ error: "World roles feature not enabled" }, { status: 404 })
  }

  const { collection_id } = await context.params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "Invalid collection_id" }, { status: 400 })
  }

  let body: RolesBody
  try {
    body = (await request.json()) as RolesBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 })
  }

  const signature = request.headers.get("x-wallet-signature")?.trim()
  if (!signature) {
    return NextResponse.json({ error: "X-Wallet-Signature header required" }, { status: 401 })
  }

  if (typeof body.acting_wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.acting_wallet)) {
    return NextResponse.json({ error: "Invalid acting_wallet" }, { status: 400 })
  }
  if (typeof body.target_wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.target_wallet)) {
    return NextResponse.json({ error: "Invalid target_wallet" }, { status: 400 })
  }
  if (body.role !== "editor" && body.role !== "viewer") {
    return NextResponse.json({ error: "Role must be 'editor' or 'viewer'" }, { status: 400 })
  }

  const timestamp = typeof body.timestamp === "number" ? body.timestamp : Number(body.timestamp)
  if (!Number.isFinite(timestamp)) {
    return NextResponse.json({ error: "Signature timestamp required" }, { status: 400 })
  }
  if (Math.abs(Date.now() - timestamp) > SIGNATURE_MAX_AGE_MS) {
    return NextResponse.json({ error: "Wallet signature expired" }, { status: 401 })
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
    void updateStore<WorldRolesMetricsStore>("worldRolesMetrics", (store) => {
      store.assignments_failed = (store.assignments_failed ?? 0) + 1
    }).catch(() => {})
    return NextResponse.json(
      { error: "Invalid wallet signature for this operation" },
      { status: 401 },
    )
  }

  try {
    const roles = await setWorldRole(collectionId, body.acting_wallet, body.target_wallet, body.role)
    void updateStore<WorldRolesMetricsStore>("worldRolesMetrics", (store) => {
      store.assignments_total = (store.assignments_total ?? 0) + 1
      store.version = 1
    }).catch(() => {})
    return NextResponse.json({ ok: true, roles, version: 1 })
  } catch (e) {
    void updateStore<WorldRolesMetricsStore>("worldRolesMetrics", (store) => {
      store.assignments_failed = (store.assignments_failed ?? 0) + 1
    }).catch(() => {})
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to assign role" }, { status: 403 })
  }
}
