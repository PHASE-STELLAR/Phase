import { serverLog } from "@/lib/server-logger"
import { NextRequest, NextResponse } from "next/server"
import {
  computeProfileCompleteness,
  getProfile,
  ProfileVersionConflictError,
  saveProfile,
} from "@/lib/profile-store"
import {
  isProfile2faEnabled,
  isProfile2faV2Enabled,
  requireSep10SessionForWallet,
  touchesHighValueField,
  verifyProfileChangeConfirmation,
  verifySessionBound2faChallenge,
} from "@/lib/profile-2fa"
import { isConsent166Enabled, hasAcceptedCurrentLegal } from "@/lib/legal-consent"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { readBoundedBody, BoundedBodyError } from "@/lib/bounded-body"
import { pickCopy } from "@/lib/phase-copy"

export const dynamic = "force-dynamic"

function requestLanguage(request: NextRequest): string {
  return request.headers.get("accept-language")?.split(",")[0]?.split("-")[0] ?? "en"
}

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim()
  if (!wallet || wallet.length < 10) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 })
  }
  const profile = await getProfile(wallet)
  const consent = isConsent166Enabled() ? await hasAcceptedCurrentLegal(wallet) : undefined
  const normalizedProfile = profile && isFeatureEnabled("phase-262")
    ? { ...profile, completeness: profile.completeness ?? computeProfileCompleteness(profile) }
    : profile
  return NextResponse.json({
    wallet,
    profile: normalizedProfile ?? null,
    ...(isFeatureEnabled("phase-262") ? { completeness: computeProfileCompleteness(profile ?? {}) } : {}),
    ...(consent ? { consent } : {}),
  })
}

type ProfileBody = {
  wallet?: unknown
  display_name?: unknown
  twitter?: unknown
  discord?: unknown
  telegram?: unknown
  avatar_token_id?: unknown
  avatar_image_url?: unknown
  expected_version?: unknown
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
    const raw = isFeatureEnabled("phase-262")
      ? await readBoundedBody(request, 16 * 1024, 5_000)
      : await request.text()
    const parsed: unknown = JSON.parse(raw || "{}")
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "JSON object body required" }, { status: 400 })
    }
    body = parsed as ProfileBody
  } catch (error) {
    if (error instanceof BoundedBodyError && error.code === "BODY_TOO_LARGE") {
      return NextResponse.json({ error: "Request body exceeds the allowed size", code: error.code }, { status: 413 })
    }
    if (error instanceof BoundedBodyError && error.code === "BODY_READ_TIMEOUT") {
      return NextResponse.json({ error: "Request body read timed out", code: error.code }, { status: 408 })
    }
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : ""
  if (!wallet || wallet.length < 10) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }
  const expectedVersion = body.expected_version
  if (isFeatureEnabled("phase-262") && (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  )) {
    return NextResponse.json(
      { error: pickCopy(requestLanguage(request)).profileCompleteness.staleProfile, code: "PROFILE_VERSION_CONFLICT" },
      { status: 409 },
    )
  }

  // phase-166: require active legal terms-of-service and privacy-policy consent
  if (isConsent166Enabled()) {
    const consentStatus = await hasAcceptedCurrentLegal(wallet)
    if (!consentStatus.accepted) {
      return NextResponse.json(
        {
          error: "consent_required",
          code: "CONSENT_REQUIRED",
          pending_documents: consentStatus.pending_documents,
          current_versions: consentStatus.current_versions,
          hint: "Review and accept Terms of Service & Privacy Policy via POST /api/legal/consent before updating profile",
        },
        { status: 451 },
      )
    }
  }

  // phase-104: require a two-factor confirmation code before applying
  // high-value profile changes (display name / socials)
  if (isProfile2faV2Enabled(wallet) && touchesHighValueField(body as Record<string, unknown>)) {
    const lang = request.headers.get("accept-language")?.split(",")[0]?.split("-")[0]
    const session = await requireSep10SessionForWallet(request, wallet, lang)
    if (!session.ok) {
      return NextResponse.json({ error: session.error, code: session.reason }, { status: session.status })
    }
    const confirmation = verifySessionBound2faChallenge(
      wallet,
      session.sessionHash,
      body as Record<string, unknown>,
      typeof body.confirmation_code === "string" ? body.confirmation_code : undefined,
      lang,
    )
    if (!confirmation.ok) {
      return NextResponse.json(
        {
          error: confirmation.error,
          code: confirmation.reason,
          reason: confirmation.reason,
          hint: "POST /api/profile/request-change first, then resubmit with confirmation_code",
        },
        {
          status: confirmation.status,
          headers: confirmation.retryAfterSeconds
            ? { "Retry-After": String(confirmation.retryAfterSeconds) }
            : undefined,
        },
      )
    }
  } else if (isProfile2faEnabled() && touchesHighValueField(body as Record<string, unknown>)) {
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

  serverLog.log("[profile POST] saving:", { wallet, display_name, twitter, discord, telegram, avatar_token_id })
  let profile
  try {
    profile = await saveProfile(
      wallet,
      { display_name, twitter, discord, telegram, avatar_token_id, avatar_image_url },
      { expectedVersion: typeof expectedVersion === "number" ? expectedVersion : undefined },
    )
  } catch (err) {
    if (err instanceof ProfileVersionConflictError) {
      return NextResponse.json(
        {
          error: pickCopy(requestLanguage(request)).profileCompleteness.staleProfile,
          code: "PROFILE_VERSION_CONFLICT",
          current_version: err.currentVersion,
        },
        { status: 409 },
      )
    }
    serverLog.error("[profile POST] saveProfile error:", err)
    return NextResponse.json({ error: "save_failed", detail: String(err) }, { status: 500 })
  }
  serverLog.log("[profile POST] saved ok:", profile)
  return NextResponse.json({ ok: true, profile })
}
