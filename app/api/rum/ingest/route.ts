import { NextRequest, NextResponse } from "next/server"
import { isRumCollectorEnabled, appendRumEvents } from "@/lib/rum-store"
import { createRumEvent, type RumEvent } from "@/lib/web-vitals-budgets"

/**
 * POST /api/rum/ingest — closed-label RUM collector endpoint (phase-213).
 *
 * Accepts only the five whitelisted fields of a RumEvent. Anything else —
 * including extra "helpful" properties a client might add — is rejected so
 * PII can never reach the sidecar. With the flag off the route is inert (404).
 */

export const dynamic = "force-dynamic"

const ALLOWED_KEYS = new Set(["route", "metric", "value", "sessionHash", "ts"])
const MAX_BATCH = 20

function isClosedLabelShape(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
  return Object.keys(raw).every((key) => ALLOWED_KEYS.has(key))
}

export async function POST(req: NextRequest) {
  if (!isRumCollectorEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const rawEvents: unknown = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? [(body as Record<string, unknown>).events]
      : null

  if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > MAX_BATCH) {
    return NextResponse.json({ error: "Expected 1..20 RUM events" }, { status: 400 })
  }

  const accepted: RumEvent[] = []
  for (const raw of rawEvents) {
    if (!isClosedLabelShape(raw)) {
      return NextResponse.json({ error: "Event contains disallowed fields" }, { status: 400 })
    }
    const event = createRumEvent(raw)
    if (!event) {
      return NextResponse.json({ error: "Malformed RUM event" }, { status: 400 })
    }
    accepted.push(event)
  }

  try {
    const stored = await appendRumEvents(accepted)
    return NextResponse.json({ ok: true, stored }, { status: 202 })
  } catch {
    return NextResponse.json({ error: "Ingest temporarily unavailable" }, { status: 503 })
  }
}
