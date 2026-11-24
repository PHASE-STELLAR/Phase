import { NextRequest, NextResponse } from "next/server"
import { isPhase215Enabled } from "@/lib/webhook-subscriptions"
import { redeliverWebhookEvent } from "@/lib/webhook-delivery"

/**
 * POST /api/admin/webhook-subscriptions/[id]/redeliver
 * Body: { deliveryId } — replay a recorded event to its original subscriber.
 * Flag off → 404. The signing secret is never accepted from the request.
 */

export const dynamic = "force-dynamic"

function validateAdminAuth(req: NextRequest): boolean {
  const token = process.env.ADMIN_API_TOKEN?.trim()
  if (!token) return false
  return req.headers.get("authorization") === `Bearer ${token}`
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isPhase215Enabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (!validateAdminAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  let body: { deliveryId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (typeof body.deliveryId !== "string" || !body.deliveryId) {
    return NextResponse.json({ error: "deliveryId is required" }, { status: 400 })
  }

  const result = await redeliverWebhookEvent(body.deliveryId)
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 502
    return NextResponse.json({ ok: false, error: result.reason }, { status })
  }
  return NextResponse.json({ ok: true, subscriptionId: id })
}
