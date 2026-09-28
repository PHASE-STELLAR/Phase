import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getAllWorldCollections,
  getAllNarrativesCount,
  countCollectorsInWorlds,
  getRecentNarrativesForCollection,
  getWorldForCollection,
  saveWorldForCollection,
  ensureWorldOwner,
  type NarratorTone,
} from "@/lib/narrative-world-store"
import { checkAndUnlock } from "@/lib/achievement-store"
import { checkWorldConflict, normalizeVectorClock, type VectorClock } from "@/lib/world-conflict"

export type WorldsListItem = {
  collectionId: number
  world_name: string
  world_prompt: string
  created_at: number
  narrativeCount: number
  latestNarrative: string | null
  narrator_tone?: NarratorTone
  /** Current revision — pass as `expected_version` on the next save (phase-105). */
  version?: number
  /** Per-author vector clock — pass as `expected_vector_clock` on the next save (phase-105). */
  vector_clock?: VectorClock
}

export type WorldsGlobalStats = {
  worldsActive: number
  totalArtifacts: number
  narrativesGenerated: number
  collectors: number
}

export async function GET() {
  const store = await getAllWorldCollections()
  const items: WorldsListItem[] = await Promise.all(
    Object.entries(store).map(async ([id, data]) => {
      const narratives = await getRecentNarrativesForCollection(Number(id), 50)
      return {
        collectionId: Number(id),
        world_name: data.world_name,
        world_prompt: data.world_prompt,
        created_at: data.created_at,
        narrativeCount: narratives.length,
        latestNarrative: narratives[0]?.narrative ?? null,
        narrator_tone: data.narrator_tone,
        version: data.version,
        vector_clock: normalizeVectorClock(data.vector_clock) ?? undefined,
      }
    }),
  )
  items.sort((a, b) => b.collectionId - a.collectionId)

  const activeCollectionIds = items.map((w) => w.collectionId)
  const [totalArtifacts, collectors] = await Promise.all([
    getAllNarrativesCount(),
    countCollectorsInWorlds(activeCollectionIds),
  ])
  const narrativesGenerated = items.reduce((sum, w) => sum + w.narrativeCount, 0)
  const globalStats: WorldsGlobalStats = {
    worldsActive: items.length,
    totalArtifacts,
    narrativesGenerated,
    collectors,
  }

  return NextResponse.json({ items, globalStats })
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_TONES: NarratorTone[] = ["enigmatic", "epic", "scientific", "folkloric"]

type WorldSaveBody = {
  collection_id?: unknown
  world_name?: unknown
  world_prompt?: unknown
  narrator_tone?: unknown
  creator_wallet?: unknown
  /** Client's last-known world version — only checked when phase-105 is enabled. */
  expected_version?: unknown
  /** Client's last-known vector clock (object or `[node, counter]` entries) — phase-105. */
  expected_vector_clock?: unknown
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

function isValidTone(v: unknown): v is NarratorTone {
  return typeof v === "string" && (VALID_TONES as string[]).includes(v)
}

export async function POST(request: NextRequest) {
  let body: WorldSaveBody
  try {
    body = (await request.json()) as WorldSaveBody
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 })
  }

  const collectionId = Number(body.collection_id)
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: "collection_id debe ser un entero positivo" }, { status: 400 })
  }

  if (!isNonEmptyString(body.world_name) || body.world_name.trim().length > 80) {
    return NextResponse.json(
      { error: "world_name es requerido y debe tener máximo 80 caracteres" },
      { status: 400 },
    )
  }

  if (!isNonEmptyString(body.world_prompt) || body.world_prompt.trim().length > 1000) {
    return NextResponse.json(
      { error: "world_prompt es requerido y debe tener máximo 1000 caracteres" },
      { status: 400 },
    )
  }

  if (body.narrator_tone !== undefined && !isValidTone(body.narrator_tone)) {
    return NextResponse.json(
      { error: `narrator_tone inválido. Valores permitidos: ${VALID_TONES.join(", ")}` },
      { status: 400 },
    )
  }

  const creatorWallet =
    typeof body.creator_wallet === "string" && StrKey.isValidEd25519PublicKey(body.creator_wallet)
      ? body.creator_wallet
      : undefined

  let expectedVersion: number | undefined
  if (body.expected_version !== undefined) {
    if (!Number.isSafeInteger(body.expected_version) || (body.expected_version as number) < 0) {
      return NextResponse.json(
        { error: "expected_version debe ser un entero no negativo" },
        { status: 400 },
      )
    }
    expectedVersion = body.expected_version as number
  }

  let expectedVectorClock: VectorClock | undefined
  if (body.expected_vector_clock !== undefined) {
    const normalized = normalizeVectorClock(body.expected_vector_clock)
    if (!normalized) {
      return NextResponse.json(
        { error: "expected_vector_clock inválido: se espera un objeto o una lista de pares [nodo, contador]" },
        { status: 400 },
      )
    }
    expectedVectorClock = normalized
  }

  const conflict = checkWorldConflict(
    await getWorldForCollection(collectionId),
    expectedVersion,
    expectedVectorClock,
  )
  if (conflict.conflict) {
    return NextResponse.json(
      {
        error: "WORLD_VERSION_CONFLICT",
        order: conflict.order,
        server_version: conflict.serverVersion,
        client_version: conflict.clientVersion,
        server_vector_clock: conflict.serverVectorClock,
        current: conflict.current,
      },
      { status: 409 },
    )
  }

  const saved = await saveWorldForCollection(collectionId, {
    world_name: body.world_name.trim(),
    world_prompt: body.world_prompt.trim(),
    narrator_tone: isValidTone(body.narrator_tone) ? body.narrator_tone : undefined,
    creator_wallet: creatorWallet,
  })

  if (creatorWallet) {
    // phase-109: the creating wallet becomes the world's owner for role checks.
    void ensureWorldOwner(collectionId, creatorWallet).catch(() => { /* silent */ })
    // Achievements: fire-and-forget
    void checkAndUnlock(creatorWallet, { has_world: true }).catch(() => { /* silent */ })
  }

  return NextResponse.json({
    ok: true,
    collection_id: collectionId,
    version: saved.version,
    vector_clock: saved.vector_clock,
  })
}
