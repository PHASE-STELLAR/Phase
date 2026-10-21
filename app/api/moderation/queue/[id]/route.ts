import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { createApiRequestContext } from "@/lib/api-observability"
import { checkAdminKey } from "@/lib/admin-key"
import { verifySignalSignature } from "@/lib/viewer-signature"
import { appendModerationAuditEvent } from "@/lib/moderation-audit"
import { createNotification } from "@/lib/notification-store"
import { getSignal, restoreSignal, takedownSignal } from "@/lib/signal-store"
import { pickCopy } from "@/lib/phase-copy"
import {
  ModerationQueueError,
  claimQueueItem,
  getQueueItem,
  isModerationTriageEnabled,
  resolveQueueItem,
} from "@/lib/moderation-triage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SIGNATURE_MAX_AGE_MS = 5 * 60_000

const BodySchema = z.object({
  action: z.enum(["claim", "allow", "takedown"]),
  moderator_wallet: z.string().trim().refine((v) => StrKey.isValidEd25519PublicKey(v), "valid moderator_wallet required"),
  moderator_signature: z.string().trim().min(1).max(512),
  timestamp: z.number().int(),
  reason: z.string().trim().max(500).optional(),
})

function queueErrorStatus(code: ModerationQueueError["code"]): number {
  if (code === "NOT_FOUND") return 404
  if (code === "VERSION_CONFLICT" || code === "ASSIGNED_ELSEWHERE" || code === "NOT_REVIEWABLE") return 409
  return 400
}

/**
 * POST — claim, allow or take down a queued item.
 *
 * Requires the operator key AND a moderator wallet signature over
 * `{ title: "moderate:<id>:<action>", body: <reason or "">, timestamp }`, so the
 * audit names a person, not just "someone with the key". `If-Match` carries
 * the queue item's version.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const api = createApiRequestContext(request, "/api/moderation/queue/[id]")
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
  const raw = (request.headers.get("if-match") ?? "").trim().replace(/^"|"$/g, "")
  const expectedVersion = Number(raw)
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return api.json({ error: "IF_MATCH_REQUIRED" }, { status: 428, event: "moderation.if_match_missing" })
  }
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return api.json({ error: "INVALID_JSON" }, { status: 400, event: "moderation.invalid_json" })
  }
  const parsed = BodySchema.safeParse(json)
  if (!parsed.success) {
    return api.json({ error: "VALIDATION_FAILED", details: parsed.error.flatten() }, { status: 400, event: "moderation.validation_failed" })
  }
  const body = parsed.data
  const { id } = await params

  if (Math.abs(Date.now() - body.timestamp) > SIGNATURE_MAX_AGE_MS) {
    return api.json({ error: "SIGNATURE_EXPIRED" }, { status: 401, event: "moderation.signature_expired" })
  }
  const signed = await verifySignalSignature(
    body.moderator_wallet,
    { title: `moderate:${id}:${body.action}`, body: body.reason ?? "", timestamp: body.timestamp },
    body.moderator_signature,
  )
  if (!signed) {
    return api.json({ error: "INVALID_SIGNATURE" }, { status: 401, event: "moderation.bad_signature" })
  }

  try {
    if (body.action === "claim") {
      const item = claimQueueItem(id, expectedVersion, body.moderator_wallet)
      return api.json({ item }, { event: "moderation.claimed", headers: { ETag: `"${item.version}"`, "Cache-Control": "no-store" } })
    }

    const before = getQueueItem(id)
    const wasAppeal = before?.appealed_at != null
    const { item, agreedWithAi } = resolveQueueItem({
      id,
      expectedVersion,
      action: body.action,
      moderatorWallet: body.moderator_wallet,
    })

    // Signals also get the phase-113 takedown flag, so a human decision stays in
    // force if phase-146 is rolled back. Replies have no takedown column; the
    // queue's visibility is their only switch.
    if (item.target_kind === "signal") {
      const signal = await getSignal(item.target_id)
      if (signal && body.action === "takedown" && !signal.taken_down) {
        await takedownSignal(item.target_id, body.reason || pickCopy("en").moderationQueue.holdReason)
      } else if (signal && body.action === "allow" && signal.taken_down) {
        await restoreSignal(item.target_id)
      }
    }

    const audit = await appendModerationAuditEvent({
      signal_id: item.target_kind === "signal" ? item.target_id : `reply:${item.target_id}`,
      action: body.action === "takedown" ? "takedown" : "restore",
      moderator_wallet: body.moderator_wallet,
      moderator_signature: body.moderator_signature,
      reason: body.reason ?? null,
      ai: {
        queue_id: item.id,
        decision: before?.decision ?? null,
        confidence: before?.confidence ?? null,
        model_id: before?.model_id ?? null,
        prompt_hash: before?.prompt_hash ?? null,
        scores: before?.scores ?? null,
        agreed: agreedWithAi,
      },
    })

    if (wasAppeal) {
      void createNotification(item.author_wallet, "moderation_appeal_resolved", {
        queue_id: item.id,
        restored: body.action === "allow",
      }).catch(() => {})
    }

    return api.json(
      { item, audit, agreed_with_ai: agreedWithAi },
      {
        event: "moderation.resolved",
        metadata: { action: body.action, ai_decision: before?.decision ?? null, agreed: agreedWithAi },
        headers: { ETag: `"${item.version}"`, "Cache-Control": "no-store" },
      },
    )
  } catch (error) {
    if (error instanceof ModerationQueueError) {
      return api.json(
        { error: error.code, current_version: getQueueItem(id)?.version ?? null },
        { status: queueErrorStatus(error.code), event: "moderation.rejected", metadata: { code: error.code } },
      )
    }
    return api.errorJson(error, 500, "moderation.resolve_failed")
  }
}
