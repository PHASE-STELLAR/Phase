import { NextRequest, NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { dispatchWebhookEvent } from "@/lib/webhook-delivery"
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/lib/webhook-subscriptions"

/**
 * Sends a synthetic event to every active subscriber of that event type, so
 * an operator can verify signing + delivery end-to-end without waiting for a
 * real settle/offer/faucet event. Mirrors the shape of
 * app/api/admin/test-webhooks/route.ts (the internal-alerts test hook), but
 * for per-subscriber delivery.
 *
 * POST /api/admin/test-subscription-webhooks  { "event": "faucet.claim_completed" }
 *
 * Flag: phase-154.
 */

export const dynamic = "force-dynamic"

function validateAdminAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const adminToken = process.env.ADMIN_API_TOKEN?.trim()
  if (!adminToken) return false
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false
  return authHeader.substring(7) === adminToken
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

  let body: { event?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const event = body.event
  if (typeof event !== "string" || !WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType)) {
    return NextResponse.json(
      { error: `event must be one of: ${WEBHOOK_EVENT_TYPES.join(", ")}` },
      { status: 400 },
    )
  }

  const result = await dispatchWebhookEvent(event as WebhookEventType, {
    test: true,
    note: "Synthetic event sent from /api/admin/test-subscription-webhooks",
  })

  return NextResponse.json({ ok: true, ...result })
}
