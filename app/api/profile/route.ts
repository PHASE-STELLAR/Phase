import { NextRequest, NextResponse } from "next/server"
import { getProfile, saveProfile } from "@/lib/profile-store"
import { isProfile2faEnabled, touchesHighValueField, verifyProfileChangeConfirmation } from "@/lib/profile-2fa"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim()
  if (!wallet || wallet.length < 10) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 })
  }
  const profile = await getProfile(wallet)
  return NextResponse.json({ wallet, profile: profile ?? null })
}

type ProfileBody = {
  wallet?: unknown
  display_name?: unknown
  twitter?: unknown
  discord?: unknown
  telegram?: unknown
  avatar_token_id?: unknown
  avatar_image_url?: unknown
  /** Code from POST /api/profile/request-change — only checked when phase-104 is enabled. */
  confirmation_code?: unknown
}

function sanitizeHandle(value: unknown, prefix: string): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim().replace(/^@/, "")
  if (!trimmed) return undefined
  return `${prefix}${trimmed}`
}

export async function POST(request: NextRequest) {
  let body: ProfileBody
  try {
    body = (await request.json()) as ProfileBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : ""
  if (!wallet || wallet.length < 10) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  // phase-104: require a two-factor confirmation code before applying
  // high-value profile changes (display name / socials)
  if (isProfile2faEnabled() && touchesHighValueField(body as Record<string, unknown>)) {
    const confirmation = verifyProfileChangeConfirmation(
      wallet,
      body as Record<string, unknown>,
      typeof body.confirmation_code === "string" ? body.confirmation_code : undefined,
    )
    if (!confirmation.ok) {
      return NextResponse.json(
        {
          error: "confirmation_required",
          reason: confirmation.reason,
          hint: "POST /api/profile/request-change first, then resubmit with confirmation_code",
        },
        { status: 428 },
      )
    }
  }

  const display_name =
    typeof body.display_name === "string" ? body.display_name.trim().slice(0, 40) || undefined : undefined
  const twitter = sanitizeHandle(body.twitter, "")
  const discord = typeof body.discord === "string" ? body.discord.trim().slice(0, 40) || undefined : undefined
  const telegram = sanitizeHandle(body.telegram, "")
  const avatar_token_id =
    typeof body.avatar_token_id === "number" && Number.isInteger(body.avatar_token_id)
      ? body.avatar_token_id
      : body.avatar_token_id === null
        ? undefined
        : undefined
  const avatar_image_url =
    typeof body.avatar_image_url === "string" && body.avatar_image_url.trim()
      ? body.avatar_image_url.trim()
      : undefined

  console.log("[profile POST] saving:", { wallet, display_name, twitter, discord, telegram, avatar_token_id })
  let profile
  try {
    profile = await saveProfile(wallet, { display_name, twitter, discord, telegram, avatar_token_id, avatar_image_url })
  } catch (err) {
    console.error("[profile POST] saveProfile error:", err)
    return NextResponse.json({ error: "save_failed", detail: String(err) }, { status: 500 })
  }
  console.log("[profile POST] saved ok:", profile)
  return NextResponse.json({ ok: true, profile })
}
