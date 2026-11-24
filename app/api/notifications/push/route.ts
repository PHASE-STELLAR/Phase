import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  PushNotificationError,
  SubscribePushRequestSchema,
  getPushSubscriptions,
  isPhase92Enabled,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push-notifications"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function statusForCode(code: PushNotificationError["code"]): number {
  switch (code) {
    case "FLAG_DISABLED":
      return 403
    case "VALIDATION_FAILED":
      return 400
    case "NOT_FOUND":
      return 404
    default:
      return 500
  }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "valid wallet required" }, { status: 400 })
  }
  const subscriptions = await getPushSubscriptions(wallet)
  return NextResponse.json({
    wallet,
    subscriptions: subscriptions.map((s) => ({ endpoint: s.endpoint, subscribedAt: s.subscribedAt })),
    feature_enabled: isPhase92Enabled(),
  })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 })
  }
  const parsed = SubscribePushRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 })
  }
  try {
    const sub = await subscribeToPush(parsed.data)
    return NextResponse.json({ ok: true, endpoint: sub.endpoint, subscribedAt: sub.subscribedAt })
  } catch (e) {
    if (e instanceof PushNotificationError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: statusForCode(e.code) })
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  const endpoint = req.nextUrl.searchParams.get("endpoint")?.trim() ?? ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet) || !endpoint) {
    return NextResponse.json({ error: "valid wallet and endpoint required" }, { status: 400 })
  }
  try {
    await unsubscribeFromPush(wallet, endpoint)
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof PushNotificationError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: statusForCode(e.code) })
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 500 })
  }
}
