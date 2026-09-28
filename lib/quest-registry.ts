import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { serverDataJsonPath } from "./server-data-paths"
import {
  checkHasPhased,
  fetchCreatorCollectionId,
  fetchCreatorCollectionIds,
  fetchTotalCollections,
  userOwnsAnyPhaseToken,
} from "./phase-protocol"
import { getAllWorldCollections } from "./narrative-world-store"

// ============================================================================
// Quest Registry Types
// ============================================================================

export type QuestConditionType =
  | "wallet_connected"
  | "nft_minted"
  | "collection_created"
  | "settlement_completed"
  | "world_created"
  | "collection_count"

export interface QuestCondition {
  type: QuestConditionType
  params?: Record<string, unknown>
}

export interface QuestDefinition {
  id: string
  name: string
  description: string
  rewardStroops: string
  enabled: boolean
  conditions: QuestCondition[]
  requirementText: string
  order: number
}

export interface QuestRegistry {
  quests: QuestDefinition[]
  lastUpdated: number
}

export interface QuestEvaluationResult {
  completed: boolean
  progressPct: number
  requirementText: string
}

// ============================================================================
// Default Quest Definitions
// ============================================================================

const DEFAULT_QUESTS: QuestDefinition[] = [
  {
    id: "quest_connect_wallet",
    name: "Connect Wallet",
    description: "Connect your Stellar wallet to get started",
    rewardStroops: "30000000",
    enabled: true,
    conditions: [{ type: "wallet_connected" }],
    requirementText: "Connect wallet is required.",
    order: 1,
  },
  {
    id: "quest_first_collection",
    name: "First Collection",
    description: "Forge your first collection or mint in any collection",
    rewardStroops: "30000000",
    enabled: true,
    conditions: [
      { type: "collection_created" },
      { type: "nft_minted" },
    ],
    requirementText: "Forge a collection, or mint once in any collection (Chamber / EXECUTE_SETTLEMENT).",
    order: 2,
  },
  {
    id: "quest_first_settle",
    name: "First Settlement",
    description: "Complete your first Chamber settlement",
    rewardStroops: "30000000",
    enabled: true,
    conditions: [{ type: "settlement_completed" }],
    requirementText: "Complete a Chamber settlement (signed phase mint on-chain).",
    order: 3,
  },
  {
    id: "quest_first_world",
    name: "World Creator",
    description: "Create your first narrative world",
    rewardStroops: "50000000",
    enabled: true,
    conditions: [{ type: "world_created" }],
    requirementText: "Create a narrative world in World Studio.",
    order: 4,
  },
  {
    id: "quest_three_collections",
    name: "Collection Master",
    description: "Mint in three different collections",
    rewardStroops: "50000000",
    enabled: true,
    conditions: [{ type: "collection_count", params: { minCount: 3 } }],
    requirementText: "Mint in 3 different collections.",
    order: 5,
  },
]

// ============================================================================
// Quest Registry Storage
// ============================================================================

function questRegistryPath(): string {
  return serverDataJsonPath("questRegistry" as any)
}

async function loadQuestRegistry(): Promise<QuestRegistry> {
  try {
    const raw = await readFile(questRegistryPath(), "utf8")
    const parsed = JSON.parse(raw) as QuestRegistry
    if (!parsed.quests || !Array.isArray(parsed.quests)) {
      return { quests: DEFAULT_QUESTS, lastUpdated: Date.now() }
    }
    return parsed
  } catch {
    return { quests: DEFAULT_QUESTS, lastUpdated: Date.now() }
  }
}

async function saveQuestRegistry(registry: QuestRegistry): Promise<void> {
  const file = questRegistryPath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(registry, null, 2), "utf8")
}

// ============================================================================
// Quest Condition Evaluators
// ============================================================================

const QUEST_COLLECTION_PHASE_SCAN_CAP = 256
const QUEST_OWNER_SCAN_WINDOW = 2000

