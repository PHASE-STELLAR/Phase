import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { resolveSessionWallet } from "@/lib/sep10-auth"
import { pickCopy } from "@/lib/phase-copy"
import {
  enrollSignedReferral,
  getSignedReferralSummary,
  isSignedReferralQuestEnabled,
  issueOneUseReferralCode,
} from "@/lib/referral-quest"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ReferralPostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("issue_code"),
    expectedVersion: z.number().int().min(0).optional(),
  }),
  z.object({
    action: z.literal("enroll"),
    code: z.string().trim().min(1).max(32),
    expectedVersion: z.number().int().min(0).optional(),
  }),
])

function resolveLang(request: NextRequest): string {
  return (
    request.nextUrl.searchParams.get("lang") ??
    request.headers.get("x-phase-lang") ??
    "en"
  )
}

/** GET /api/referral — SEP-10 authenticated referral quest summary (phase-261). */
export async function GET(request: NextRequest) {
  if (!isSignedReferralQuestEnabled()) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 })
  }

  const wallet = await resolveSessionWallet(request)
  const copy = pickCopy(resolveLang(request)).referralQuest
  if (!wallet) {
    return NextResponse.json(
      { error: "SESSION_REQUIRED", message: copy.authRequiredError },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    )
  }

  const summary = await getSignedReferralSummary(wallet)
  return NextResponse.json(
    { ok: true, wallet, ...summary, copy },
    { headers: { "Cache-Control": "no-store" } },
  )
}

/** POST /api/referral — issue one-use code or atomically enroll via SEP-10 session (phase-261). */
export async function POST(request: NextRequest) {
  if (!isSignedReferralQuestEnabled()) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 })
  }

  const wallet = await resolveSessionWallet(request)
  const copy = pickCopy(resolveLang(request)).referralQuest
  if (!wallet) {
    return NextResponse.json(
      { error: "SESSION_REQUIRED", message: copy.authRequiredError },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    )
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: "JSON_INVALID" }, { status: 400 })
  }

  const parsed = ReferralPostSchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_FAILED", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  if (parsed.data.action === "issue_code") {
    const res = await issueOneUseReferralCode(wallet, {
      expectedVersion: parsed.data.expectedVersion,
    })
    return NextResponse.json(res, {
      status: res.ok ? 200 : res.status,
      headers: { "Cache-Control": "no-store" },
    })
  }

  const res = await enrollSignedReferral({
    sessionWallet: wallet,
    code: parsed.data.code,
    expectedVersion: parsed.data.expectedVersion,
  })
  return NextResponse.json(res, {
    status: res.status,
    headers: { "Cache-Control": "no-store" },
  })
}
