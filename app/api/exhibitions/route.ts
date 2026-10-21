import { NextRequest } from "next/server"
import { z } from "zod"
import { createApiRequestContext } from "@/lib/api-observability"
import { checkAdminKey } from "@/lib/admin-key"
import {
  CuratorError,
  draftExhibition,
  isCuratorEnabled,
  listExhibitions,
  publicExhibition,
  type ExhibitionStatus,
} from "@/lib/exhibition-curator"
import { getAllWorldCollections, getNarrativeCorpus } from "@/lib/narrative-world-store"
import { getWashFlaggedTokenIds } from "@/lib/market-store"
import { lookupCachedOwners } from "@/lib/explore-owners-cache"
import { mapConcurrent } from "@/lib/explore-domain"
import { fetchTokenOwnerAddress, phaseProtocolContractIdForServer } from "@/lib/phase-protocol"
import { buildPhaseTokenMetadataJson } from "@/lib/phase-nft-metadata-build"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const ROUTE = "/api/exhibitions"

export async function GET(request: NextRequest) {
  const api = createApiRequestContext(request, ROUTE)
  if (!isCuratorEnabled()) {
    return api.json({ error: "EXHIBITIONS_DISABLED" }, { status: 404, event: "exhibitions.disabled" })
  }
  const sp = request.nextUrl.searchParams
  const requested = sp.get("status") as ExhibitionStatus | null
  // Drafts are operator-only; the public sees what is or was on view.
  const status: ExhibitionStatus =
    requested === "draft" ? "draft" : requested === "rotated" ? "rotated" : "published"
  if (status === "draft" && checkAdminKey(request) !== "ok") {
    return api.json({ error: "UNAUTHORIZED" }, { status: 401, event: "exhibitions.unauthorized" })
  }
  const scope = sp.get("scope")?.trim() || undefined
  const exhibitions = listExhibitions({ scope, status, limit: Number(sp.get("limit") ?? 20) || 20 })
  return api.json(
    { exhibitions: exhibitions.map(publicExhibition) },
    {
      event: "exhibitions.listed",
      metadata: { status, count: exhibitions.length },
      headers: { "Cache-Control": status === "draft" ? "no-store" : "public, s-maxage=60, stale-while-revalidate=300" },
    },
  )
}

const DraftBodySchema = z.object({
  theme: z.string().trim().max(120).optional(),
  collection_ids: z.array(z.number().int().positive()).max(50).optional(),
  lang: z.enum(["en", "es"]).default("en"),
  max_works: z.number().int().min(4).max(12).optional(),
})

const OWNER_FETCH_CONCURRENCY = 5

async function resolveOwners(tokenIds: number[]): Promise<Map<number, string>> {
  const owners = lookupCachedOwners(tokenIds)
  const missing = tokenIds.filter((id) => !owners.has(id))
  if (missing.length > 0) {
    const contractId = phaseProtocolContractIdForServer()
    const fetched = await mapConcurrent(missing, OWNER_FETCH_CONCURRENCY, async (id) => {
      try {
        const owner = await fetchTokenOwnerAddress(contractId, id)
        return owner ? ([id, owner] as const) : null
      } catch {
        return null
      }
    })
    for (const entry of fetched) if (entry) owners.set(entry[0], entry[1])
  }
  return owners
}

async function resolveImages(tokenIds: number[]): Promise<Map<number, string>> {
  const contractId = phaseProtocolContractIdForServer()
  const rows = await mapConcurrent(tokenIds, 4, async (id) => {
    const meta = await buildPhaseTokenMetadataJson(contractId, id).catch(() => null)
    return [id, meta?.image ?? ""] as const
  })
  return new Map(rows)
}

export async function POST(request: NextRequest) {
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

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return api.json({ error: "INVALID_JSON" }, { status: 400, event: "exhibitions.invalid_json" })
  }
  const parsed = DraftBodySchema.safeParse(json)
  if (!parsed.success) {
    return api.json(
      { error: "VALIDATION_FAILED", details: parsed.error.flatten() },
      { status: 400, event: "exhibitions.validation_failed" },
    )
  }
  const body = parsed.data
  const collectionIds = body.collection_ids ? [...new Set(body.collection_ids)].sort((a, b) => a - b) : undefined
  const scope = collectionIds?.length === 1 ? `collection:${collectionIds[0]}` : collectionIds ? `collections:${collectionIds.join(",")}` : "global"

  try {
    const { exhibition, reused } = await draftExhibition(
      { scope, collectionIds, theme: body.theme, lang: body.lang, maxWorks: body.max_works },
      {
        corpus: () => getNarrativeCorpus({ collectionIds }),
        worldNames: async () => {
          const worlds = await getAllWorldCollections().catch(() => ({}) as Record<string, { world_name: string }>)
          return Object.fromEntries(Object.entries(worlds).map(([id, w]) => [id, w.world_name]))
        },
        washFlaggedTokenIds: getWashFlaggedTokenIds,
        resolveOwners,
        resolveImages,
      },
    )
    return api.json(
      { exhibition: publicExhibition(exhibition), reused },
      {
        status: reused ? 200 : 201,
        event: reused ? "exhibitions.draft_reused" : "exhibitions.drafted",
        metadata: { scope, works: exhibition.hang.length, text_source: exhibition.text_source },
        headers: { "Cache-Control": "no-store" },
      },
    )
  } catch (error) {
    if (error instanceof CuratorError && error.code === "INSUFFICIENT_CANDIDATES") {
      return api.json(
        { error: error.code, details: error.details ?? null },
        { status: 422, event: "exhibitions.insufficient_candidates" },
      )
    }
    return api.errorJson(error, 500, "exhibitions.draft_failed")
  }
}
