/**
 * Personalized quest arcs — phase-147
 *
 * An arc is a 3–5 step storyline generated per wallet from its history, with a
 * difficulty ramp and rewards sized against the treasury.
 *
 * What is generated and what is not:
 *
 * - Steps come from a CLOSED catalog. Each step kind maps to a QuestCondition
 *   evaluated by the same evaluator the static quests use (quest-registry), so
 *   a generated quest can never ask for — or pay for — something the protocol
 *   cannot verify. The model writes the arc's title and the flavour line of
 *   each step, nothing else; its reply is checked against the step indices and
 *   may not contain numbers (no amounts).
 * - Rewards are deterministic: a per-difficulty schedule plus a completion
 *   bonus on the last step, scaled down to a share of the distributor's
 *   available balance, and capped. A step whose condition an enabled static
 *   quest already pays for is a story step with reward 0 — the static quest
 *   pays it once.
 *
 * Anti-farm review (`reviewArc`) rejects any plan whose farmable (off-chain,
 * cheap to repeat) steps carry more than FARMABLE_MAX_SHARE of the reward,
 * whose steps fall outside the catalog, or that has no on-chain step. Identity
 * gates (deny list, sybil band) and rate limits (one active arc, MAX_ARCS_PER_WINDOW)
 * run before generation.
 *
 * State: every transition is a version-guarded rewrite of the arc row, so a
 * claim, a refresh and a replacement cannot both win. Claims are ordered (step
 * n is claimable once steps < n are claimed) and two-phase — `claiming` while
 * the faucet transaction is in flight, `claimed` once it lands, back to `done`
 * if it fails — mirroring the faucet's own pending/TTL protocol.
 *
 * Feature flag: phase-147. Rollback: unset → arc routes 404, `arc:*` rewards
 * stop parsing in the faucet; quest_arcs rows are inert.
 */

import { randomUUID } from "node:crypto"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getDb } from "@/lib/sqlite-db"
import { incSecurityCounter } from "@/lib/security-counters"
import { chargeAiStep } from "@/lib/cost-attribution-ledger"
import { fillCopy, pickCopy } from "@/lib/phase-copy"
import { buildQuestArcPrompt } from "@/lib/forge/prompt-builder"
import { generateJsonStep, type AiJsonGenerator } from "@/lib/forge/ai-pipeline"
import { questConditionKey, type QuestCondition } from "@/lib/quest-registry"

export function isQuestArcsEnabled(): boolean {
  return isFeatureEnabled("phase-147")
}

const DAY_MS = 24 * 3_600_000
const PHASELQ = 10_000_000n

export const ARC_LIMITS = {
  MIN_STEPS: 3,
  MAX_STEPS: 5,
  TTL_MS: 14 * DAY_MS,
  RATE_WINDOW_MS: 30 * DAY_MS,
  MAX_ARCS_PER_WINDOW: 3,
  /** Matches FAUCET_PENDING_TTL_MS: a claim stuck longer than this may restart. */
  CLAIM_TTL_MS: 8 * 60_000,
  FARMABLE_MAX_SHARE: 0.4,
  FARMABLE_STEP_MAX_STROOPS: PHASELQ,
  COMPLETION_BONUS_STROOPS: 2n * PHASELQ,
  /** Share of available distributor balance one arc may promise. */
  TREASURY_SHARE_BPS: 50n,
  UNKNOWN_TREASURY_MAX_STROOPS: 5n * PHASELQ,
  MIN_ARC_STROOPS: PHASELQ,
} as const

function arcMaxStroops(): bigint {
  const raw = process.env.PHASE_QUEST_ARC_MAX_STROOPS?.trim()
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : 15n * PHASELQ
}

export type StepKind =
  | "create_collection"
  | "mint_nft"
  | "settle"
  | "create_world"
  | "collection_count"
  | "daily_streak"
  | "post_signal"

type CatalogEntry = {
  condition: (target: number | null) => QuestCondition
  onchain: boolean
  farmable: boolean
  difficulty: number
}

