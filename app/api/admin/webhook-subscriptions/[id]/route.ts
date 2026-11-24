import { NextRequest, NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  deleteSubscription,
  getSubscription,
  rotateSubscriptionSecret,
} from "@/lib/webhook-subscriptions"

/**
 * DELETE /api/admin/webhook-subscriptions/[id]            - remove a subscription
 * POST   /api/admin/webhook-subscriptions/[id]?rotate=1    - rotate its secret
 *
 * Flag: phase-154. See ../route.ts for the shared admin-auth convention.
 */

export const dynamic = "force-dynamic"

function validateAdminAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const adminToken = process.env.ADMIN_API_TOKEN?.trim()
  if (!adminToken) return false
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false
  return authHeader.substring(7) === adminToken
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isFeatureEnabled("phase-154")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 },
    )
  }

  const { id } = await params
  const removed = await deleteSubscription(id)
  if (!removed) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isFeatureEnabled("phase-154")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 },
    )
  }

  const { id } = await params
  const rotate = req.nextUrl.searchParams.get("rotate")
  if (!rotate) {
    return NextResponse.json({ error: "Specify ?rotate=1 to rotate the secret" }, { status: 400 })
  }

  const existing = await getSubscription(id)
  if (!existing) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 })
  }

  const secret = await rotateSubscriptionSecret(id)
  return NextResponse.json({ ok: true, secret })
}
