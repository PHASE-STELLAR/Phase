import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { createApiRequestContext } from "@/lib/api-observability"
import { verifySignalSignature } from "@/lib/viewer-signature"
import { createNotification } from "@/lib/notification-store"
import {
  QuestArcError,
  arcRewardId,
  defaultArcDeps,
  generateArc,
  getActiveArc,
  isQuestArcsEnabled,
  listArcs,
  refreshArc,
  stepClaimable,
  type QuestArc,
} from "@/lib/quest-arcs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const ROUTE = "/api/quests/arcs"
const SIGNATURE_MAX_AGE_MS = 5 * 60_000

const ERROR_STATUS: Record<QuestArcError["code"], number> = {
  FLAG_DISABLED: 404,
  ALREADY_ACTIVE: 409,
  RATE_LIMITED: 429,
  NO_ELIGIBLE_STEPS: 422,
  TREASURY_LOW: 503,
  IDENTITY_BLOCKED: 403,
  FARMABLE: 422,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  STEP_NOT_CLAIMABLE: 409,
}

/** Arc as the client sees it: each step carries the faucet reward id to claim it with. */
function view(arc: QuestArc, now = Date.now()) {
  return {
    ...arc,
    steps: arc.steps.map((s) => ({ ...s, claim_hold_id: undefined, reward_id: arcRewardId(arc.id, s.index), claimable: stepClaimable(arc, s.index, now) })),
  }
}

export async function GET(request: NextRequest) {
  const api = createApiRequestContext(request, ROUTE)
  if (!isQuestArcsEnabled()) return api.json({ error: "QUEST_ARCS_DISABLED" }, { status: 404, event: "quest_arcs.disabled" })
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    return api.json({ error: "VALIDATION_FAILED" }, { status: 400, event: "quest_arcs.validation_failed" })
  }
  try {
    let active = getActiveArc(wallet)
    if (active) {
      const { arc, completedNow } = await refreshArc(active.id, defaultArcDeps())
      active = arc.status === "active" ? arc : null
      if (completedNow) void createNotification(wallet, "quest_arc_completed", { arc_id: arc.id, title: arc.title }).catch(() => {})
    }
    return api.json(
      { active: active ? view(active) : null, history: listArcs(wallet).filter((a) => a.id !== active?.id).map((a) => view(a)) },
      { event: "quest_arcs.loaded", headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    if (error instanceof QuestArcError) {
      return api.json({ error: error.code }, { status: ERROR_STATUS[error.code], event: "quest_arcs.rejected", metadata: { code: error.code } })
    }
    return api.errorJson(error, 500, "quest_arcs.load_failed")
  }
}

const GenerateSchema = z.object({
  wallet: z.string().trim().refine((v) => StrKey.isValidEd25519PublicKey(v), "valid wallet required"),
  signature: z.string().trim().min(1).max(512),
  timestamp: z.number().int(),
  lang: z.enum(["en", "es"]).default("en"),
  replace: z.boolean().default(false),
})

/**
 * POST — generate an arc for the signing wallet. Signed (SEP-53, same flow as
 * signals) over `{ title: "quest-arc:generate", body: <lang>, timestamp }`,
 * because generation costs a model call and earmarks treasury: nobody may
 * spend another wallet's arc budget.
 */
export async function POST(request: NextRequest) {
  const api = createApiRequestContext(request, ROUTE)
  if (!isQuestArcsEnabled()) return api.json({ error: "QUEST_ARCS_DISABLED" }, { status: 404, event: "quest_arcs.disabled" })
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return api.json({ error: "INVALID_JSON" }, { status: 400, event: "quest_arcs.invalid_json" })
  }
  const parsed = GenerateSchema.safeParse(json)
  if (!parsed.success) {
    return api.json({ error: "VALIDATION_FAILED", details: parsed.error.flatten() }, { status: 400, event: "quest_arcs.validation_failed" })
  }
  const body = parsed.data
  if (Math.abs(Date.now() - body.timestamp) > SIGNATURE_MAX_AGE_MS) {
    return api.json({ error: "SIGNATURE_EXPIRED" }, { status: 401, event: "quest_arcs.signature_expired" })
  }
  const signed = await verifySignalSignature(body.wallet, { title: "quest-arc:generate", body: body.lang, timestamp: body.timestamp }, body.signature)
  if (!signed) return api.json({ error: "INVALID_SIGNATURE" }, { status: 401, event: "quest_arcs.bad_signature" })

  try {
    const arc = await generateArc({ wallet: body.wallet, lang: body.lang, replace: body.replace }, defaultArcDeps())
    void createNotification(body.wallet, "quest_arc_generated", { arc_id: arc.id, title: arc.title }).catch(() => {})
    return api.json(
      { arc: view(arc) },
      {
        status: 201,
        event: "quest_arcs.generated",
        metadata: { steps: arc.steps.length, text_source: arc.text_source },
        headers: { "Cache-Control": "no-store" },
      },
    )
  } catch (error) {
    if (error instanceof QuestArcError) {
      return api.json(
        { error: error.code, ...(error.details && typeof error.details === "object" ? (error.details as object) : {}) },
        { status: ERROR_STATUS[error.code], event: "quest_arcs.rejected", metadata: { code: error.code } },
      )
    }
    return api.errorJson(error, 500, "quest_arcs.generate_failed")
  }
}
