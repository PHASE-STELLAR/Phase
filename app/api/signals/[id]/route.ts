import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getSignal,
  upvoteSignal,
  getReplies,
  signalETag,
  parseVersionHeader,
  VersionConflictError,
} from "@/lib/signal-store"
import { createNotification } from "@/lib/notification-store"
import { checkAndUnlock } from "@/lib/achievement-store"
import { createApiRequestContext } from "@/lib/api-observability"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]")
  const { id } = await params
  const signal = await getSignal(id)
  if (!signal) {
    return api.json(
      { error: "Signal not found" },
      { status: 404, event: "signals.get.not_found", metadata: { signal_id: id } },
    )
  }
  const replies = await getReplies(id)
  return api.json(
    { signal, replies },
    { status: 200, event: "signals.get.ok", headers: { ETag: signalETag(signal.version) } },
  )
}

type UpvoteBody = {
  wallet?: unknown
  signature?: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]")
  const { id } = await params
  let body: UpvoteBody
  try {
    body = (await request.json()) as UpvoteBody
  } catch {
    return api.json(
      { error: "Invalid JSON" },
      { status: 400, event: "signals.upvote.invalid_json" },
    )
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return api.json(
      { error: "Invalid wallet address" },
      { status: 400, event: "signals.upvote.validation_failed", metadata: { reason: "wallet" } },
    )
  }
  if (typeof body.signature !== "string" || body.signature.length === 0) {
    return api.json(
      { error: "Signature required" },
      { status: 400, event: "signals.upvote.validation_failed", metadata: { reason: "signature" } },
    )
  }

  // If-Match is optional so existing clients keep working; when supplied the
  // upvote becomes a compare-and-swap against the version the client rendered.
  const ifMatch = request.headers.get("if-match")
  let expectedVersion: number | undefined
  if (ifMatch !== null && ifMatch.trim() !== "*") {
    const parsed = parseVersionHeader(ifMatch)
    if (parsed === null) {
      return api.json(
        { error: "Invalid If-Match" },
        { status: 400, event: "signals.upvote.validation_failed", metadata: { reason: "if_match" } },
      )
    }
    expectedVersion = parsed
  }

  try {
    const signal = await upvoteSignal(id, body.wallet, expectedVersion)
    // Notify at milestones: 5, 10, 25 upvotes (fire-and-forget)
    const count = signal.upvotes.length
    if ((count === 5 || count === 10 || count === 25) && signal.author_wallet !== body.wallet) {
      void createNotification(signal.author_wallet, "signal_upvote", {
        signal_id: id,
        signal_title: signal.title,
        upvote_count: count,
      }).catch((error) => api.log("warn", "signals.upvote.notification_failed", { error }))
    }
    // Achievement: track upvotes for the author (fire-and-forget)
    if (signal.author_wallet !== body.wallet) {
      void checkAndUnlock(signal.author_wallet, { upvote_delta: 1 }).catch((error) =>
        api.log("warn", "signals.upvote.achievement_failed", { error }),
      )
    }
    return api.json(
      { signal },
      {
        status: 200,
        event: "signals.upvote.ok",
        metadata: { signal_id: id, version: signal.version },
        headers: { ETag: signalETag(signal.version) },
      },
    )
  } catch (error) {
    if (error instanceof VersionConflictError) {
      return api.json(
        { error: "Version conflict", current_version: error.currentVersion },
        {
          status: 409,
          event: "signals.version_conflict",
          metadata: { signal_id: id, current_version: error.currentVersion },
          headers: { ETag: signalETag(error.currentVersion) },
        },
      )
    }
    return api.json(
      { error: "Signal not found" },
      { status: 404, event: "signals.upvote.not_found", metadata: { signal_id: id } },
    )
  }
}

type EditBody = {
  wallet?: unknown
  title?: unknown
  body?: unknown
}

const EDIT_ERROR_STATUS: Record<SignalEditError["code"], number> = {
  FLAG_DISABLED: 404,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
}

// phase-82: edit a signal's title/body, snapshotting the pre-edit state into version history.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: EditBody
  try {
    body = (await request.json()) as EditBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 })
  }
  const ifMatch = request.headers.get("if-match")?.trim()
  if (!ifMatch || !/^\d+$/.test(ifMatch)) {
    return NextResponse.json({ error: "If-Match header with the current signal version is required" }, { status: 428 })
  }

  try {
    const { signal, version } = await editSignal(id, body.wallet, {
      title: typeof body.title === "string" ? body.title : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
    }, Number(ifMatch))
    return NextResponse.json({ signal, version })
  } catch (error) {
    if (error instanceof SignalEditError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: EDIT_ERROR_STATUS[error.code] })
    }
    return NextResponse.json({ error: "Failed to edit signal" }, { status: 500 })
  }
}