interface EvaluationContext {
  wallet: string | null
  creatorCollectionId: number | null
  defaultPhase: { phased: boolean }
  totalCollections: number
  creatorCollectionIds: number[]
  worldCollections: Record<string, unknown>
}

async function buildEvaluationContext(wallet: string | null): Promise<EvaluationContext | null> {
  if (!wallet) return null

  try {
    const [creatorCollectionId, defaultPhase, totalColsRaw, creatorIds, worldsStore] = await Promise.all([
      fetchCreatorCollectionId(wallet),
      checkHasPhased(wallet, 0),
      fetchTotalCollections(),
      fetchCreatorCollectionIds(wallet),
      getAllWorldCollections(),
    ])

    return {
      wallet,
      creatorCollectionId,
      defaultPhase,
      totalCollections: totalColsRaw,
      creatorCollectionIds: creatorIds,
      worldCollections: worldsStore,
    }
  } catch {
    return null
  }
}

async function evaluateWalletConnected(
  wallet: string | null,
  _ctx: EvaluationContext | null,
  _params?: Record<string, unknown>
): Promise<QuestEvaluationResult> {
  return {
    completed: Boolean(wallet),
    progressPct: wallet ? 100 : 0,
    requirementText: "Connect wallet is required.",
  }
}

async function evaluateCollectionCreated(
  wallet: string | null,
  ctx: EvaluationContext | null,
  _params?: Record<string, unknown>
): Promise<QuestEvaluationResult> {
  if (!wallet || !ctx) {
    return { completed: false, progressPct: 0, requirementText: "Create a collection." }
  }

  const hasCreatorCollection = Boolean(ctx.creatorCollectionId && ctx.creatorCollectionId > 0)
  return {
    completed: hasCreatorCollection,
    progressPct: hasCreatorCollection ? 100 : 0,
    requirementText: "Create a collection.",
  }
}

async function evaluateNftMinted(
  wallet: string | null,
  ctx: EvaluationContext | null,
  _params?: Record<string, unknown>
): Promise<QuestEvaluationResult> {
  if (!wallet || !ctx) {
    return { completed: false, progressPct: 0, requirementText: "Mint an NFT." }
  }

  let hasMintedPhase = Boolean(ctx.defaultPhase.phased)
  if (!hasMintedPhase && ctx.creatorCollectionId != null && ctx.creatorCollectionId > 0) {
    const ownCol = await checkHasPhased(wallet, ctx.creatorCollectionId)
    hasMintedPhase = Boolean(ownCol.phased)
  }

  return {
    completed: hasMintedPhase,
    progressPct: hasMintedPhase ? 100 : 0,
    requirementText: "Mint an NFT.",
  }
}

async function evaluateSettlementCompleted(
  wallet: string | null,
  ctx: EvaluationContext | null,
  _params?: Record<string, unknown>
): Promise<QuestEvaluationResult> {
  if (!wallet || !ctx) {
    return { completed: false, progressPct: 0, requirementText: "Complete a settlement." }
  }

  let hasMintedPhase = Boolean(ctx.defaultPhase.phased)
  if (!hasMintedPhase && ctx.creatorCollectionId != null && ctx.creatorCollectionId > 0) {
    const ownCol = await checkHasPhased(wallet, ctx.creatorCollectionId)
    hasMintedPhase = Boolean(ownCol.phased)
  }

  const hasSettlement = hasMintedPhase || (await userOwnsAnyPhaseToken(wallet, QUEST_OWNER_SCAN_WINDOW))

  const hasCreatorCollection = Boolean(ctx.creatorCollectionId && ctx.creatorCollectionId > 0)
  const progressPct = hasSettlement ? 100 : hasCreatorCollection ? 50 : 0

  return {
    completed: hasSettlement,
    progressPct,
    requirementText: "Complete a settlement.",
  }
}

