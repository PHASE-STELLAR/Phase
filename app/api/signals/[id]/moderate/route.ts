import { NextRequest, NextResponse } from "next/server"
import { getSignal, takedownSignal, restoreSignal, isModerationEnabled } from "@/lib/signal-store"
import { createNotification } from "@/lib/notification-store"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  MODERATION_ACTIONS,
  type ModerationAction,
  ModeratorIdentitySchema,
  appendModerationAuditEvent,
  getModerationAuditEvents,
} from "@/lib/moderation-audit"
import { getLatestForTarget, isModerationTriageEnabled, resolveQueueItem } from "@/lib/moderation-triage"
import { assertNoLegalHold, LegalHoldError } from "@/lib/legal-hold"

/**
 * phase-146: a takedown/restore made here is a human decision about the same
 * content the AI queue holds, so it closes the queue item too. Otherwise the
 * item would keep its AI visibility (a restored post could stay hidden) and sit
 * in the review queue as stale work. Best-effort: a concurrent queue action
 * wins, and the phase-113 flag already carries this decision.
 */
function syncTriageQueue(signalId: string, action: ModerationAction, moderatorWallet: string | null) {
  if (!isModerationTriageEnabled()) return null
  const latest = getLatestForTarget("signal", signalId)
  if (!latest || latest.state === "pending_score") return null
  try {
    return resolveQueueItem({
      id: latest.id,
      expectedVersion: latest.version,
      action: action === "takedown" ? "takedown" : "allow",
      moderatorWallet: moderatorWallet ?? "operator",
    })
  } catch {
    return null
  }
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ModerateBody = {
  action?: ModerationAction
  reason?: unknown
  moderator_wallet?: unknown
  moderator_signature?: unknown
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isFeatureEnabled("phase-91")) {
    return NextResponse.json({ error: "Moderation audit is disabled" }, { status: 404 })
  }
  const adminKey = process.env.PHASE_ADMIN_KEY?.trim()
  if (adminKey && request.headers.get("x-admin-key")?.trim() !== adminKey) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }
  const { id } = await params
  const events = await getModerationAuditEvents(id)
  return NextResponse.json({ events })
}

/**
 * POST /api/signals/[id]/moderate
 *
 * Takes down or restores a signal (narrative content moderation, phase-113).
 * Body JSON: { "action": "takedown" | "restore", "reason"?: string }
 * Requires header `x-admin-key` equal to `PHASE_ADMIN_KEY` if defined.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isModerationEnabled()) {
    return NextResponse.json({ error: "Moderation is disabled (set NEXT_PUBLIC_FEATURE_PHASE_113=1)" }, { status: 404 })
  }

  const adminKey = process.env.PHASE_ADMIN_KEY?.trim()
  if (adminKey) {
    const provided = request.headers.get("x-admin-key")?.trim()
    if (provided !== adminKey) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
    }
  }

  const { id } = await params
  let body: ModerateBody
  try {
    body = (await request.json()) as ModerateBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const action = body.action
  if (!action || !(MODERATION_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${MODERATION_ACTIONS.join(", ")}` },
      { status: 400 },
    )
  }

  const auditEnabled = isFeatureEnabled("phase-91")
  const identity = ModeratorIdentitySchema.safeParse(body)
  if (auditEnabled && !identity.success) {
    return NextResponse.json({ error: identity.error.issues[0]?.message ?? "Moderator identity required" }, { status: 400 })
  }

  const existing = await getSignal(id)
  if (!existing) {
    return NextResponse.json({ error: "Signal not found" }, { status: 404 })
  }

  // phase-169: deny-delete preservation under active legal hold
  try {
    await assertNoLegalHold("signal", id, action, existing.author_wallet)
  } catch (holdErr) {
    if (holdErr instanceof LegalHoldError) {
      return NextResponse.json(
        { error: holdErr.message, code: holdErr.code, hold: holdErr.hold },
        { status: 423 }, // HTTP 423 Locked
      )
    }
    throw holdErr
  }

  try {
    if (action === "takedown") {
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "Violates community guidelines"
      const signal = await takedownSignal(id, reason)
      syncTriageQueue(id, action, identity.success ? identity.data.moderator_wallet : null)
      let audit = null
      if (auditEnabled && identity.success) {
        audit = await appendModerationAuditEvent({
          signal_id: id,
          action,
          moderator_wallet: identity.data.moderator_wallet,
          moderator_signature: identity.data.moderator_signature,
          reason,
        })
      }
      void createNotification(signal.author_wallet, "content_takedown", {
        signal_id: id,
        signal_title: signal.title,
        reason,
      }).catch(() => { /* silent */ })
      return NextResponse.json({ signal, audit })
    }

    const signal = await restoreSignal(id)
    syncTriageQueue(id, action, identity.success ? identity.data.moderator_wallet : null)
    let audit = null
    if (auditEnabled && identity.success) {
      audit = await appendModerationAuditEvent({
        signal_id: id,
        action,
        moderator_wallet: identity.data.moderator_wallet,
        moderator_signature: identity.data.moderator_signature,
        reason: null,
      })
    }
    return NextResponse.json({ signal, audit })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Moderation update failed" },
      { status: 500 },
    )
  }
}
