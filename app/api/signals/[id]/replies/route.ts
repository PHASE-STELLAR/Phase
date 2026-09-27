import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getSignal, createReply, VersionConflictError } from "@/lib/signal-store"
import { createNotification } from "@/lib/notification-store"
import { createApiRequestContext } from "@/lib/api-observability"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ReplyBody = {
  body?: unknown
  wallet?: unknown
  signature?: unknown
  parent_version?: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]/replies")
  const { id } = await params
  let body: ReplyBody
  try {
    body = (await request.json()) as ReplyBody
  } catch {
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "signals.reply.invalid_json" })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return api.json(
      { error: "Invalid wallet address" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "wallet" } },
    )
  }
  if (typeof body.signature !== "string" || body.signature.length === 0) {
    return api.json(
      { error: "Signature required" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "signature" } },
    )
  }
  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    return api.json(
      { error: "Body required" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "body" } },
    )
  }
  if (body.body.trim().length > 500) {
    return api.json(
      { error: "Body max 500 chars" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "body_length" } },
    )
  }

  // Optional: when present, the reply must be composed against this version of
  // the parent signal. A stale parent_version is rejected rather than silently
  // accepted against a view the author never saw.
  let parentVersion: number | undefined
  if (body.parent_version !== undefined) {
    const parsed = body.parent_version
    if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
      return api.json(
        { error: "Invalid parent_version" },
        { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "parent_version" } },
      )
    }
    parentVersion = parsed
  }

  try {
    const signal = await getSignal(id)
    if (!signal) {
      return api.json({ error: "Signal not found" }, { status: 404, event: "signals.reply.signal_missing", metadata: { signal_id: id } })
    }

    const walletStr = body.wallet
    const res = await fetch(
      `${request.nextUrl.origin}/api/artist-profile?walletAddress=${encodeURIComponent(walletStr)}`,
      { headers: { "x-correlation-id": api.correlationId } },
    ).catch((error) => {
      api.log("warn", "signals.reply.profile_lookup_failed", { error })
      return null
    })
    let author_display = `${walletStr.slice(0, 4)}...${walletStr.slice(-4)}`
    if (res?.ok) {
      const data = (await res.json().catch(() => ({}))) as { alias?: string | null }
      if (typeof data.alias === "string" && data.alias.trim().length > 0) {
        author_display = data.alias.trim()
      }
    }

    const reply = await createReply(
      {
        signal_id: id,
        author_wallet: walletStr,
        author_display,
        body: (body.body as string).trim(),
        upvotes: [],
        signature: body.signature as string,
      },
      parentVersion,
    )

    if (signal.author_wallet !== walletStr) {
      void createNotification(signal.author_wallet, "signal_reply", {
        reply_author_wallet: walletStr,
        reply_author_name: author_display,
        signal_id: id,
        signal_title: signal.title,
      }).catch((error) => api.log("warn", "signals.reply.notification_failed", { error }))
    }

    return api.json(
      { reply },
      { status: 201, event: "signals.reply.created", metadata: { signal_id: id, reply_id: reply.id } },
    )
  } catch (error) {
    if (error instanceof VersionConflictError) {
      return api.json(
        { error: "Version conflict", current_version: error.currentVersion },
        {
          status: 409,
          event: "signals.version_conflict",
          metadata: { signal_id: id, route: "replies", current_version: error.currentVersion },
        },
      )
    }
    return api.errorJson(error, 500, "signals.reply.create_failed")
  }
}
