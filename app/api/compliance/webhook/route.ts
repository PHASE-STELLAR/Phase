import { NextRequest, NextResponse } from "next/server"
import { applyVerificationEvent, verifyComplianceWebhook } from "@/lib/compliance"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { readBoundedBody } from "@/lib/bounded-body"

export const runtime = "nodejs"
export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" }
  if (!isFeatureEnabled("phase-176") || !["mock", "live"].includes(process.env.PHASE_KYC_MODE ?? "off")) return NextResponse.json({ code: "DISABLED" }, { status: 404, headers })
  let body: string
  try { body = await readBoundedBody(request, 8192) }
  catch { return NextResponse.json({ code: "BODY_TOO_LARGE" }, { status: 413, headers }) }
  if (!verifyComplianceWebhook(body, request.headers.get("x-phase-timestamp") ?? "", request.headers.get("x-phase-signature") ?? "")) return NextResponse.json({ code: "INVALID_SIGNATURE" }, { status: 401, headers })
  try { return NextResponse.json({ ok: true, ...applyVerificationEvent(JSON.parse(body)) }, { headers }) }
  catch (error) {
    if (error instanceof Error && "current_version" in error) return NextResponse.json({ code: "VERSION_CONFLICT", current_version: error.current_version }, { status: 409, headers })
    return NextResponse.json({ code: "INVALID_EVENT" }, { status: 400, headers })
  }
}
