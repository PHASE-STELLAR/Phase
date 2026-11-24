import { NextRequest, NextResponse } from "next/server"
import { isPhase215Enabled } from "@/lib/webhook-subscriptions"
import { listDeliveries } from "@/lib/webhook-delivery-log"

/**
 * GET /api/admin/webhook-deliveries?subscription_id=... — delivery log for the
 * admin redelivery UI. Flag off → 404.
 */

export const dynamic = "force-dynamic"

function validateAdminAuth(req: NextRequest): boolean {
  const token = process.env.ADMIN_API_TOKEN?.trim()
  if (!token) return false
  return req.headers.get("authorization") === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!isPhase215Enabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (!validateAdminAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const subscriptionId = req.nextUrl.searchParams.get("subscription_id") ?? undefined
  const deliveries = await listDeliveries(subscriptionId)
  return NextResponse.json({ ok: true, deliveries })
}
