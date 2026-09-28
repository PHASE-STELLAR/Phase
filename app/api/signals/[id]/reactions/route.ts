import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getSignal,
  getSignalReactionSummary,
  toggleSignalReaction,
  isPhase83Enabled,
  SignalReactionError,
} from "@/lib/signal-store"
import { createNotification } from "@/lib/notification-store"
import { createApiRequestContext } from "@/lib/api-observability"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]/reactions")
  const { id } = await params

  if (!isPhase83Enabled()) {
    return api.json({ error: "Reactions disabled (phase-83 flag off)" }, { status: 404, event: "signals.reactions.disabled" })
  }

  const viewerWallet = request.nextUrl.searchParams.get("viewer_wallet")?.trim() || undefined

  try {
    const signal = await getSignal(id)
    if (!signal) {
      return api.json({ error: "Signal not found" }, { status: 404, event: "signals.reactions.signal_missing", metadata: { signal_id: id } })
    }
    const summary = await getSignalReactionSummary(id, viewerWallet)
    return api.json({ signalId: id, reactions: summary }, { event: "signals.reactions.loaded", metadata: { signal_id: id } })
  } catch (error) {
    return api.errorJson(error, 500, "signals.reactions.load_failed")
  }
}

type ReactionBody = {
  wallet?: unknown
  emoji?: unknown
}

const REACTION_ERROR_STATUS: Record<SignalReactionError["code"], number> = {
  FLAG_DISABLED: 404,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]/reactions")
  const { id } = await params

  if (!isPhase83Enabled()) {
    return api.json({ error: "Reactions disabled (phase-83 flag off)" }, { status: 404, event: "signals.reactions.disabled" })
  }

  let body: ReactionBody
  try {
    body = (await request.json()) as ReactionBody
  } catch {
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "signals.reactions.invalid_json" })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return api.json({ error: "Invalid wallet address" }, { status: 400, event: "signals.reactions.validation_failed", metadata: { reason: "wallet" } })
  }
  if (typeof body.emoji !== "string" || body.emoji.length === 0) {
    return api.json({ error: "emoji required" }, { status: 400, event: "signals.reactions.validation_failed", metadata: { reason: "emoji" } })
  }

  try {
    const signal = await getSignal(id)
    if (!signal) {
      return api.json({ error: "Signal not found" }, { status: 404, event: "signals.reactions.signal_missing", metadata: { signal_id: id } })
    }

    const { toggled, summary } = await toggleSignalReaction(id, body.wallet, body.emoji)

    if (toggled === "added" && signal.author_wallet !== body.wallet) {
      void createNotification(signal.author_wallet, "signal_reaction", {
        signal_id: id,
        signal_title: signal.title,
        reactor_wallet: body.wallet,
        emoji: body.emoji,
      }).catch((error) => api.log("warn", "signals.reactions.notification_failed", { error }))
    }

    return api.json(
      { toggled, reactions: summary },
      { event: "signals.reactions.toggled", metadata: { signal_id: id, toggled, emoji: body.emoji } },
    )
  } catch (error) {
    if (error instanceof SignalReactionError) {
      const status = REACTION_ERROR_STATUS[error.code]
      return api.json(
        { error: error.message, code: error.code, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) },
        {
          status,
          event: "signals.reactions.rejected",
          metadata: { signal_id: id, reason: error.code },
          headers: error.retryAfterMs ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) } : undefined,
        },
      )
    }
    return api.errorJson(error, 500, "signals.reactions.toggle_failed")
  }
}
