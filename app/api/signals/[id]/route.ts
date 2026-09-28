import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getSignal,
  upvoteSignal,
  getReplies,
  signalETag,
  parseVersionHeader,
  VersionConflictError,
  editSignal,
  SignalEditError,
} from "@/lib/signal-store"
import { createNotification } from "@/lib/notification-store"
import { checkAndUnlock } from "@/lib/achievement-store"
import { createApiRequestContext } from "@/lib/api-observability"
import { recordSignalCrdtCommit } from "@/lib/signal-version-metrics"
import { isSignalCrdtEnabled, readSignalLoreDraft } from "@/lib/signal-crdt-store"

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
      // lib/signal-store.ts owns signal_version_conflicts; recording it here as
      // well would count every rejected CAS twice.
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

/**
 * Reads a mandatory `If-Match` version off a mutation.
 *
 * `PATCH` and `PUT` both guard on it, and they must agree exactly: a quoted
 * ETag (`"5"`, which is what `GET` publishes) and a bare `5` are the same
 * version, and `*` — which HTTP defines as "any current representation" — must
 * be refused rather than quietly disabling the guard.
 */
type IfMatchResult =
  | { ok: true; version: number }
  | { ok: false; status: 428 | 400; error: string; code: "IF_MATCH_REQUIRED" | "INVALID_IF_MATCH" }

function requireIfMatch(request: NextRequest): IfMatchResult {
  const raw = request.headers.get("if-match")
  if (raw === null || raw.trim() === "") {
    return {
      ok: false,
      status: 428,
      error: "If-Match header with the current signal version is required",
      code: "IF_MATCH_REQUIRED",
    }
  }
  const version = parseVersionHeader(raw)
  if (version === null) {
    return {
      ok: false,
      status: 400,
      error: 'If-Match must be the current signal version, quoted or bare (e.g. If-Match: "7")',
      code: "INVALID_IF_MATCH",
    }
  }
  return { ok: true, version }
}

/**
 * Maps a store rejection onto an HTTP response.
 *
 * A 409 carries `current_version` and a matching `ETag` so a client can rebasing
 * immediately instead of guessing; the store is what increments
 * `signal_version_conflicts`, and re-recording here would double-count it.
 */
async function editFailureResponse(
  error: SignalEditError,
  api: ReturnType<typeof createApiRequestContext>,
  signalId: string,
) {
  const status = EDIT_ERROR_STATUS[error.code]
  if (error.code !== "CONFLICT") {
    return api.json(
      { error: error.message, code: error.code },
      {
        status,
        event: "signals.edit.rejected",
        metadata: { reason: error.code },
      },
    )
  }

  const current = await getSignal(signalId)
  const currentVersion = current?.version ?? null
  return api.json(
    {
      error: error.message,
      code: error.code,
      ...(currentVersion === null ? {} : { current_version: currentVersion }),
    },
    {
      status,
      event: "signals.version_conflict",
      metadata: { reason: error.code, current_version: currentVersion },
      ...(currentVersion === null ? {} : { headers: { ETag: signalETag(currentVersion) } }),
    },
  )
}

// phase-82: edit a signal's title/body, snapshotting the pre-edit state into version history.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]")
  const { id } = await params
  let body: EditBody
  try {
    body = (await request.json()) as EditBody
  } catch {
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "signals.edit.invalid_json" })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return api.json(
      { error: "Invalid wallet address" },
      { status: 400, event: "signals.edit.validation_failed", metadata: { reason: "wallet" } },
    )
  }
  const ifMatch = requireIfMatch(request)
  if (!ifMatch.ok) {
    return api.json(
      { error: ifMatch.error, code: ifMatch.code },
      {
        status: ifMatch.status,
        event: ifMatch.code === "IF_MATCH_REQUIRED" ? "signals.edit.if_match_required" : "signals.edit.validation_failed",
        metadata: ifMatch.code === "INVALID_IF_MATCH" ? { reason: "if_match" } : {},
      },
    )
  }

  try {
    const { signal, version } = await editSignal(
      id,
      body.wallet,
      {
        title: typeof body.title === "string" ? body.title : undefined,
        body: typeof body.body === "string" ? body.body : undefined,
      },
      ifMatch.version,
    )
    return api.json(
      { signal, version },
      {
        status: 200,
        event: "signals.edit.ok",
        metadata: { signal_id: id, version: signal.version },
        headers: { ETag: signalETag(signal.version) },
      },
    )
  } catch (error) {
    if (error instanceof SignalEditError) return editFailureResponse(error, api, id)
    return api.errorJson(error, 500, "signals.edit.failed")
  }
}

