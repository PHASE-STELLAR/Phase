import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getNotifications,
  getNotificationPreferences,
  getUnreadCount,
  isPhase128Enabled,
  isNotificationPreferencesEnabled,
  markAllRead,
  markRead,
  rotateIpfsGatewayAuth,
  saveNotificationPreferences,
  isFaucetAnalyticsEnabled,
  getFaucetFunnelAnalytics,
  recordFaucetFunnelEvent,
  type GatewayAuthRotation,
  type NotificationPreferences,
} from "@/lib/notification-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  // module #53 (phase-53): faucet claim-funnel analytics — operator view, not wallet-scoped.
  if (request.nextUrl.searchParams.get("funnel") === "1") {
    if (!isFaucetAnalyticsEnabled()) {
      return NextResponse.json(
        { error: "faucet analytics disabled", code: "FLAG_DISABLED", feature_enabled: false },
        { status: 404 },
      )
    }
    const windowParam = Number(request.nextUrl.searchParams.get("windowMs"))
    const windowMs = Number.isFinite(windowParam) && windowParam > 0 ? windowParam : undefined
    const funnel = await getFaucetFunnelAnalytics({ windowMs })
    return NextResponse.json({ funnel, feature_enabled: true })
  }

  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "valid wallet required" }, { status: 400 })
  }
  const [notifications, unread_count, preferences] = await Promise.all([
    getNotifications(wallet),
    getUnreadCount(wallet),
    getNotificationPreferences(wallet),
  ])
  return NextResponse.json({
    notifications,
    unread_count,
    preferences,
    preferences_feature_enabled: isNotificationPreferencesEnabled(),
    gateway_auth_rotation_feature_enabled: isPhase128Enabled(),
    faucet_analytics_feature_enabled: isFaucetAnalyticsEnabled(),
  })
}

type NotifActionBody = {
  wallet?: unknown
  action?: unknown
  id?: unknown
  preferences?: unknown
  gateway_auth?: unknown
  funnel_event?: unknown
}

function redactGatewayAuthRotation(rotation: GatewayAuthRotation): GatewayAuthRotation {
  return {
    ...rotation,
    active_token_hash: `${rotation.active_token_hash.slice(0, 12)}...`,
    previous_token_hash: rotation.previous_token_hash ? `${rotation.previous_token_hash.slice(0, 12)}...` : null,
  }
}

function parsePreferencePatch(input: unknown): Partial<Omit<NotificationPreferences, "updated_at">> | null {
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const patch: Partial<Omit<NotificationPreferences, "updated_at">> = {}

  if (typeof raw.enabled === "boolean") {
    patch.enabled = raw.enabled
  }

  if (raw.types && typeof raw.types === "object" && !Array.isArray(raw.types)) {
    const types: NotificationPreferences["types"] = {}
    const dynamicTypes = types as Record<string, boolean>
    for (const [key, value] of Object.entries(raw.types as Record<string, unknown>)) {
      if (typeof value === "boolean") {
        dynamicTypes[key] = value
      }
    }
    patch.types = types
  }

  return patch
}

export async function POST(request: NextRequest) {
  let body: NotifActionBody
  try {
    body = (await request.json()) as NotifActionBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // module #53 (phase-53): funnel events may be anonymous (a "viewed" hit before wallet connect).
  if (body.action === "record_funnel_event") {
    try {
      const event = await recordFaucetFunnelEvent(body.funnel_event)
      return NextResponse.json({ ok: true, event, feature_enabled: isFaucetAnalyticsEnabled() })
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN"
      const details = error instanceof Error && "details" in error ? (error as { details?: unknown }).details : undefined
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "funnel event rejected", code, details },
        { status: code === "FLAG_DISABLED" ? 404 : 400 },
      )
    }
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "valid wallet required" }, { status: 400 })
  }

  if (body.action === "mark_read") {
    if (typeof body.id === "string" && body.id.trim()) {
      await markRead(wallet, body.id.trim())
    } else {
      await markAllRead(wallet)
    }
    return NextResponse.json({ ok: true })
  }

  if (body.action === "update_preferences") {
    const patch = parsePreferencePatch(body.preferences)
    if (!patch) {
      return NextResponse.json({ error: "valid preferences required" }, { status: 400 })
    }
    const preferences = await saveNotificationPreferences(wallet, patch)
    return NextResponse.json({
      ok: true,
      preferences,
      preferences_feature_enabled: isNotificationPreferencesEnabled(),
    })
  }

  if (body.action === "rotate_gateway_auth") {
    try {
      const rotation = await rotateIpfsGatewayAuth(body.gateway_auth)
      return NextResponse.json({
        ok: true,
        rotation: redactGatewayAuthRotation(rotation),
        gateway_auth_rotation_feature_enabled: isPhase128Enabled(),
      })
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN"
      const details = error instanceof Error && "details" in error ? (error as { details?: unknown }).details : undefined
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "gateway auth rotation failed", code, details },
        { status: code === "FLAG_DISABLED" ? 404 : 400 },
      )
    }
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 })
}