/** The whole universe of things an arc may ask for. Nothing outside it is generated. */
export const STEP_CATALOG: Record<StepKind, CatalogEntry> = {
  create_collection: { condition: () => ({ type: "collection_created" }), onchain: true, farmable: false, difficulty: 1 },
  mint_nft: { condition: () => ({ type: "nft_minted" }), onchain: true, farmable: false, difficulty: 1 },
  settle: { condition: () => ({ type: "settlement_completed" }), onchain: true, farmable: false, difficulty: 2 },
  create_world: { condition: () => ({ type: "world_created" }), onchain: false, farmable: false, difficulty: 2 },
  collection_count: {
    condition: (t) => ({ type: "collection_count", params: { minCount: t ?? 2 } }),
    onchain: true,
    farmable: false,
    difficulty: 3,
  },
  daily_streak: { condition: (t) => ({ type: "daily_streak", params: { minDays: t ?? 3 } }), onchain: false, farmable: true, difficulty: 2 },
  post_signal: { condition: () => ({ type: "signal_posted" }), onchain: false, farmable: true, difficulty: 1 },
}

const REWARD_BY_DIFFICULTY: Record<number, bigint> = { 1: PHASELQ, 2: 2n * PHASELQ, 3: 3n * PHASELQ, 4: 4n * PHASELQ }

export type StepState = "locked" | "open" | "done" | "claiming" | "claimed"
export type ArcStatus = "active" | "completed" | "expired" | "superseded"

export type ArcStep = {
  index: number
  /** OR-alternatives: the step is done when any kind's condition holds. */
  kinds: StepKind[]
  target: number | null
  difficulty: number
  onchain: boolean
  farmable: boolean
  reward_stroops: string
  /** Set when an enabled static quest already pays for this condition. */
  paid_by_static: boolean
  state: StepState
  text: string
  done_at: number | null
  claim_started_at: number | null
  claim_hold_id: string | null
  claimed_at: number | null
  tx_hash: string | null
}

export type QuestArc = {
  id: string
  wallet: string
  status: ArcStatus
  version: number
  lang: "en" | "es"
  title: string
  steps: ArcStep[]
  total_reward_stroops: string
  diagnosis: WalletDiagnosis
  model_id: string | null
  text_source: "model" | "fallback"
  created_at: number
  updated_at: number
  expires_at: number
  superseded_by: string | null
}

export type WalletDiagnosis = {
  ageBand: "new" | "established" | "unknown"
  satisfied: string[]
  mintedCollections: number
  streak: number
}

export class QuestArcError extends Error {
  constructor(
    readonly code:
      | "FLAG_DISABLED"
      | "ALREADY_ACTIVE"
      | "RATE_LIMITED"
      | "NO_ELIGIBLE_STEPS"
      | "TREASURY_LOW"
      | "IDENTITY_BLOCKED"
      | "FARMABLE"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "STEP_NOT_CLAIMABLE",
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "QuestArcError"
  }
}

// ── pure: plan, size, review ────────────────────────────────────────────────

type PlannedStep = Pick<ArcStep, "kinds" | "target" | "difficulty" | "onchain" | "farmable">

/**
 * Choose 3–5 unsatisfied steps, easiest first, ending on a multi-collection
 * mint. New wallets get nearer targets; when both "create a collection" and
 * "mint" are open they become one step with two ways through (branching)
 * rather than two near-identical steps.
 *
 * The finale is always `collection_count`: every other on-chain kind is already
 * paid by a static quest (so it is a zero-reward story step here), and the
 * completion bonus must land on an on-chain step or the arc's reward would be
 * mostly farmable. A target of 3 is skipped because quest_three_collections
 * pays it. A wallet already past 5 collections gets no arc (NO_ELIGIBLE_STEPS).
 */
