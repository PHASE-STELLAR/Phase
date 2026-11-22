import { NextRequest, NextResponse } from "next/server"
import { checkAdminKey } from "@/lib/admin-key"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  listDeadLetterQueue,
  getDeadLetterEntry,
  getDeadLetterStats,
  replayDeadLetterEntry,
  resolveDeadLetterEntry,
  X402DeadLetterError,
} from "@/lib/x402-dead-letter"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function isAuthorized(req: NextRequest): boolean {
  if (checkAdminKey(req) === "ok") return true
  const adminKey = process.env.PHASE_ADMIN_KEY?.trim()
  if (adminKey && req.headers.get("x-admin-key")?.trim() === adminKey) return true
  return false
}

export async function GET(req: NextRequest) {
  if (!isFeatureEnabled("phase-240")) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 })
  }
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const id = searchParams.get("id")
  if (id) {
    const entry = await getDeadLetterEntry(id)
    if (!entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 })
    return NextResponse.json({ entry })
  }

  const status = searchParams.get("status") as any
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined
  const items = await listDeadLetterQueue({ status: status || undefined, limit })
  const stats = await getDeadLetterStats()
  return NextResponse.json({ items, stats })
}

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled("phase-240")) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 })
  }
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { action, id, note, by } = body ?? {}
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Missing required parameter: id" }, { status: 400 })
  }

  try {
    if (action === "replay") {
      const result = await replayDeadLetterEntry(id, { by: typeof by === "string" ? by : "admin" })
      return NextResponse.json(result)
    }
    if (action === "resolve" || action === "discard") {
      const resolved = await resolveDeadLetterEntry(id, {
        status: action === "discard" ? "discarded" : "resolved",
        by: typeof by === "string" ? by : "admin",
        note: typeof note === "string" ? note : undefined,
      })
      return NextResponse.json({ ok: true, entry: resolved })
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (e) {
    if (e instanceof X402DeadLetterError) {
      if (e.code === "NOT_FOUND") return NextResponse.json({ error: e.message, code: e.code }, { status: 404 })
      if (e.code === "MAX_REPLAY_ATTEMPTS_EXCEEDED") {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 429 })
      }
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