async function evaluateWorldCreated(
  wallet: string | null,
  ctx: EvaluationContext | null,
  _params?: Record<string, unknown>
): Promise<QuestEvaluationResult> {
  if (!wallet || !ctx) {
    return { completed: false, progressPct: 0, requirementText: "Create a world." }
  }

  const worldCollectionIds = new Set(Object.keys(ctx.worldCollections).map(Number))
  const hasFirstWorld = ctx.creatorCollectionIds.some((id) => worldCollectionIds.has(id))

  const hasCreatorCollection = Boolean(ctx.creatorCollectionId && ctx.creatorCollectionId > 0)
  const progressPct = hasFirstWorld ? 100 : hasCreatorCollection ? 40 : 0

  return {
    completed: hasFirstWorld,
    progressPct,
    requirementText: "Create a world.",
  }
}

async function evaluateCollectionCount(
  wallet: string | null,
  ctx: EvaluationContext | null,
  params?: Record<string, unknown>
): Promise<QuestEvaluationResult> {
  const minCount = (params?.minCount as number) ?? 3

  if (!wallet || !ctx) {
    return {
      completed: false,
      progressPct: 0,
      requirementText: `Mint in ${minCount} different collections.`,
    }
  }

  let hasMintedPhase = Boolean(ctx.defaultPhase.phased)
  let mintedCollectionCount = hasMintedPhase ? 1 : 0

  const colCap = Math.min(Math.max(ctx.totalCollections, 0), QUEST_COLLECTION_PHASE_SCAN_CAP)
  if (colCap > 0) {
    const conc = 8
    for (let start = 1; start <= colCap; start += conc) {
      if (hasMintedPhase && mintedCollectionCount >= minCount) break
      const batch: Promise<{ phased: boolean }>[] = []
      for (let j = 0; j < conc && start + j <= colCap; j++) {
        batch.push(checkHasPhased(wallet, start + j))
      }
      const results = await Promise.all(batch)
      for (const r of results) {
        if (r.phased) {
          hasMintedPhase = true
          mintedCollectionCount++
        }
      }
    }
  }

  const threeColsDone = mintedCollectionCount >= minCount
  const progressPct = Math.min(100, Math.round((mintedCollectionCount / minCount) * 100))

  return {
    completed: threeColsDone,
    progressPct,
    requirementText: `Mint in ${minCount} different collections.`,
  }
}

const CONDITION_EVALUATORS: Record<
  QuestConditionType,
  (
    wallet: string | null,
    ctx: EvaluationContext | null,
    params?: Record<string, unknown>
  ) => Promise<QuestEvaluationResult>
> = {
  wallet_connected: evaluateWalletConnected,
  collection_created: evaluateCollectionCreated,
  nft_minted: evaluateNftMinted,
  settlement_completed: evaluateSettlementCompleted,
  world_created: evaluateWorldCreated,
  collection_count: evaluateCollectionCount,
}

// ============================================================================
// Quest Evaluation Pipeline
// ============================================================================

async function evaluateQuestConditions(
  quest: QuestDefinition,
  wallet: string | null,
  ctx: EvaluationContext | null
): Promise<QuestEvaluationResult> {
  if (quest.conditions.length === 0) {
    return { completed: false, progressPct: 0, requirementText: quest.requirementText }
  }

  // For quests with multiple conditions, we use OR logic (any condition can satisfy)
  const results = await Promise.all(
    quest.conditions.map((cond) => {
      const evaluator = CONDITION_EVALUATORS[cond.type]
      if (!evaluator) {
        return Promise.resolve({ completed: false, progressPct: 0, requirementText: quest.requirementText })
      }
      return evaluator(wallet, ctx, cond.params)
    })
  )

  // Take the best result (OR logic)
  const bestResult = results.reduce((best, curr) => {
    if (curr.completed) return curr
    if (curr.progressPct > best.progressPct) return curr
    return best
  }, results[0])

  return {
    completed: bestResult.completed,
    progressPct: bestResult.progressPct,
    requirementText: quest.requirementText,
  }
}

