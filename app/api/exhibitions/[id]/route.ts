import { NextRequest } from "next/server"
import { createApiRequestContext } from "@/lib/api-observability"
import { checkAdminKey } from "@/lib/admin-key"
import { CuratorError, getExhibition, isCuratorEnabled, publicExhibition, transitionExhibition } from "@/lib/exhibition-curator"
import { createNotification } from "@/lib/notification-store"
import { parseVersionHeader, signalETag } from "@/lib/signal-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ROUTE = "/api/exhibitions/[id]"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const api = createApiRequestContext(request, ROUTE)
  if (!isCuratorEnabled()) {
    return api.json({ error: "EXHIBITIONS_DISABLED" }, { status: 404, event: "exhibitions.disabled" })
  }
  const { id } = await params
  const exhibition = getExhibition(id)
  if (!exhibition || (exhibition.status === "draft" && checkAdminKey(request) !== "ok")) {
    return api.json({ error: "NOT_FOUND" }, { status: 404, event: "exhibitions.not_found" })
  }
  return api.json(
    { exhibition: publicExhibition(exhibition) },
    {
      event: "exhibitions.loaded",
      headers: {
        ETag: signalETag(exhibition.version),
        "Cache-Control": exhibition.status === "draft" ? "no-store" : "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  )
}

/** Body `{ "action": "publish" | "rotate" }`, header `If-Match: "<version>"`. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const api = createApiRequestContext(request, ROUTE)
  if (!isCuratorEnabled()) {
    return api.json({ error: "EXHIBITIONS_DISABLED" }, { status: 404, event: "exhibitions.disabled" })
  }
  const auth = checkAdminKey(request)
  if (auth !== "ok") {
    return api.json(
      { error: auth === "unconfigured" ? "CURATOR_NOT_CONFIGURED" : "UNAUTHORIZED" },
      { status: auth === "unconfigured" ? 503 : 401, event: "exhibitions.unauthorized" },
    )
  }
  const expectedVersion = parseVersionHeader(request.headers.get("if-match") ?? "")
  if (expectedVersion === null) {
    return api.json({ error: "IF_MATCH_REQUIRED" }, { status: 428, event: "exhibitions.if_match_missing" })
  }
  let body: { action?: unknown }
  try {
    body = (await request.json()) as { action?: unknown }
  } catch {
    return api.json({ error: "INVALID_JSON" }, { status: 400, event: "exhibitions.invalid_json" })
  }
  if (body.action !== "publish" && body.action !== "rotate") {
    return api.json({ error: "VALIDATION_FAILED" }, { status: 400, event: "exhibitions.validation_failed" })
  }

  const { id } = await params
  try {
    const { exhibition, rotated } = transitionExhibition(id, expectedVersion, body.action === "publish" ? "published" : "rotated")
    if (exhibition.status === "published") {
      // After commit, one notification per hung work; a failed notify never
      // un-publishes the show.
      for (const slot of exhibition.hang) {
        void createNotification(slot.owner, "exhibition_published", {
          exhibition_id: exhibition.id,
          title: exhibition.title,
          token_id: slot.token_id,
        }).catch((error) => api.log("warn", "exhibitions.notify_failed", { error: String(error) }))
      }
    }
    return api.json(
      { exhibition: publicExhibition(exhibition), rotated },
      { event: `exhibitions.${exhibition.status}`, headers: { ETag: signalETag(exhibition.version), "Cache-Control": "no-store" } },
    )
  } catch (error) {
    if (error instanceof CuratorError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "VERSION_CONFLICT" || error.code === "INVALID_TRANSITION" ? 409 : 400
      return api.json(
        { error: error.code, ...(error.details && typeof error.details === "object" ? (error.details as object) : {}) },
        { status, event: "exhibitions.transition_rejected", metadata: { code: error.code } },
      )
    }
    return api.errorJson(error, 500, "exhibitions.transition_failed")
  }
}
