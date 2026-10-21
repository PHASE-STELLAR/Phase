import { NextRequest, NextResponse } from "next/server"
import {
  isRetentionErasureEnabled,
  executeWalletErasure,
  RetentionErasureError,
} from "@/lib/retention-erasure"
import { checkAdminKey } from "@/lib/admin-key"
import { readBoundedBody } from "@/lib/bounded-body"

export const dynamic = "force-dynamic"

const MAX_BODY_BYTES = 16 * 1024

/**
 * GDPR Article 17 erasure. Authorization is fail-closed and mirrors the
 * portability export route: an admin key grants cross-wallet erasure,
 * otherwise the caller's wallet header must match the erasure target — a
 * missing header is 401, a mismatched one is 403.
 */
export async function POST(request: NextRequest) {
  if (!isRetentionErasureEnabled()) {
    return NextResponse.json(
      { error: "GDPR erasure is disabled (set NEXT_PUBLIC_FEATURE_PHASE_179=1)" },
      { status: 404 },
    )
  }

  let body: unknown
  try {
    const text = await readBoundedBody(request, MAX_BODY_BYTES)
    body = JSON.parse(text || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const wallet = typeof (body as Record<string, unknown>)?.wallet === "string"
    ? ((body as Record<string, string>).wallet).trim()
    : ""
  if (!wallet) {
    return NextResponse.json({ error: "wallet is required" }, { status: 400 })
  }

  const adminOk = checkAdminKey(request) === "ok"
  const callerWallet =
    request.headers.get("x-wallet-address")?.trim() ||
    request.headers.get("acting_wallet")?.trim() ||
    ""

  if (!adminOk) {
    if (!callerWallet) {
      return NextResponse.json(
        { error: "Unauthorized: x-wallet-address header or x-admin-key required" },
        { status: 401 },
      )
    }
    if (callerWallet !== wallet) {
      return NextResponse.json(
        { error: "Unauthorized: caller wallet does not match erasure target" },
        { status: 403 },
      )
    }
  }

  try {
    const receipt = await executeWalletErasure(wallet, {
      initiatedBy: adminOk && callerWallet !== wallet ? "admin" : "wallet",
    })
    return NextResponse.json({ ok: true, receipt })
  } catch (error) {
    if (error instanceof RetentionErasureError) {
      const status =
        error.code === "FLAG_DISABLED"
          ? 404
          : error.code === "LEGAL_HOLD_ACTIVE"
            ? 423
            : 400
      return NextResponse.json({ error: error.message, code: error.code }, { status })
    }
    throw error
  }
}
