import { NextRequest, NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  createSubscription,
  listSubscriptions,
  maskSubscription,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@/lib/webhook-subscriptions"

/**
 * Admin API for outbound webhook subscriptions (partial slice of issue #527).
 *
 * GET  /api/admin/webhook-subscriptions - List subscriptions (secrets masked)
 * POST /api/admin/webhook-subscriptions - Create a subscription
 *
 * Flag: phase-154. Disabled routes return 404, matching the convention used
 * by every other flag-gated route in this repo (see PROJECT_ARCHITECTURE.md §10).
 */

export const dynamic = "force-dynamic"

function validateAdminAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const adminToken = process.env.ADMIN_API_TOKEN?.trim()

  if (!adminToken) {
    console.warn("[admin/webhook-subscriptions] ADMIN_API_TOKEN not configured")
    return false
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false
  }
  const token = authHeader.substring(7)
  return token === adminToken
}

export async function GET(req: NextRequest) {
  if (!isFeatureEnabled("phase-154")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 },
    )
  }

  const subscriptions = await listSubscriptions()
  return NextResponse.json({
    ok: true,
    subscriptions: subscriptions.map(maskSubscription),
  })
}

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled("phase-154")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 },
    )
  }

  let body: { url?: unknown; events?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (typeof body.url !== "string" || !Array.isArray(body.events)) {
    return NextResponse.json(
      { error: `url (string) and events (array of ${WEBHOOK_EVENT_TYPES.join(" | ")}) are required` },
      { status: 400 },
    )
  }

  try {
    const subscription = await createSubscription({
      url: body.url,
      events: body.events.filter(
        (e): e is WebhookEventType => typeof e === "string",
      ) as WebhookEventType[],
    })
    // The secret is returned once, at creation time, and never again.
    return NextResponse.json({ ok: true, subscription }, { status: 201 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}
