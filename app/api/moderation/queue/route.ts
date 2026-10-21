import { NextRequest } from "next/server"
import { createApiRequestContext } from "@/lib/api-observability"
import { checkAdminKey } from "@/lib/admin-key"
import { isModerationTriageEnabled, listReviewQueue } from "@/lib/moderation-triage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET — the human review queue, most urgent first, with SLA breach flags. */
export async function GET(request: NextRequest) {
  const api = createApiRequestContext(request, "/api/moderation/queue")
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
  const items = listReviewQueue({ limit: Number(request.nextUrl.searchParams.get("limit") ?? 50) || 50 })
  return api.json(
    { items, sla_breached: items.filter((i) => i.sla_breached).length },
    { event: "moderation.queue_listed", metadata: { count: items.length }, headers: { "Cache-Control": "no-store" } },
  )
}
