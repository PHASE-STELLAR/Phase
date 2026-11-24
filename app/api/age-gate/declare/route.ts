import { NextRequest, NextResponse } from "next/server"
import { declareAge, AgeGateError } from "@/lib/age-gate"
import { resolveSessionWallet } from "@/lib/sep10-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** POST /api/age-gate/declare — self-attest a birth year for the session wallet (phase-164). */
export async function POST(request: NextRequest) {
  const wallet = await resolveSessionWallet(request)
  if (!wallet) {
    return NextResponse.json({ error: "SESSION_REQUIRED" }, { status: 401 })
  }

  let body: { birthYear?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "JSON_INVALID" }, { status: 400 })
  }

  try {
    const declaration = await declareAge(wallet, Number(body.birthYear))
    return NextResponse.json({ ok: true, band: declaration.band }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    if (err instanceof AgeGateError) {
      const status = err.code === "FLAG_DISABLED" ? 404 : 400
      return NextResponse.json({ error: err.code, detail: err.message }, { status })
    }
    return NextResponse.json({ error: "DECLARATION_FAILED" }, { status: 500 })
  }
}
