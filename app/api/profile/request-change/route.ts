import { NextRequest, NextResponse } from "next/server"
import {
  completeProfile2faRecovery,
  initiateProfile2faRecovery,
  isProfile2faEnabled,
  isProfile2faV2Enabled,
  issueSessionBound2faChallenge,
  listProfile2faAudit,
  pickProfile2faCopy,
  PROFILE_2FA_SENSITIVE_FIELDS,
  requestProfileChangeConfirmation,
  requireSep10SessionForWallet,
  touchesHighValueField,
} from "@/lib/profile-2fa"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!isProfile2faV2Enabled(wallet || undefined)) {
    return NextResponse.json({ error: "phase-244 flag disabled" }, { status: 404 })
  }
  if (!wallet || wallet.length < 10) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }
  const lang = request.headers.get("accept-language")?.split(",")[0]?.split("-")[0]
  const session = await requireSep10SessionForWallet(request, wallet, lang)
  if (!session.ok) {
    return NextResponse.json({ error: session.error, code: session.reason }, { status: session.status })
  }
  const audit = listProfile2faAudit(wallet)
  return NextResponse.json({ ok: true, audit })
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : ""
  const lang =
    (typeof body.lang === "string" ? body.lang : undefined) ??
    request.headers.get("accept-language")?.split(",")[0]?.split("-")[0]

  if (isProfile2faV2Enabled(wallet || undefined)) {
    if (!wallet || wallet.length < 10) {
      return NextResponse.json({ error: "wallet required" }, { status: 400 })
    }

    const session = await requireSep10SessionForWallet(request, wallet, lang)
    if (!session.ok) {
      return NextResponse.json({ error: session.error, code: session.reason }, { status: session.status })
    }

    const action = typeof body.action === "string" ? body.action.trim() : "challenge"
    const t = pickProfile2faCopy(lang)

    if (action === "initiate_recovery") {
      const recovery = initiateProfile2faRecovery(wallet, "user")
      return NextResponse.json({
        ok: true,
        action: "initiate_recovery",
        recoveryCode: recovery.recoveryCode,
        expiresAt: recovery.expiresAt,
        message: t.recoveryInitiated,
      })
    }

    if (action === "complete_recovery") {
      const recoveryCode = typeof body.recovery_code === "string" ? body.recovery_code : ""
      const result = completeProfile2faRecovery(wallet, recoveryCode, lang)
      if (!result.ok) {
        return NextResponse.json({ error: result.error, code: "RECOVERY_INVALID" }, { status: result.status })
      }
      return NextResponse.json({ ok: true, action: "complete_recovery", message: result.message })
    }

    const touchesSensitive = PROFILE_2FA_SENSITIVE_FIELDS.some((field) => body[field] !== undefined)
    if (!touchesSensitive) {
      return NextResponse.json({ error: "no sensitive profile fields in payload" }, { status: 400 })
    }

    const issued = issueSessionBound2faChallenge(wallet, session.sessionHash, body, lang)
    if (!issued.ok) {
      return NextResponse.json(
        { error: issued.error, code: issued.reason, retryAfterSeconds: issued.retryAfterSeconds },
        { status: issued.status, headers: { "Retry-After": String(issued.retryAfterSeconds) } },
      )
    }

    return NextResponse.json({ ok: true, code: issued.code, expiresAt: issued.expiresAt })
  }

  // Legacy phase-104 flow (phase-244 off)
  if (!isProfile2faEnabled()) {
    return NextResponse.json({ error: "phase-104 flag disabled" }, { status: 404 })
  }

  if (!wallet || wallet.length < 10) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }
  if (!touchesHighValueField(body)) {
    return NextResponse.json({ error: "no high-value profile fields in payload" }, { status: 400 })
  }

  const { code, expiresAt } = requestProfileChangeConfirmation(wallet, body)
  return NextResponse.json({ ok: true, code, expiresAt })
}