export async function evaluateAllQuests(
  wallet: string | null
): Promise<Record<string, QuestEvaluationResult>> {
  const registry = await loadQuestRegistry()
  const enabledQuests = registry.quests.filter((q) => q.enabled).sort((a, b) => a.order - b.order)

  if (!wallet) {
    const results: Record<string, QuestEvaluationResult> = {}
    for (const quest of enabledQuests) {
      results[quest.id] = { completed: false, progressPct: 0, requirementText: quest.requirementText }
    }
    // Special case: wallet_connected can be evaluated without context
    const connectQuest = enabledQuests.find((q) => q.id === "quest_connect_wallet")
    if (connectQuest) {
      results[connectQuest.id] = await evaluateQuestConditions(connectQuest, null, null)
    }
    return results
  }

  const ctx = await buildEvaluationContext(wallet)
  const results: Record<string, QuestEvaluationResult> = {}

  for (const quest of enabledQuests) {
    results[quest.id] = await evaluateQuestConditions(quest, wallet, ctx)
  }

  return results
}

// ============================================================================
// Quest Registry Management API
// ============================================================================

export async function getQuestRegistry(): Promise<QuestRegistry> {
  return await loadQuestRegistry()
}

export async function updateQuestDefinition(questId: string, updates: Partial<QuestDefinition>): Promise<void> {
  const registry = await loadQuestRegistry()
  const questIndex = registry.quests.findIndex((q) => q.id === questId)

  if (questIndex === -1) {
    throw new Error(`Quest not found: ${questId}`)
  }

  registry.quests[questIndex] = { ...registry.quests[questIndex], ...updates }
  registry.lastUpdated = Date.now()
  await saveQuestRegistry(registry)
}

export async function toggleQuestEnabled(questId: string, enabled: boolean): Promise<void> {
  await updateQuestDefinition(questId, { enabled })
}

export async function updateQuestReward(questId: string, rewardStroops: string): Promise<void> {
  await updateQuestDefinition(questId, { rewardStroops })
}

export async function addNewQuest(quest: QuestDefinition): Promise<void> {
  const registry = await loadQuestRegistry()
  
  // Check if quest already exists
  const existingIndex = registry.quests.findIndex((q) => q.id === quest.id)
  if (existingIndex !== -1) {
    throw new Error(`Quest already exists: ${quest.id}`)
  }

  registry.quests.push(quest)
  registry.lastUpdated = Date.now()
  await saveQuestRegistry(registry)
}

export async function removeQuest(questId: string): Promise<void> {
  const registry = await loadQuestRegistry()
  registry.quests = registry.quests.filter((q) => q.id !== questId)
  registry.lastUpdated = Date.now()
  await saveQuestRegistry(registry)
}

export async function reorderQuests(questIds: string[]): Promise<void> {
  const registry = await loadQuestRegistry()
  
  const reordered = questIds.map((id, index) => {
    const quest = registry.quests.find((q) => q.id === id)
    if (!quest) throw new Error(`Quest not found: ${id}`)
    return { ...quest, order: index + 1 }
  })

  registry.quests = reordered
  registry.lastUpdated = Date.now()
  await saveQuestRegistry(registry)
}

// ============================================================================
// Helper Functions
// ============================================================================

export function getQuestIds(registry: QuestRegistry): string[] {
  return registry.quests.filter((q) => q.enabled).map((q) => q.id)
}

export function getQuestRewardAmount(registry: QuestRegistry, questId: string): string {
  const quest = registry.quests.find((q) => q.id === questId)
  return quest?.rewardStroops ?? "0"
}

export function isValidQuestId(registry: QuestRegistry, questId: string): boolean {
  return registry.quests.some((q) => q.id === questId && q.enabled)
}
