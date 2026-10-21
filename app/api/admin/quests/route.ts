import { NextRequest, NextResponse } from "next/server"
import {
  getQuestRegistry,
  updateQuestDefinition,
  toggleQuestEnabled,
  updateQuestReward,
  addNewQuest,
  removeQuest,
  reorderQuests,
  type QuestDefinition,
} from "@/lib/quest-registry"
import { ARC_LIMITS, QuestArcError, STEP_CATALOG, isQuestArcsEnabled, revokeArc } from "@/lib/quest-arcs"

/**
 * Admin API for managing quest definitions
 * 
 * GET /api/admin/quests - List all quests
 * POST /api/admin/quests - Create new quest
 * PATCH /api/admin/quests - Update quest settings
 * DELETE /api/admin/quests - Remove a quest
 */

export const dynamic = 'force-dynamic'

// Simple admin authentication - replace with proper auth in production
function validateAdminAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const adminToken = process.env.ADMIN_API_TOKEN?.trim()
  
  if (!adminToken) {
    console.warn("[admin/quests] ADMIN_API_TOKEN not configured - admin API disabled")
    return false
  }
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false
  }
  
  const token = authHeader.substring(7)
  return token === adminToken
}

/**
 * GET /api/admin/quests
 * Returns the complete quest registry
 */
export async function GET(req: NextRequest) {
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 }
    )
  }

  try {
    const registry = await getQuestRegistry()
    // phase-147: the closed step catalog generated arcs may draw from, so an
    // operator reviewing static quests sees what arcs can (and cannot) ask for.
    if (isQuestArcsEnabled()) {
      const arcCatalog = Object.entries(STEP_CATALOG).map(([kind, entry]) => ({
        kind,
        condition: entry.condition(null).type,
        onchain: entry.onchain,
        farmable: entry.farmable,
        difficulty: entry.difficulty,
      }))
      return NextResponse.json({
        ...registry,
        arcCatalog,
        arcLimits: {
          farmableMaxShare: ARC_LIMITS.FARMABLE_MAX_SHARE,
          maxArcsPerWindow: ARC_LIMITS.MAX_ARCS_PER_WINDOW,
          ttlMs: ARC_LIMITS.TTL_MS,
        },
      })
    }
    return NextResponse.json(registry)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * POST /api/admin/quests
 * Create a new quest
 * Body: QuestDefinition
 */
export async function POST(req: NextRequest) {
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 }
    )
  }

  try {
    const body = (await req.json()) as QuestDefinition
    
    // Validate required fields
    if (!body.id || !body.name || !body.rewardStroops || !body.conditions) {
      return NextResponse.json(
        { error: "Missing required fields: id, name, rewardStroops, conditions" },
        { status: 400 }
      )
    }

    await addNewQuest(body)
    return NextResponse.json({ ok: true, questId: body.id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * PATCH /api/admin/quests
 * Update quest configuration
 * Body: { action: "toggle" | "updateReward" | "update" | "reorder", questId?: string, ... }
 */
export async function PATCH(req: NextRequest) {
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 }
    )
  }

  try {
    const body = (await req.json()) as {
      action: "toggle" | "updateReward" | "update" | "reorder"
      questId?: string
      enabled?: boolean
      rewardStroops?: string
      updates?: Partial<QuestDefinition>
      questIds?: string[]
    }

    if (!body.action) {
      return NextResponse.json(
        { error: "Missing required field: action" },
        { status: 400 }
      )
    }

    switch (body.action) {
      case "toggle":
        if (!body.questId || body.enabled === undefined) {
          return NextResponse.json(
            { error: "Missing required fields: questId, enabled" },
            { status: 400 }
          )
        }
        await toggleQuestEnabled(body.questId, body.enabled)
        return NextResponse.json({ ok: true, questId: body.questId, enabled: body.enabled })

      case "updateReward":
        if (!body.questId || !body.rewardStroops) {
          return NextResponse.json(
            { error: "Missing required fields: questId, rewardStroops" },
            { status: 400 }
          )
        }
        await updateQuestReward(body.questId, body.rewardStroops)
        return NextResponse.json({ ok: true, questId: body.questId, rewardStroops: body.rewardStroops })

      case "update":
        if (!body.questId || !body.updates) {
          return NextResponse.json(
            { error: "Missing required fields: questId, updates" },
            { status: 400 }
          )
        }
        await updateQuestDefinition(body.questId, body.updates)
        return NextResponse.json({ ok: true, questId: body.questId })

      case "reorder":
        if (!body.questIds || !Array.isArray(body.questIds)) {
          return NextResponse.json(
            { error: "Missing required field: questIds (array)" },
            { status: 400 }
          )
        }
        await reorderQuests(body.questIds)
        return NextResponse.json({ ok: true, reordered: body.questIds })

      default:
        return NextResponse.json(
          { error: "Invalid action. Must be: toggle, updateReward, update, or reorder" },
          { status: 400 }
        )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * DELETE /api/admin/quests?questId=xxx
 * Remove a quest from the registry
 */
export async function DELETE(req: NextRequest) {
  if (!validateAdminAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid admin token required" },
      { status: 401 }
    )
  }

  try {
    // phase-147: `?arcId=` revokes a generated arc (claimed steps stay paid).
    const arcId = req.nextUrl.searchParams.get("arcId")
    if (arcId && isQuestArcsEnabled()) {
      try {
        const arc = revokeArc(arcId)
        return NextResponse.json({ ok: true, arcId, status: arc.status })
      } catch (e) {
        if (e instanceof QuestArcError) {
          return NextResponse.json({ error: e.code }, { status: e.code === "NOT_FOUND" ? 404 : 409 })
        }
        throw e
      }
    }

    const questId = req.nextUrl.searchParams.get("questId")
    
    if (!questId) {
      return NextResponse.json(
        { error: "Missing required query parameter: questId" },
        { status: 400 }
      )
    }

    await removeQuest(questId)
    return NextResponse.json({ ok: true, questId, removed: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
