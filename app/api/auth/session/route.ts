import { NextRequest, NextResponse } from "next/server"
import { issueSession, revokeSession, Sep10AuthError } from "@/lib/sep10-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** POST /api/auth/session — exchange a wallet-signed SEP-10 challenge for a bearer session (phase-162). */
export async function POST(request: NextRequest) {
  let body: { transaction?: unknown; account?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "JSON_INVALID" }, { status: 400 })
  }
  if (typeof body.transaction !== "string" || typeof body.account !== "string") {
    return NextResponse.json({ error: "transaction and account are required" }, { status: 400 })
  }

  try {
    const session = await issueSession(body.transaction, body.account.trim())
    return NextResponse.json(session, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    if (err instanceof Sep10AuthError) {
      const status =
        err.code === "FLAG_DISABLED" ? 404 : err.code === "REPLAYED_CHALLENGE" ? 409 : 401
      return NextResponse.json({ error: err.code, detail: err.message }, { status })
    }
    return NextResponse.json({ error: "SESSION_FAILED" }, { status: 500 })
  }
}

/** DELETE /api/auth/session — revoke the bearer session presented in Authorization. */
export async function DELETE(request: NextRequest) {
  const revoked = await revokeSession(request)
  return NextResponse.json({ ok: revoked }, { status: revoked ? 200 : 404 })
}
