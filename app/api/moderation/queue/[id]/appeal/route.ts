import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { createApiRequestContext } from "@/lib/api-observability"
import { verifySignalSignature } from "@/lib/viewer-signature"
import { ModerationQueueError, appealQueueItem, isModerationTriageEnabled } from "@/lib/moderation-triage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SIGNATURE_MAX_AGE_MS = 5 * 60_000

const BodySchema = z.object({
  wallet: z.string().trim().refine((v) => StrKey.isValidEd25519PublicKey(v), "valid wallet required"),
  signature: z.string().trim().min(1).max(512),
  timestamp: z.number().int(),
  reason: z.string().trim().min(1).max(500),
})

/**
 * POST — the author appeals a hold. Signed with the same SEP-53 flow as a post,
 * over `{ title: "appeal:<queue id>", body: <reason>, timestamp }`. One appeal
 * per item; it reopens the item for human review with its own SLA.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const api = createApiRequestContext(request, "/api/moderation/queue/[id]/appeal")
  if (!isModerationTriageEnabled()) {
    return api.json({ error: "MODERATION_TRIAGE_DISABLED" }, { status: 404, event: "moderation.disabled" })
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
  const signed = await verifySignalSignature(body.wallet, { title: `appeal:${id}`, body: body.reason, timestamp: body.timestamp }, body.signature)
  if (!signed) {
    return api.json({ error: "INVALID_SIGNATURE" }, { status: 401, event: "moderation.bad_signature" })
  }
  try {
    const item = appealQueueItem({ id, authorWallet: body.wallet, reason: body.reason })
    return api.json(
      { appealed: true, due_at: item.due_at },
      { status: 202, event: "moderation.appealed", headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    if (error instanceof ModerationQueueError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "NOT_APPEALABLE" ? 403 : 409
      return api.json({ error: error.code }, { status, event: "moderation.appeal_rejected", metadata: { code: error.code } })
    }
    return api.errorJson(error, 500, "moderation.appeal_failed")
  }
}
