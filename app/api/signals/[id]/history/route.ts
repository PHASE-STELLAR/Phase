import { NextRequest } from "next/server"
import { getSignalEditHistory, isPhase82Enabled } from "@/lib/signal-store"
import { createApiRequestContext } from "@/lib/api-observability"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]/history")
  const { id } = await params

  if (!isPhase82Enabled()) {
    return api.json({ error: "Edit history disabled (phase-82 flag off)" }, { status: 404, event: "signals.history.disabled" })
  }

  try {
    const history = await getSignalEditHistory(id)
    if (!history) {
      return api.json({ error: "Signal not found" }, { status: 404, event: "signals.history.signal_missing", metadata: { signal_id: id } })
    }
    return api.json(
      { signalId: id, versions: history.versions, diffs: history.diffs },
      { event: "signals.history.loaded", metadata: { signal_id: id, version_count: history.versions.length } },
    )
  } catch (error) {
    return api.errorJson(error, 500, "signals.history.load_failed")
  }
}