export function planArcSteps(d: WalletDiagnosis): PlannedStep[] {
  const done = new Set(d.satisfied)
  const steps: PlannedStep[] = []
  const add = (kinds: StepKind[], target: number | null, difficultyBump = 0) => {
    const entries = kinds.map((k) => STEP_CATALOG[k])
    steps.push({
      kinds,
      target,
      difficulty: Math.min(4, Math.max(...entries.map((e) => e.difficulty)) + difficultyBump),
      onchain: entries.some((e) => e.onchain),
      farmable: entries.every((e) => e.farmable),
    })
  }

  const entry = (["create_collection", "mint_nft"] as const).filter((k) => !done.has(k))
  if (entry.length > 0) add([...entry], null)
  if (!done.has("post_signal")) add(["post_signal"], null)
  if (!done.has("settle")) add(["settle"], null)
  if (!done.has("create_world")) add(["create_world"], null)

  const established = d.ageBand === "established"
  const streakTarget = established ? 7 : 3
  if (d.streak < streakTarget) add(["daily_streak"], streakTarget, established ? 1 : 0)

  const head = [...steps].sort((a, b) => a.difficulty - b.difficulty || Number(b.onchain) - Number(a.onchain))

  let target = Math.min(5, Math.max(2, d.mintedCollections + (established ? 2 : 1)))
  if (target === 3) target = 4
  if (d.mintedCollections >= target) return []
  add(["collection_count"], target, target >= 4 ? 1 : 0)
  return [...head.slice(0, ARC_LIMITS.MAX_STEPS - 1), steps[steps.length - 1]!]
}

export type TreasuryView = { availableStroops: bigint | null; healthy: boolean }

/**
 * Per-step rewards from the difficulty schedule, a completion bonus on the last
 * step, zero for statically-paid conditions, then scaled to fit the budget:
 * min(cap, share of available balance). Throws TREASURY_LOW when the budget
 * cannot cover even MIN_ARC_STROOPS.
 */
export function sizeArcRewards(
  steps: readonly PlannedStep[],
  staticKeys: ReadonlySet<string>,
  treasury: TreasuryView,
): Array<{ reward: bigint; paidByStatic: boolean }> {
  if (!treasury.healthy) throw new QuestArcError("TREASURY_LOW", "distributor health check is failing")
  const budgetFromTreasury =
    treasury.availableStroops === null ? ARC_LIMITS.UNKNOWN_TREASURY_MAX_STROOPS : (treasury.availableStroops * ARC_LIMITS.TREASURY_SHARE_BPS) / 10_000n
  const budget = budgetFromTreasury < arcMaxStroops() ? budgetFromTreasury : arcMaxStroops()
  if (budget < ARC_LIMITS.MIN_ARC_STROOPS) throw new QuestArcError("TREASURY_LOW", "treasury budget below arc minimum")

  const raw = steps.map((step, i) => {
    const paidByStatic = step.kinds.some((k) => staticKeys.has(questConditionKey(STEP_CATALOG[k].condition(step.target))))
    let reward = paidByStatic ? 0n : REWARD_BY_DIFFICULTY[step.difficulty] ?? PHASELQ
    if (step.farmable && reward > ARC_LIMITS.FARMABLE_STEP_MAX_STROOPS) reward = ARC_LIMITS.FARMABLE_STEP_MAX_STROOPS
    if (i === steps.length - 1) reward += ARC_LIMITS.COMPLETION_BONUS_STROOPS
    return { reward, paidByStatic }
  })
  const total = raw.reduce((s, r) => s + r.reward, 0n)
  if (total <= budget) return raw
  return raw.map((r) => ({ ...r, reward: (r.reward * budget) / total }))
}

export type ArcReview = { ok: true } | { ok: false; reasons: string[] }

/** The farmability gate. Pure, so it can be run against any plan, including a model-assisted one. */
export function reviewArc(
  steps: ReadonlyArray<Pick<ArcStep, "kinds" | "onchain" | "farmable" | "reward_stroops" | "paid_by_static" | "difficulty">>,
): ArcReview {
  const reasons: string[] = []
  if (steps.length < ARC_LIMITS.MIN_STEPS || steps.length > ARC_LIMITS.MAX_STEPS) reasons.push("step_count")
  if (steps.some((s) => s.kinds.length === 0 || s.kinds.some((k) => !(k in STEP_CATALOG)))) reasons.push("outside_catalog")
  if (!steps.some((s) => s.onchain)) reasons.push("no_onchain_step")
  if (steps.some((s, i) => i > 0 && s.difficulty < steps[i - 1]!.difficulty)) reasons.push("difficulty_ramp")
  if (steps.some((s) => s.paid_by_static && BigInt(s.reward_stroops) > 0n && s !== steps[steps.length - 1])) reasons.push("double_reward")
  const total = steps.reduce((sum, s) => sum + BigInt(s.reward_stroops), 0n)
  const farmable = steps.filter((s) => s.farmable).reduce((sum, s) => sum + BigInt(s.reward_stroops), 0n)
  if (total > 0n && farmable * 10_000n > total * BigInt(Math.round(ARC_LIMITS.FARMABLE_MAX_SHARE * 10_000))) reasons.push("farmable_share")
  return reasons.length ? { ok: false, reasons } : { ok: true }
}

