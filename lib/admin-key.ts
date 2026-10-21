import { timingSafeEqual } from "node:crypto"
import type { NextRequest } from "next/server"

/**
 * Operator check for the phase-142/143/146/147 routes.
 *
 * The older moderation route admits every caller when PHASE_ADMIN_KEY is
 * unset. These routes publish shows, expose moderation queues and override AI
 * decisions, so they fail closed instead: no configured key, no access.
 */
export type AdminKeyResult = "ok" | "unconfigured" | "denied"

export function checkAdminKey(request: NextRequest): AdminKeyResult {
  const expected = process.env.PHASE_ADMIN_KEY?.trim()
  if (!expected) return "unconfigured"
  const provided = request.headers.get("x-admin-key")?.trim() ?? ""
  const a = Buffer.from(provided, "utf8")
  const b = Buffer.from(expected, "utf8")
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "denied"
}