type PutBody = {
  wallet?: unknown
  title?: unknown
  body?: unknown
  from_draft?: unknown
}

/**
 * Issue #207: full replacement of a signal's lore, guarded by a mandatory
 * `If-Match`, and the commit path for a CRDT-collaborative draft.
 *
 * `PUT` is the sibling of `PATCH`: where `PATCH` merges the fields it is given
 * into the current row, `PUT` requires both `title` and `body` so the payload
 * is always a complete, self-consistent revision. That distinction is what
 * makes it safe to commit a merged draft through it — there is no partially
 * applied state to reconcile.
 *
 * Both paths still land in `editSignal`, so the pre-edit text is snapshotted
 * into `signal_versions` and the commit stays revertible. The CRDT layer never
 * writes `signals` itself; it only ever proposes a revision to be committed
 * here, under the author's `If-Match`.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]")
  const { id } = await params
  let body: PutBody
  try {
    body = (await request.json()) as PutBody
  } catch {
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "signals.put.invalid_json" })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return api.json(
      { error: "Invalid wallet address" },
      { status: 400, event: "signals.put.validation_failed", metadata: { reason: "wallet" } },
    )
  }
  if (typeof body.title !== "string" || typeof body.body !== "string") {
    return api.json(
      { error: "PUT requires both title and body" },
      { status: 400, event: "signals.put.validation_failed", metadata: { reason: "title_body" } },
    )
  }

  const ifMatch = requireIfMatch(request)
  if (!ifMatch.ok) {
    return api.json(
      { error: ifMatch.error, code: ifMatch.code },
      {
        status: ifMatch.status,
        event: ifMatch.code === "IF_MATCH_REQUIRED" ? "signals.put.if_match_required" : "signals.put.validation_failed",
        metadata: ifMatch.code === "INVALID_IF_MATCH" ? { reason: "if_match" } : {},
      },
    )
  }

  // The client opts in with `from_draft: true`; the flag alone cannot be the
  // signal, or every plain If-Match replacement would be miscounted as a CRDT
  // commit. Clearing the draft is also only correct for a real draft commit.
  const fromDraft = body.from_draft === true && isSignalCrdtEnabled()
  try {
    const { signal, version } = await editSignal(
      id,
      body.wallet,
      { title: body.title, body: body.body },
      ifMatch.version,
    )
    if (fromDraft) recordSignalCrdtCommit("committed")
    return api.json(
      {
        signal,
        version,
        // The draft is scratch state, so a successful commit clears it: the next
        // collaborator starts from the lore that was just made authoritative
        // instead of from a superseded copy of it.
        ...(fromDraft
          ? { draft: await reseedDraft(id, api) }
          : {}),
      },
      {
        status: 200,
        event: "signals.put.ok",
        metadata: { signal_id: id, version: signal.version, fromDraft },
        headers: { ETag: signalETag(signal.version) },
      },
    )
  } catch (error) {
    if (error instanceof SignalEditError) {
      if (fromDraft) recordSignalCrdtCommit(error.code === "CONFLICT" ? "conflicted" : "rejected")
      return editFailureResponse(error, api, id)
    }
    return api.errorJson(error, 500, "signals.put.failed")
  }
}

/**
 * Re-seeds the draft from the lore that was just committed, so the collaborative
 * surface does not keep re-proposing text the signal no longer has.
 *
 * Best-effort by design: the edit is already durable at this point, so a failure
 * here must not turn a committed signal into a 500. It is logged and the
 * response omits `draft`; the stale draft is inert scratch state and gets reset
 * on the next commit.
 */
async function reseedDraft(
  signalId: string,
  api: ReturnType<typeof createApiRequestContext>,
) {
  try {
    const { resetSignalLoreDraft } = await import("@/lib/signal-crdt-store")
    await resetSignalLoreDraft(signalId)
    const draft = await readSignalLoreDraft(signalId)
    return { stateVector: draft.stateVector, update: draft.update }
  } catch (error) {
    api.log("warn", "signals.put.draft_reseed_failed", { error, signal_id: signalId })
    return null
  }
}