export function validateArcNarrative(
  raw: unknown,
  indices: readonly number[],
  allowedNumbers: readonly number[],
): { title: string; texts: Map<number, string> } | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as { title?: unknown; steps?: unknown }
  if (typeof r.title !== "string" || !r.title.trim() || r.title.length > 60 || !Array.isArray(r.steps)) return null
  const allowed = new Set(allowedNumbers.map(String))
  const numbersOk = (t: string) => [...t.matchAll(/\d+/g)].every((m) => allowed.has(m[0]))
  if (!numbersOk(r.title)) return null
  const texts = new Map<number, string>()
  for (const step of r.steps as Array<{ index?: unknown; text?: unknown }>) {
    const idx = Number(step?.index)
    const text = typeof step?.text === "string" ? step.text.trim() : ""
    if (!indices.includes(idx) || !text || text.length > 160 || !numbersOk(text)) return null
    texts.set(idx, text)
  }
  return texts.size === indices.length ? { title: r.title.trim(), texts } : null
}

// ── persistence ─────────────────────────────────────────────────────────────

type ArcRow = Omit<QuestArc, "steps" | "diagnosis" | "lang" | "status" | "text_source"> & {
  steps_json: string
  diagnosis_json: string
  lang: string
  status: string
  text_source: string
}

function rowToArc(row: ArcRow): QuestArc {
  const { steps_json, diagnosis_json, ...rest } = row
  return {
    ...rest,
    lang: row.lang === "es" ? "es" : "en",
    status: row.status as ArcStatus,
    text_source: row.text_source === "model" ? "model" : "fallback",
    steps: JSON.parse(steps_json) as ArcStep[],
    diagnosis: JSON.parse(diagnosis_json) as WalletDiagnosis,
  }
}

export function getArc(id: string): QuestArc | null {
  const row = getDb().prepare("SELECT * FROM quest_arcs WHERE id = ?").get(id) as ArcRow | undefined
  return row ? rowToArc(row) : null
}

