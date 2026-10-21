import { NextRequest, NextResponse } from "next/server"
import { buildChallenge, Sep10AuthError } from "@/lib/sep10-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET /api/auth/challenge?account=G... — issues a SEP-10 challenge transaction (phase-162). */
export async function GET(request: NextRequest) {
  const account = request.nextUrl.searchParams.get("account")?.trim() ?? ""
  try {
    return NextResponse.json(buildChallenge(account), { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    if (err instanceof Sep10AuthError) {
      const status = err.code === "FLAG_DISABLED" ? 404 : err.code === "INVALID_ACCOUNT" ? 400 : 500
      return NextResponse.json({ error: err.code, detail: err.message }, { status })
    }
    return NextResponse.json({ error: "CHALLENGE_FAILED" }, { status: 500 })
  }
}
