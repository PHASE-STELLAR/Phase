import { NextRequest, NextResponse } from "next/server"
import { testWebhooks } from "@/lib/webhook-alerts"

/**
 * Test webhook configuration
 * POST /api/admin/test-webhooks
 */

export const dynamic = 'force-dynamic'

function validateAdminAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const adminToken = process.env.ADMIN_API_TOKEN?.trim()
  
  if (!adminToken) {
    console.warn("[admin/test-webhooks] ADMIN_API_TOKEN not configured")
    return false
  }
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false
  }
  
  const token = authHeader.substring(7)
  return token === adminToken
}

export async function POST(req: NextRequest) {
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 }
    )
  }

  try {
    const result = await testWebhooks()
    
    return NextResponse.json({
      ok: true,
      message: "Webhook test messages sent",
      sent: result.sent,
      failed: result.failed,
      configured: result.sent.length > 0 ? result.sent : ["none"],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