export function getActiveArc(wallet: string, now: number = Date.now()): QuestArc | null {
  const row = getDb()
    .prepare("SELECT * FROM quest_arcs WHERE wallet = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(wallet.toUpperCase()) as ArcRow | undefined
  if (!row) return null
  const arc = rowToArc(row)
  return arc.expires_at > now ? arc : expireArc(arc, now)
}

export function listArcs(wallet: string, limit = 10): QuestArc[] {
  const rows = getDb()
    .prepare("SELECT * FROM quest_arcs WHERE wallet = ? ORDER BY created_at DESC LIMIT ?")
    .all(wallet.toUpperCase(), Math.min(50, Math.max(1, limit))) as ArcRow[]
  return rows.map(rowToArc)
}

/** Version-guarded rewrite of status + steps. Returns the new arc, or null on conflict. */
function writeArc(arc: QuestArc, patch: { status?: ArcStatus; steps?: ArcStep[]; superseded_by?: string | null }, now: number): QuestArc | null {
  const result = getDb()
    .prepare(
      `UPDATE quest_arcs SET status = ?, steps_json = ?, superseded_by = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`,
    )
    .run(
      patch.status ?? arc.status,
      JSON.stringify(patch.steps ?? arc.steps),
      patch.superseded_by === undefined ? arc.superseded_by : patch.superseded_by,
      now,
      arc.id,
      arc.version,
    )
  if (Number(result.changes) !== 1) {
    incSecurityCounter("ai_store_version_conflicts")
    return null
  }
  return getArc(arc.id)
}

/** Lazy expiry: an active arc read past its deadline is written as expired. Earned steps stay claimable. */
function expireArc(arc: QuestArc, now: number): QuestArc {
  return writeArc(arc, { status: "expired" }, now) ?? getArc(arc.id)!
}

function arcsInWindow(wallet: string, now: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM quest_arcs WHERE wallet = ? AND created_at >= ?")
    .get(wallet.toUpperCase(), now - ARC_LIMITS.RATE_WINDOW_MS) as { n: number }
  return Number(row.n)
}

// ── orchestration ───────────────────────────────────────────────────────────

export type ArcDeps = {
  /** True when the condition currently holds for the wallet. */
  isSatisfied: (wallet: string, condition: QuestCondition) => Promise<boolean>
  mintedCollections: (wallet: string) => Promise<number>
  streak: (wallet: string) => Promise<number>
  ageBand: (wallet: string) => Promise<WalletDiagnosis["ageBand"]>
  identityBlocked: (wallet: string) => Promise<boolean>
  staticConditionKeys: () => Promise<Set<string>>
  treasury: () => Promise<TreasuryView>
  generate?: AiJsonGenerator
  now?: number
}

async function satisfiedKinds(wallet: string, deps: ArcDeps, targets: Map<StepKind, number | null>): Promise<Set<StepKind>> {
  const out = new Set<StepKind>()
  for (const [kind, target] of targets) {
    if (await deps.isSatisfied(wallet, STEP_CATALOG[kind].condition(target))) out.add(kind)
  }
  return out
}

export async function diagnoseWallet(wallet: string, deps: ArcDeps): Promise<WalletDiagnosis> {
  const simple: StepKind[] = ["create_collection", "mint_nft", "settle", "create_world", "post_signal"]
  const [satisfied, mintedCollections, streak, ageBand] = await Promise.all([
    satisfiedKinds(wallet, deps, new Map(simple.map((k) => [k, null]))),
    deps.mintedCollections(wallet),
    deps.streak(wallet),
    deps.ageBand(wallet),
  ])
  return { ageBand, satisfied: [...satisfied].sort(), mintedCollections, streak }
}

export async function generateArc(
  input: { wallet: string; lang: "en" | "es"; replace?: boolean },
  deps: ArcDeps,
): Promise<QuestArc> {
  const now = deps.now ?? Date.now()
  const wallet = input.wallet.toUpperCase()

  if (await deps.identityBlocked(wallet)) {
    incSecurityCounter("quest_arcs_rejected_identity")
    throw new QuestArcError("IDENTITY_BLOCKED", "wallet is not eligible")
  }
  const active = getActiveArc(wallet, now)
  if (active && !input.replace) throw new QuestArcError("ALREADY_ACTIVE", "an arc is already active", { arc_id: active.id })
  // Replacing must not discard earned rewards: claim (or let settle) first.
  if (active?.steps.some((s) => s.state === "claiming" || (s.state === "done" && BigInt(s.reward_stroops) > 0n))) {
    throw new QuestArcError("ALREADY_ACTIVE", "claim earned step rewards before replacing this arc", { arc_id: active.id })
  }
  if (arcsInWindow(wallet, now) >= ARC_LIMITS.MAX_ARCS_PER_WINDOW) throw new QuestArcError("RATE_LIMITED", "too many arcs in window")

  const diagnosis = await diagnoseWallet(wallet, deps)
  const planned = planArcSteps(diagnosis)
  if (planned.length < ARC_LIMITS.MIN_STEPS) throw new QuestArcError("NO_ELIGIBLE_STEPS", "not enough unsatisfied steps")

  const sizes = sizeArcRewards(planned, await deps.staticConditionKeys(), await deps.treasury())
  const copy = pickCopy(input.lang).questArcs
  const fallbackText = (s: PlannedStep) =>
    s.kinds.map((k) => fillCopy(copy.stepFallback[k], { target: s.target ?? "" })).join(" / ")

  const steps: ArcStep[] = planned.map((s, i) => ({
    index: i,
    kinds: s.kinds,
    target: s.target,
    difficulty: s.difficulty,
    onchain: s.onchain,
    farmable: s.farmable,
    reward_stroops: sizes[i]!.reward.toString(),
    paid_by_static: sizes[i]!.paidByStatic,
    state: i === 0 ? "open" : "locked",
    text: fallbackText(s),
    done_at: null,
    claim_started_at: null,
    claim_hold_id: null,
    claimed_at: null,
    tx_hash: null,
  }))

  const review = reviewArc(steps)
  if (!review.ok) {
    incSecurityCounter("quest_arcs_rejected_farmable")
    throw new QuestArcError("FARMABLE", "generated arc failed the farmability review", { reasons: review.reasons })
  }

  let title = copy.titleFallback
  let textSource: QuestArc["text_source"] = "fallback"
  let modelId: string | null = null
  const id = randomUUID()
  const prompt = buildQuestArcPrompt({
    lang: input.lang,
    steps: steps.map((s) => ({ index: s.index, kind: s.kinds.join("|"), target: s.target })),
  })
  try {
    const reply = await (deps.generate ?? generateJsonStep)({ prompt })
    chargeAiStep(`quest_arc:${id}`, "quest_arc.narrative", prompt.length, reply.outputChars)
    const checked = validateArcNarrative(
      reply.json,
      steps.map((s) => s.index),
      steps.map((s) => s.target).filter((t): t is number => t !== null),
    )
    if (checked) {
      title = checked.title
      for (const step of steps) step.text = checked.texts.get(step.index)!
      textSource = "model"
      modelId = reply.modelId
    }
  } catch {
    // Fallback copy is already set.
  }

  const total = steps.reduce((sum, s) => sum + BigInt(s.reward_stroops), 0n)
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const live = db
      .prepare("SELECT id, version FROM quest_arcs WHERE wallet = ? AND status = 'active'")
      .all(wallet) as Array<{ id: string; version: number }>
    if (live.length > 0 && !input.replace) {
      db.exec("ROLLBACK")
      throw new QuestArcError("ALREADY_ACTIVE", "an arc is already active", { arc_id: live[0]!.id })
    }
    for (const prior of live) {
      db.prepare(
        "UPDATE quest_arcs SET status = 'superseded', superseded_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
      ).run(id, now, prior.id, prior.version)
      incSecurityCounter("quest_arcs_superseded")
    }
    db.prepare(
      `INSERT INTO quest_arcs
         (id, wallet, status, version, lang, title, steps_json, total_reward_stroops, diagnosis_json,
          model_id, text_source, created_at, updated_at, expires_at, superseded_by)
       VALUES (?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, wallet, input.lang, title, JSON.stringify(steps), total.toString(), JSON.stringify(diagnosis), modelId, textSource, now, now, now + ARC_LIMITS.TTL_MS)
    db.exec("COMMIT")
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // already rolled back
    }
    throw error
  }
  incSecurityCounter("quest_arcs_generated")
  return getArc(id)!
}

/**
 * Re-evaluate an arc against current history. Steps done out of order are
 * marked done (credit is earned, but claims stay ordered); zero-reward story
 * steps auto-claim; the first unfinished step opens. Returns the arc and
 * whether this refresh completed it.
 */
export async function refreshArc(
  arcId: string,
  deps: Pick<ArcDeps, "isSatisfied" | "now">,
): Promise<{ arc: QuestArc; completedNow: boolean }> {
  const now = deps.now ?? Date.now()
  let arc = getArc(arcId)
  if (!arc) throw new QuestArcError("NOT_FOUND", "arc not found")
  if (arc.status === "active" && arc.expires_at <= now) arc = expireArc(arc, now)

  const steps = arc.steps.map((s) => ({ ...s }))
  if (arc.status === "active") {
    for (const step of steps) {
      if (step.state !== "locked" && step.state !== "open") continue
      let met = false
      for (const kind of step.kinds) {
        if (await deps.isSatisfied(arc.wallet, STEP_CATALOG[kind].condition(step.target))) {
          met = true
          break
        }
      }
      if (met) {
        step.state = "done"
        step.done_at = now
      }
    }
  }
  for (const step of steps) {
    if (step.state === "done" && BigInt(step.reward_stroops) === 0n) {
      step.state = "claimed"
      step.claimed_at = now
    }
  }
  const firstOpen = steps.find((s) => s.state === "locked" || s.state === "open")
  for (const step of steps) if (step.state === "open" && step !== firstOpen) step.state = "locked"
  if (firstOpen && arc.status === "active") firstOpen.state = "open"

  const allClaimed = steps.every((s) => s.state === "claimed")
  const completedNow = arc.status === "active" && allClaimed
  const changed = JSON.stringify(steps) !== JSON.stringify(arc.steps) || completedNow
  if (!changed) return { arc, completedNow: false }
  const written = writeArc(arc, { steps, status: completedNow ? "completed" : arc.status }, now)
  if (!written) throw new QuestArcError("VERSION_CONFLICT", "arc changed during refresh")
  return { arc: written, completedNow }
}

/** Steps before `index` must all be claimed; the step itself must be done (or a stale claim). */
export function stepClaimable(arc: QuestArc, index: number, now: number = Date.now()): boolean {
  const step = arc.steps[index]
  if (!step || arc.status === "superseded") return false
  if (!arc.steps.slice(0, index).every((s) => s.state === "claimed")) return false
  if (BigInt(step.reward_stroops) === 0n) return false
  if (step.state === "done") return true
  return step.state === "claiming" && step.claim_started_at !== null && now - step.claim_started_at > ARC_LIMITS.CLAIM_TTL_MS
}

/** Phase one of a claim: done → claiming. Returns the amount and any stale hold to release. */
export function beginStepClaim(
  arcId: string,
  index: number,
  holdId: string | null,
  now: number = Date.now(),
): { arc: QuestArc; amountStroops: string; staleHoldId: string | null } {
  const arc = getArc(arcId)
  if (!arc) throw new QuestArcError("NOT_FOUND", "arc not found")
  if (!stepClaimable(arc, index, now)) throw new QuestArcError("STEP_NOT_CLAIMABLE", "step is not claimable")
  const steps = arc.steps.map((s) => ({ ...s }))
  const staleHoldId = steps[index]!.state === "claiming" ? steps[index]!.claim_hold_id : null
  steps[index] = { ...steps[index]!, state: "claiming", claim_started_at: now, claim_hold_id: holdId }
  const written = writeArc(arc, { steps }, now)
  if (!written) throw new QuestArcError("VERSION_CONFLICT", "arc changed")
  return { arc: written, amountStroops: steps[index]!.reward_stroops, staleHoldId }
}

/** Phase two: claiming → claimed. Idempotent for the same tx. Completes the arc on the last step. */
export function completeStepClaim(
  arcId: string,
  index: number,
  txHash: string,
  now: number = Date.now(),
): { arc: QuestArc; completedNow: boolean; holdId: string | null } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const arc = getArc(arcId)
    if (!arc) throw new QuestArcError("NOT_FOUND", "arc not found")
    const step = arc.steps[index]
    if (!step) throw new QuestArcError("STEP_NOT_CLAIMABLE", "no such step")
    if (step.state === "claimed") return { arc, completedNow: false, holdId: null }
    if (step.state !== "claiming") throw new QuestArcError("STEP_NOT_CLAIMABLE", "step is not being claimed")
    const steps = arc.steps.map((s) => ({ ...s }))
    steps[index] = { ...step, state: "claimed", claimed_at: now, tx_hash: txHash }
    const completedNow = steps.every((s) => s.state === "claimed") && arc.status === "active"
    const written = writeArc(arc, { steps, status: completedNow ? "completed" : arc.status }, now)
    if (written) {
      incSecurityCounter("quest_arc_steps_claimed")
      return { arc: written, completedNow, holdId: step.claim_hold_id }
    }
  }
  throw new QuestArcError("VERSION_CONFLICT", "arc kept changing")
}

/** Failure path: claiming → done, returning the hold to release. */
export function abortStepClaim(arcId: string, index: number, now: number = Date.now()): string | null {
  for (let attempt = 0; attempt < 8; attempt++) {
    const arc = getArc(arcId)
    const step = arc?.steps[index]
    if (!arc || !step || step.state !== "claiming") return null
    const steps = arc.steps.map((s) => ({ ...s }))
    steps[index] = { ...step, state: "done", claim_started_at: null, claim_hold_id: null }
    if (writeArc(arc, { steps }, now)) return step.claim_hold_id
  }
  return null
}

/** Faucet reward id for a step: `arc:<uuid>:<index>` (lowercase, survives parseRewardType). */
export function arcRewardId(arcId: string, index: number): string {
  return `arc:${arcId.toLowerCase()}:${index}`
}

export function parseArcRewardId(reward: string): { arcId: string; index: number } | null {
  const m = /^arc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-4])$/.exec(reward)
  return m ? { arcId: m[1]!, index: Number(m[2]) } : null
}

/** Operator revoke: an active arc stops progressing; claimed steps are history. */
export function revokeArc(arcId: string, now: number = Date.now()): QuestArc {
  const arc = getArc(arcId)
  if (!arc) throw new QuestArcError("NOT_FOUND", "arc not found")
  if (arc.status !== "active") return arc
  const written = writeArc(arc, { status: "superseded", superseded_by: null }, now)
  if (!written) throw new QuestArcError("VERSION_CONFLICT", "arc changed")
  incSecurityCounter("quest_arcs_superseded")
  return written
}

/**
 * Production wiring. The evaluation context (five RPC reads) is built once per
 * deps instance and shared by every condition, and Horizon history is read at
 * most once for both the age band and the sybil gate.
 */
export function defaultArcDeps(): ArcDeps {
  const ctxByWallet = new Map<string, Promise<Awaited<ReturnType<typeof import("@/lib/quest-registry").buildEvaluationContext>>>>()
  const historyByWallet = new Map<string, Promise<import("@/lib/sybil-resistance").SybilScoreInput | null>>()

  const ctxFor = async (wallet: string) => {
    if (!ctxByWallet.has(wallet)) {
      const { buildEvaluationContext } = await import("@/lib/quest-registry")
      ctxByWallet.set(wallet, buildEvaluationContext(wallet))
    }
    return ctxByWallet.get(wallet)!
  }
  const historyFor = async (wallet: string) => {
    const { fetchAccountHistoryFeatures, isSybilResistanceEnabled } = await import("@/lib/sybil-resistance")
    if (!isSybilResistanceEnabled()) return null
    if (!historyByWallet.has(wallet)) historyByWallet.set(wallet, fetchAccountHistoryFeatures(wallet).catch(() => null))
    return historyByWallet.get(wallet)!
  }

  return {
    isSatisfied: async (wallet, condition) => {
      const { evaluateQuestCondition } = await import("@/lib/quest-registry")
      return (await evaluateQuestCondition(condition, wallet, await ctxFor(wallet))).completed
    },
    mintedCollections: async (wallet) => {
      const { evaluateQuestCondition } = await import("@/lib/quest-registry")
      const r = await evaluateQuestCondition({ type: "collection_count", params: { minCount: 5 } }, wallet, await ctxFor(wallet))
      return Math.min(5, Math.round((r.progressPct / 100) * 5))
    },
    streak: async (wallet) => {
      const { getStreakInfo } = await import("@/lib/quest-streak")
      return (await getStreakInfo(wallet)).currentStreak
    },
    ageBand: async (wallet) => {
      const features = await historyFor(wallet)
      if (!features) return "unknown"
      return features.accountAgeDays < 30 ? "new" : "established"
    },
    identityBlocked: async (wallet) => {
      const { isWalletDenied } = await import("@/lib/faucet-deny-list")
      if (await isWalletDenied(wallet)) return true
      const features = await historyFor(wallet)
      if (!features) return false
      const { scoreWalletHistory } = await import("@/lib/sybil-resistance")
      try {
        return scoreWalletHistory(features).suspect
      } catch {
        return false
      }
    },
    staticConditionKeys: async () => {
      const { staticQuestConditionKeys } = await import("@/lib/quest-registry")
      return staticQuestConditionKeys()
    },
    treasury: async () => {
      const { getDistributorHealthStatus } = await import("@/lib/distributor-health-store")
      const health = await getDistributorHealthStatus().catch(() => null)
      const healthy = !health || (health.status !== "critical" && health.status !== "error")
      const secret = process.env.FAUCET_DISTRIBUTOR_SECRET_KEY?.trim()
      if (!secret) return { availableStroops: null, healthy }
      try {
        const { Keypair } = await import("@stellar/stellar-sdk")
        const { availableBalance, readLedger } = await import("@/lib/distributor-ledger")
        const distributor = Keypair.fromSecret(secret).publicKey()
        return { availableStroops: readLedger(distributor) ? availableBalance(distributor) : null, healthy }
      } catch {
        return { availableStroops: null, healthy }
      }
    },
  }
}
