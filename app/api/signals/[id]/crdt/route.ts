import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { createApiRequestContext } from "@/lib/api-observability"
import { getSignal } from "@/lib/signal-store"
import {
  isSignalCrdtEnabled,
  flag141RollbackNote,
  mergeSignalLoreUpdate,
  readSignalLoreDraft,
  SignalCrdtError,
} from "@/lib/signal-crdt-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Issue #207 (phase-141): the Yjs sync surface for a signal's collaborative
 * lore draft.
 *
 * This is the same two-step sync protocol `y-websocket` speaks — client sends
 * its state vector, server replies with the operations it is missing; client
 * sends an update, server folds it in and replies with its own state vector —
 * carried over plain HTTP instead of a WebSocket. The transport differs because
 * this app deploys to Vercel serverless, where a request has a bounded lifetime
 * and no upgrade handshake is possible; the merge semantics, which are what
 * actually prevent lost writes, are Yjs' either way. The measurements behind
 * that trade-off are in `docs/spikes/207-signal-crdt-benchmark.md`.
 *
 * `GET`  `?state_vector=<base64>` → the operations the caller is missing.
 * `POST` `{ update, wallet }`    → fold an update, return the merged draft.
 */
const CRDT_ERROR_STATUS: Record<SignalCrdtError["code"], number> = {
  FLAG_DISABLED: 404,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]/crdt")
  const { id } = await params

  if (!isSignalCrdtEnabled()) {
    return api.json(
      { error: "Collaborative lore drafting disabled (phase-141 flag off)", rollback: flag141RollbackNote() },
      { status: 404, event: "signals.crdt.disabled" },
    )
  }

  const rawStateVector = request.nextUrl.searchParams.get("state_vector")?.trim() || undefined

  try {
    const signal = await getSignal(id)
    if (!signal) {
      return api.json(
        { error: "Signal not found" },
        { status: 404, event: "signals.crdt.signal_missing", metadata: { signal_id: id } },
      )
    }
    const draft = await readSignalLoreDraft(id, rawStateVector)
    return api.json(
      { ...draft, version: signal.version },
      {
        event: "signals.crdt.synced",
        metadata: { signal_id: id, update_count: draft.updateCount, contributors: draft.contributors.length },
      },
    )
  } catch (error) {
    return crdtFailure(error, api, id)
  }
}

type SyncBody = {
  update?: unknown
  wallet?: unknown
  /** Optional: narrows the reply to only the operations this client lacks. */
  state_vector?: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]/crdt")
  const { id } = await params

  if (!isSignalCrdtEnabled()) {
    return api.json(
      { error: "Collaborative lore drafting disabled (phase-141 flag off)", rollback: flag141RollbackNote() },
      { status: 404, event: "signals.crdt.disabled" },
    )
  }

  let body: SyncBody
  try {
    body = (await request.json()) as SyncBody
  } catch {
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "signals.crdt.invalid_json" })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return api.json(
      { error: "Invalid wallet address" },
      { status: 400, event: "signals.crdt.validation_failed", metadata: { reason: "wallet" } },
    )
  }
  if (typeof body.update !== "string" || body.update.length === 0) {
    return api.json(
      { error: "update required" },
      { status: 400, event: "signals.crdt.validation_failed", metadata: { reason: "update" } },
    )
  }
  if (body.state_vector != null && (typeof body.state_vector !== "string" || body.state_vector.length === 0)) {
    return api.json(
      { error: "state_vector must be a base64 string when present" },
      { status: 400, event: "signals.crdt.validation_failed", metadata: { reason: "state_vector" } },
    )
  }
  const stateVector = typeof body.state_vector === "string" ? body.state_vector : undefined

  try {
    const signal = await getSignal(id)
    if (!signal) {
      return api.json(
        { error: "Signal not found" },
        { status: 404, event: "signals.crdt.signal_missing", metadata: { signal_id: id } },
      )
    }

    const { draft, concurrent } = await mergeSignalLoreUpdate(id, body.update, body.wallet, {
      sinceStateVector: stateVector,
    })

    return api.json(
      { ...draft, version: signal.version, concurrent },
      {
        event: "signals.crdt.merged",
        metadata: { signal_id: id, concurrent, update_count: draft.updateCount },
      },
    )
  } catch (error) {
    return crdtFailure(error, api, id)
  }
}

function crdtFailure(
  error: unknown,
  api: ReturnType<typeof createApiRequestContext>,
  signalId: string,
) {
  if (error instanceof SignalCrdtError) {
    return api.json(
      { error: error.message, code: error.code },
      {
        status: CRDT_ERROR_STATUS[error.code],
        event: error.code === "NOT_FOUND" ? "signals.crdt.signal_missing" : "signals.crdt.rejected",
        metadata: { signal_id: signalId, reason: error.code },
      },
    )
  }
  return api.errorJson(error, 500, "signals.crdt.failed")
}
