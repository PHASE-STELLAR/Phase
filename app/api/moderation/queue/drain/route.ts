import { NextRequest } from "next/server"
import { createApiRequestContext } from "@/lib/api-observability"
import { checkAdminKey } from "@/lib/admin-key"
import { MODERATION_DECISIONS } from "@/lib/security-counters"
import { drainModerationQueue, isModerationTriageEnabled, scoreAndNotify } from "@/lib/moderation-triage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * POST — score pending items whose background scoring was lost (frozen
 * instance, provider outage). Idempotent and safe to run on a cron while
 * requests are also scoring: every row is scored under a version-guarded lease.
 */
export async function POST(request: NextRequest) {
  const api = createApiRequestContext(request, "/api/moderation/queue/drain")
  if (!isModerationTriageEnabled()) {
    return api.json({ error: "MODERATION_TRIAGE_DISABLED" }, { status: 404, event: "moderation.disabled" })
  }
  const auth = checkAdminKey(request)
  if (auth !== "ok") {
    return api.json(
      { error: auth === "unconfigured" ? "ADMIN_NOT_CONFIGURED" : "UNAUTHORIZED" },
      { status: auth === "unconfigured" ? 503 : 401, event: "moderation.unauthorized" },
    )
  }
  const limit = Math.min(25, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 10) || 10))
  try {
    const items = await drainModerationQueue(limit, (id) => scoreAndNotify(id))
    const byDecision = Object.fromEntries(MODERATION_DECISIONS.map((d) => [d, items.filter((i) => i.decision === d).length]))
    return api.json(
      { scored: items.length, by_decision: byDecision, still_pending: items.filter((i) => i.state === "pending_score").length },
      { event: "moderation.drained", metadata: { scored: items.length }, headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    return api.errorJson(error, 500, "moderation.drain_failed")
  }
}

