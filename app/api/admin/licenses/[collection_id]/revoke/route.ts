import { NextRequest, NextResponse } from "next/server"
import { isPhase216Enabled, revokeLicense } from "@/lib/license-revocation"

/**
 * POST /api/admin/licenses/[collection_id]/revoke
 * Body: { reason, admin_wallet } — revokes the signed license and delists the
 * collection's active listings within the same request. Flag off → 404.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function validateAdminAuth(req: NextRequest): boolean {
  const token = process.env.ADMIN_API_TOKEN?.trim()
  if (!token) return false
  return req.headers.get("authorization") === `Bearer ${token}`
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ collection_id: string }> },
) {
  if (!isPhase216Enabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (!validateAdminAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { collection_id } = await params
  const collectionId = Number(collection_id)
  if (!Number.isInteger(collectionId) || collectionId < 0) {
    return NextResponse.json({ error: "invalid collection_id" }, { status: 400 })
  }

  let body: { reason?: unknown; admin_wallet?: unknown }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  const adminWallet = typeof body.admin_wallet === "string" ? body.admin_wallet.trim() : ""
  if (!reason || !adminWallet) {
    return NextResponse.json({ error: "reason and admin_wallet are required" }, { status: 400 })
  }

  try {
    const result = await revokeLicense(collectionId, adminWallet, reason)
    return NextResponse.json({ ok: true, delisted: result.delisted, license: result.attestation })
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "REVOCATION_FAILED"
    const status = code === "NOT_FOUND" ? 404 : code === "FLAG_DISABLED" ? 404 : 400
    return NextResponse.json({ ok: false, error: code }, { status })
  }
}
