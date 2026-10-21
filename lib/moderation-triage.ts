/**
 * AI moderation pre-screen with confidence triage and human override — phase-146
 *
 * Every new signal, reply, and committed edit is screened. The decision is one
 * of three, per category thresholds:
 *
 *   auto_allow    visible, no human needed
 *   human_review  queued for a moderator; visible unless the driving category
 *                 is fail-closed (csam), in which case hidden while queued
 *   auto_hold     hidden at once, queued for a moderator with a short SLA
 *
 * Hot path: the create route only runs the local pre-screen (regexes and one
 * indexed duplicate lookup) and an INSERT OR IGNORE; the model call happens
 * after the response, in `drainModerationQueue`, under a version-guarded lease.
 * A lost fire-and-forget (serverless freeze) is recovered by the next drain,
 * because the row stays `pending_score` until a leased scorer writes it.
 *
 * Invariants:
 * - The signal row is never written by the AI. Visibility is a column here, so
 *   unsetting the flag leaves every signal as its author wrote it. (A human
 *   takedown additionally goes through takedownSignal, so human decisions
 *   survive a rollback of this flag.)
 * - A hold is sticky across edits: a new revision of hidden content starts
 *   hidden, or editing one character would launder a held post.
 * - Model scores cannot clear a local prompt-injection hit; content that tries
 *   to instruct the classifier is at least human_review whatever the model says.
 * - If the classifier fails, the fail policy decides: a fail-closed category
 *   (csam) holds anything it cannot screen locally (media); otherwise the item
 *   goes to human review, visible.
 * - Every AI decision is recorded with model id, prompt hash and full score
 *   vector; overrides record agree/disagree, which is the precision signal.
 *
 * Feature flag: phase-146. Rollback: unset → no screening, no hiding; rows inert.
 */

import { createHash, randomUUID } from "node:crypto"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getDb } from "@/lib/sqlite-db"
import { incSecurityCounter } from "@/lib/security-counters"
import { chargeAiStep } from "@/lib/cost-attribution-ledger"
import { buildModerationPrompt } from "@/lib/forge/prompt-builder"
import { aiPromptHash, generateJsonStep, type AiJsonGenerator } from "@/lib/forge/ai-pipeline"
import { createNotification } from "@/lib/notification-store"

export function isModerationTriageEnabled(): boolean {
  return isFeatureEnabled("phase-146")
}

export const MODERATION_CATEGORIES = [
  "csam",
  "sexual",
  "hate",
  "harassment",
  "violence",
  "spam",
  "prompt_injection",
] as const
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number]
export type ModerationScores = Record<ModerationCategory, number>
export type TriageDecision = "auto_allow" | "human_review" | "auto_hold"
export type QueueState = "pending_score" | "auto_allowed" | "needs_review" | "resolved"
export type TargetKind = "signal" | "reply"

export type CategoryPolicy = { reviewAt: number; holdAt: number; failMode: "open" | "closed" }
export type ModerationPolicy = Record<ModerationCategory, CategoryPolicy>

/**
 * Defaults. Thresholds are on calibrated scores; tune them with
 * `evaluatePolicy` against a labelled set before changing a number here.
 * prompt_injection never auto-holds (holdAt > 1): an injection attempt is a
 * reason to look, not proof of a violation.
 */
export const DEFAULT_POLICY: ModerationPolicy = {
  csam: { reviewAt: 0.05, holdAt: 0.2, failMode: "closed" },
  sexual: { reviewAt: 0.5, holdAt: 0.85, failMode: "open" },
  hate: { reviewAt: 0.4, holdAt: 0.8, failMode: "open" },
  harassment: { reviewAt: 0.5, holdAt: 0.85, failMode: "open" },
  violence: { reviewAt: 0.5, holdAt: 0.9, failMode: "open" },
  spam: { reviewAt: 0.6, holdAt: 0.95, failMode: "open" },
  prompt_injection: { reviewAt: 0.5, holdAt: 1.01, failMode: "open" },
}

/** Piecewise-linear map raw → calibrated per category; identity by default. */
export type Calibration = Partial<Record<ModerationCategory, Array<[number, number]>>>

export const SLA_MS = { auto_hold: 60 * 60_000, human_review: 24 * 60 * 60_000, appeal: 24 * 60 * 60_000 } as const
const SCORE_LEASE_MS = 60_000
const ASSIGN_LEASE_MS = 15 * 60_000
const MAX_SCORE_ATTEMPTS = 3

export function zeroScores(): ModerationScores {
  return Object.fromEntries(MODERATION_CATEGORIES.map((c) => [c, 0])) as ModerationScores
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

export function calibrate(category: ModerationCategory, raw: number, calibration: Calibration = {}): number {
  const table = calibration[category]
  if (!table || table.length === 0) return clamp01(raw)
  const pts = [...table].sort((a, b) => a[0] - b[0])
  if (raw <= pts[0]![0]) return clamp01(pts[0]![1])
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]!
    const [x0, y0] = pts[i - 1]!
    if (raw <= x1) return clamp01(y0 + ((raw - x0) / (x1 - x0 || 1)) * (y1 - y0))
  }
  return clamp01(pts[pts.length - 1]![1])
}

// ── local pre-screen (synchronous, free) ────────────────────────────────────

const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)\b/i,
  /\bdisregard\s+(all\s+|any\s+)?(previous|prior|your)?\s*(instructions|rules)\b/i,
  /\b(system|developer)\s+prompt\b/i,
  /\byou\s+are\s+now\s+(a|an|the)\b/i,
  /\b(rate|score|classify)\s+this\s+(as\s+)?(0|zero|safe|clean)\b/i,
  /\bignora\s+(todas\s+)?(las\s+)?instrucciones\b/i,
  /\bolvida\s+(todas\s+)?(las\s+)?instrucciones\b/i,
  /\bahora\s+eres\s+(un|una|el|la)\b/i,
  /\bclasifica\s+(esto|este)\s+como\s+(seguro|0|cero)\b/i,
]

export function localPreScreen(input: { title: string; body: string; recentDuplicates: number }): Partial<ModerationScores> {
  const text = `${input.title}\n${input.body}`
  const scores: Partial<ModerationScores> = {}

  let spam = 0
  const urls = text.match(/https?:\/\/\S+/gi)?.length ?? 0
  if (urls >= 3) spam = Math.max(spam, 0.7)
  if (/(.)\1{11,}/.test(text)) spam = Math.min(1, spam + 0.3)
  const letters = text.replace(/[^a-záéíóúñ]/gi, "")
  if (letters.length > 40 && letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, "").length / letters.length > 0.7) spam = Math.min(1, spam + 0.2)
  if (input.recentDuplicates >= 3) spam = Math.max(spam, 0.9)
  if (spam > 0) scores.spam = spam

  if (INJECTION_PATTERNS.some((re) => re.test(text))) scores.prompt_injection = 0.9
  return scores
}

// ── pure decision ───────────────────────────────────────────────────────────

export type TriageOutcome = {
  decision: TriageDecision
  /** 0..1 distance from the nearest threshold that would change the decision. */
  confidence: number
  driver: ModerationCategory | null
  scores: ModerationScores
  hidden: boolean
}

export function decideTriage(input: {
  modelScores: Partial<ModerationScores> | null
  localScores: Partial<ModerationScores>
  hasMedia: boolean
  providerBlocked?: boolean
  policy?: ModerationPolicy
  calibration?: Calibration
}): TriageOutcome {
  const policy = input.policy ?? DEFAULT_POLICY
  const scores = zeroScores()
  for (const c of MODERATION_CATEGORIES) {
    const model = input.modelScores?.[c]
    scores[c] = Math.max(model === undefined ? 0 : calibrate(c, model, input.calibration), input.localScores[c] ?? 0)
  }

  if (input.providerBlocked) {
    // The provider refused to read it. That is strong evidence, not a verdict.
    return { decision: "auto_hold", confidence: 0, driver: null, scores, hidden: true }
  }

  if (input.modelScores === null) {
    const closedLocalHit = MODERATION_CATEGORIES.some(
      (c) => policy[c].failMode === "closed" && (input.localScores[c] ?? 0) >= policy[c].reviewAt,
    )
    const closedUnscreenable = input.hasMedia && MODERATION_CATEGORIES.some((c) => policy[c].failMode === "closed")
    if (closedLocalHit || closedUnscreenable) {
      return { decision: "auto_hold", confidence: 0, driver: null, scores, hidden: true }
    }
    return { decision: "human_review", confidence: 0, driver: null, scores, hidden: false }
  }

  let driver: ModerationCategory | null = null
  let worst = 0
  for (const c of MODERATION_CATEGORIES) {
    const ratio = scores[c] / policy[c].reviewAt
    if (ratio > worst) {
      worst = ratio
      driver = c
    }
  }

  const held = MODERATION_CATEGORIES.filter((c) => scores[c] >= policy[c].holdAt)
  const reviewed = MODERATION_CATEGORIES.filter((c) => scores[c] >= policy[c].reviewAt)
  const injectionFloor = (input.localScores.prompt_injection ?? 0) >= policy.prompt_injection.reviewAt

  let decision: TriageDecision
  let confidence: number
  if (held.length > 0) {
    decision = "auto_hold"
    driver = held.sort((a, b) => scores[b] / policy[b].holdAt - scores[a] / policy[a].holdAt)[0]!
    const p = policy[driver]
    confidence = clamp01((scores[driver] - p.holdAt) / Math.max(1e-6, 1 - p.holdAt))
  } else if (reviewed.length > 0 || injectionFloor) {
    decision = "human_review"
    if (reviewed.length === 0) driver = "prompt_injection"
    const p = policy[driver!]
    confidence = clamp01(Math.min(scores[driver!] - p.reviewAt, p.holdAt - scores[driver!]) / Math.max(1e-6, p.holdAt - p.reviewAt))
  } else {
    decision = "auto_allow"
    confidence = clamp01(1 - worst)
    driver = worst > 0 ? driver : null
  }

  const hidden = decision === "auto_hold" || (decision === "human_review" && driver !== null && policy[driver].failMode === "closed")
  return { decision, confidence: Number(confidence.toFixed(4)), driver, scores, hidden }
}

/** Parse the model's reply; anything missing or out of range is a failure, not a zero. */
export function parseModelScores(raw: unknown): Partial<ModerationScores> | null {
  if (!raw || typeof raw !== "object") return null
  const s = (raw as { scores?: unknown }).scores
  if (!s || typeof s !== "object") return null
  const out: Partial<ModerationScores> = {}
  for (const c of MODERATION_CATEGORIES) {
    const v = (s as Record<string, unknown>)[c]
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return null
    out[c] = v
  }
  return out
}

// ── eval harness ────────────────────────────────────────────────────────────

export type LabelledSample = { scores: Partial<ModerationScores>; violates: ModerationCategory | null }

export type CategoryEval = { category: ModerationCategory; precision: number | null; recall: number | null; tp: number; fp: number; fn: number }

/**
 * Precision/recall of "flagged" (review or hold) per category over a labelled
 * set. This is what threshold changes are judged against, per language: run it
 * once on the EN slice and once on the ES slice, and a change that helps one
 * while hurting the other does not ship.
 */
export function evaluatePolicy(samples: readonly LabelledSample[], policy: ModerationPolicy = DEFAULT_POLICY, calibration: Calibration = {}): CategoryEval[] {
  return MODERATION_CATEGORIES.map((category) => {
    let tp = 0
    let fp = 0
    let fn = 0
    for (const sample of samples) {
      const flagged = calibrate(category, sample.scores[category] ?? 0, calibration) >= policy[category].reviewAt
      const positive = sample.violates === category
      if (flagged && positive) tp++
      else if (flagged && !positive) fp++
      else if (!flagged && positive) fn++
    }
    return {
      category,
      tp,
      fp,
      fn,
      precision: tp + fp > 0 ? tp / (tp + fp) : null,
      recall: tp + fn > 0 ? tp / (tp + fn) : null,
    }
  })
}

// ── queue persistence ───────────────────────────────────────────────────────

export type QueueItem = {
  id: string
  target_kind: TargetKind
  target_id: string
  author_wallet: string
  text_hash: string
  has_media: boolean
  state: QueueState
  decision: TriageDecision | null
  visibility: "visible" | "hidden"
  confidence: number | null
  scores: ModerationScores | null
  model_id: string | null
  prompt_hash: string | null
  attempts: number
  lease_until: number | null
  assigned_to: string | null
  due_at: number | null
  appeal_reason: string | null
  appealed_at: number | null
  resolution: "allow" | "takedown" | null
  resolved_by: string | null
  resolved_at: number | null
  version: number
  created_at: number
  updated_at: number
}

type QueueRow = Omit<QueueItem, "has_media" | "scores"> & { has_media: number; scores_json: string | null }

function rowToItem(row: QueueRow): QueueItem {
  const { scores_json, ...rest } = row
  return { ...rest, has_media: row.has_media === 1, scores: scores_json ? (JSON.parse(scores_json) as ModerationScores) : null }
}

export function textHash(title: string, body: string): string {
  return createHash("sha256").update(`${title}\u0000${body}`, "utf8").digest("hex").slice(0, 32)
}

export function getQueueItem(id: string): QueueItem | null {
  const row = getDb().prepare("SELECT * FROM moderation_queue WHERE id = ?").get(id) as QueueRow | undefined
  return row ? rowToItem(row) : null
}

/** The latest screened revision of a target — the one that governs visibility. */
export function getLatestForTarget(kind: TargetKind, targetId: string): QueueItem | null {
  const row = getDb()
    .prepare("SELECT * FROM moderation_queue WHERE target_kind = ? AND target_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(kind, targetId) as QueueRow | undefined
  return row ? rowToItem(row) : null
}

/** SQL fragment for list queries: hide targets whose latest revision is hidden. */
export function hiddenTargetFilterSql(kind: TargetKind, idColumn: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM moderation_queue q
     WHERE q.target_kind = '${kind}' AND q.target_id = ${idColumn} AND q.visibility = 'hidden'
       AND q.rowid = (SELECT q2.rowid FROM moderation_queue q2
                       WHERE q2.target_kind = '${kind}' AND q2.target_id = ${idColumn}
                       ORDER BY q2.created_at DESC, q2.rowid DESC LIMIT 1))`
}

/** True when an earlier revision of the same target is hidden and no human allowed it. */
function previousRevisionHidden(item: QueueItem): boolean {
  const prev = getDb()
    .prepare(
      `SELECT visibility, resolution FROM moderation_queue
        WHERE target_kind = ? AND target_id = ? AND id != ? AND created_at <= ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(item.target_kind, item.target_id, item.id, item.created_at) as { visibility: string; resolution: string | null } | undefined
  return !!prev && prev.visibility === "hidden" && prev.resolution !== "allow"
}

function bumpVersion(id: string, expectedVersion: number, set: string, params: Array<string | number | null>, now: number): boolean {
  const result = getDb()
    .prepare(`UPDATE moderation_queue SET ${set}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
    .run(...params, now, id, expectedVersion)
  if (Number(result.changes) !== 1) {
    incSecurityCounter("ai_store_version_conflicts")
    return false
  }
  return true
}

/**
 * Hot-path enqueue. Idempotent per (target, revision text): a retried create
 * returns the existing row. Runs only the local pre-screen; if that alone
 * crosses a hold threshold the item is hidden immediately.
 */
export function enqueueForModeration(input: {
  targetKind: TargetKind
  targetId: string
  authorWallet: string
  title: string
  body: string
  hasMedia: boolean
  now?: number
  policy?: ModerationPolicy
}): QueueItem {
  const now = input.now ?? Date.now()
  const db = getDb()
  const hash = textHash(input.title, input.body)
  const author = input.authorWallet.toUpperCase()

  const duplicates = db
    .prepare(
      "SELECT COUNT(*) AS n FROM moderation_queue WHERE author_wallet = ? AND text_hash = ? AND created_at >= ? AND target_id != ?",
    )
    .get(author, hash, now - 24 * 60 * 60_000, input.targetId) as { n: number }
  const local = localPreScreen({ title: input.title, body: input.body, recentDuplicates: Number(duplicates.n) })
  const localOnly = decideTriage({ modelScores: zeroScores(), localScores: local, hasMedia: input.hasMedia, policy: input.policy })

  const previous = getLatestForTarget(input.targetKind, input.targetId)
  const stickyHidden = previous !== null && previous.visibility === "hidden" && previous.resolution !== "allow"
  const holdUnscored = process.env.PHASE_MODERATION_HOLD_UNSCORED === "1"
  const hidden = localOnly.decision === "auto_hold" || stickyHidden || holdUnscored

  db.prepare(
    `INSERT OR IGNORE INTO moderation_queue
       (id, target_kind, target_id, author_wallet, text_hash, has_media, state, decision,
        visibility, scores_json, attempts, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_score', NULL, ?, ?, 0, 1, ?, ?)`,
  ).run(
    randomUUID(),
    input.targetKind,
    input.targetId,
    author,
    hash,
    input.hasMedia ? 1 : 0,
    hidden ? "hidden" : "visible",
    JSON.stringify({ ...zeroScores(), ...local }),
    now,
    now,
  )
  if (local.prompt_injection) incSecurityCounter("moderation_injection_detected")
  const row = db
    .prepare("SELECT * FROM moderation_queue WHERE target_kind = ? AND target_id = ? AND text_hash = ?")
    .get(input.targetKind, input.targetId, hash) as QueueRow
  return rowToItem(row)
}

export type ScoreDeps = {
  loadText: (kind: TargetKind, targetId: string) => Promise<{ title: string; body: string } | null>
  generate?: AiJsonGenerator
  /** Optional extra spam evidence from on-chain history (sybil band). */
  authorRisk?: (wallet: string) => Promise<number>
  policy?: ModerationPolicy
  calibration?: Calibration
  now?: number
}

/**
 * Score one pending item. A version-guarded lease means two drains racing on
 * the same row cannot both call the model and both write a decision.
 */
export async function scoreQueueItem(id: string, deps: ScoreDeps): Promise<QueueItem | null> {
  const now = deps.now ?? Date.now()
  const item = getQueueItem(id)
  if (!item || item.state !== "pending_score") return item
  if (item.lease_until !== null && item.lease_until > now) return item
  if (!bumpVersion(id, item.version, "lease_until = ?, attempts = attempts + 1", [now + SCORE_LEASE_MS], now)) return getQueueItem(id)
  const leasedVersion = item.version + 1

  const text = await deps.loadText(item.target_kind, item.target_id)
  if (!text || textHash(text.title, text.body) !== item.text_hash) {
    // The target was deleted or edited since; the newer revision has its own row.
    bumpVersion(id, leasedVersion, "state = 'resolved', resolution = NULL, lease_until = NULL", [], now)
    return getQueueItem(id)
  }

  const local: Partial<ModerationScores> = {}
  for (const c of MODERATION_CATEGORIES) if (item.scores && item.scores[c] > 0) local[c] = item.scores[c]
  if (deps.authorRisk) {
    const risk = await deps.authorRisk(item.author_wallet).catch(() => 0)
    if (risk > 0) local.spam = Math.min(1, (local.spam ?? 0) + risk)
  }

  const prompt = buildModerationPrompt({ categories: MODERATION_CATEGORIES, title: text.title, body: text.body })
  let modelScores: Partial<ModerationScores> | null = null
  let providerBlocked = false
  let modelId: string | null = null
  try {
    const reply = await (deps.generate ?? generateJsonStep)({ prompt })
    chargeAiStep(`moderation:${id}`, "moderation.classify", prompt.length, reply.outputChars)
    modelId = reply.modelId
    if (reply.blockReason) providerBlocked = true
    else modelScores = parseModelScores(reply.json)
  } catch {
    modelScores = null
  }
  if (!providerBlocked && modelScores === null) {
    incSecurityCounter("moderation_classifier_failed")
    // Below the attempt budget, release the lease and let the next drain retry.
    if (item.attempts + 1 < MAX_SCORE_ATTEMPTS) {
      bumpVersion(id, leasedVersion, "lease_until = NULL", [], now)
      return getQueueItem(id)
    }
  }

  const outcome = decideTriage({
    modelScores,
    localScores: local,
    hasMedia: item.has_media,
    providerBlocked,
    policy: deps.policy,
    calibration: deps.calibration,
  })
  const sticky = outcome.decision !== "auto_hold" && previousRevisionHidden(item)
  const state: QueueState = outcome.decision === "auto_allow" && !sticky ? "auto_allowed" : "needs_review"
  const dueAt = state === "needs_review" ? now + (outcome.decision === "auto_hold" ? SLA_MS.auto_hold : SLA_MS.human_review) : null
  const wrote = bumpVersion(
    id,
    leasedVersion,
    `state = ?, decision = ?, visibility = ?, confidence = ?, scores_json = ?, model_id = ?, prompt_hash = ?, due_at = ?, lease_until = NULL`,
    [
      state,
      outcome.decision,
      outcome.hidden || sticky ? "hidden" : "visible",
      outcome.confidence,
      JSON.stringify(outcome.scores),
      modelId,
      aiPromptHash(prompt),
      dueAt,
    ],
    now,
  )
  if (wrote) {
    incSecurityCounter("moderation_scored")
    incSecurityCounter(`moderation_${outcome.decision}` as "moderation_auto_allow" | "moderation_human_review" | "moderation_auto_hold")
  }
  return getQueueItem(id)
}

/**
 * Score up to `limit` pending items, oldest first, with `score` (scoreQueueItem
 * or scoreAndNotify). Safe to call concurrently: each row is leased.
 */
export async function drainModerationQueue(
  limit: number,
  score: (id: string) => Promise<QueueItem | null>,
  now: number = Date.now(),
): Promise<QueueItem[]> {
  const ids = getDb()
    .prepare(
      `SELECT id FROM moderation_queue
        WHERE state = 'pending_score' AND (lease_until IS NULL OR lease_until <= ?)
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all(now, Math.min(50, Math.max(1, limit))) as Array<{ id: string }>
  const out: QueueItem[] = []
  for (const { id } of ids) {
    const item = await score(id)
    if (item) out.push(item)
  }
  return out
}

export function listReviewQueue(opts: { limit?: number; now?: number } = {}): Array<QueueItem & { sla_breached: boolean }> {
  const now = opts.now ?? Date.now()
  const rows = getDb()
    .prepare("SELECT * FROM moderation_queue WHERE state = 'needs_review' ORDER BY due_at ASC, created_at ASC LIMIT ?")
    .all(Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)))) as QueueRow[]
  return rows.map(rowToItem).map((item) => ({ ...item, sla_breached: item.due_at !== null && item.due_at < now }))
}

export class ModerationQueueError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "VERSION_CONFLICT" | "NOT_REVIEWABLE" | "ASSIGNED_ELSEWHERE" | "NOT_APPEALABLE" | "ALREADY_APPEALED",
    message: string,
  ) {
    super(message)
    this.name = "ModerationQueueError"
  }
}

function requireVersion(id: string, expectedVersion: number): QueueItem {
  const item = getQueueItem(id)
  if (!item) throw new ModerationQueueError("NOT_FOUND", "queue item not found")
  if (item.version !== expectedVersion) {
    incSecurityCounter("ai_store_version_conflicts")
    throw new ModerationQueueError("VERSION_CONFLICT", "queue item changed")
  }
  return item
}

/** Assign to a moderator for ASSIGN_LEASE_MS so two moderators do not work the same item. */
export function claimQueueItem(id: string, expectedVersion: number, moderatorWallet: string, now: number = Date.now()): QueueItem {
  const item = requireVersion(id, expectedVersion)
  if (item.state !== "needs_review") throw new ModerationQueueError("NOT_REVIEWABLE", "item is not awaiting review")
  if (item.assigned_to && item.assigned_to !== moderatorWallet && (item.lease_until ?? 0) > now) {
    throw new ModerationQueueError("ASSIGNED_ELSEWHERE", "assigned to another moderator")
  }
  if (!bumpVersion(id, expectedVersion, "assigned_to = ?, lease_until = ?", [moderatorWallet, now + ASSIGN_LEASE_MS], now)) {
    throw new ModerationQueueError("VERSION_CONFLICT", "queue item changed")
  }
  return getQueueItem(id)!
}

/**
 * Human decision. Records agreement with the AI decision so precision can be
 * measured: an AI hold the human allows, or an AI allow the human takes down,
 * is a disagreement.
 */
export function resolveQueueItem(input: {
  id: string
  expectedVersion: number
  action: "allow" | "takedown"
  moderatorWallet: string
  now?: number
}): { item: QueueItem; agreedWithAi: boolean | null } {
  const now = input.now ?? Date.now()
  const item = requireVersion(input.id, input.expectedVersion)
  // A resolved item may be re-resolved: a human can reverse a human decision
  // (e.g. restore after takedown). Only unscored items are off limits.
  if (item.state === "pending_score") {
    throw new ModerationQueueError("NOT_REVIEWABLE", "item has not been scored yet")
  }
  if (item.assigned_to && item.assigned_to !== input.moderatorWallet && (item.lease_until ?? 0) > now) {
    throw new ModerationQueueError("ASSIGNED_ELSEWHERE", "assigned to another moderator")
  }
  if (
    !bumpVersion(
      input.id,
      input.expectedVersion,
      "state = 'resolved', resolution = ?, visibility = ?, resolved_by = ?, resolved_at = ?, lease_until = NULL",
      [input.action, input.action === "allow" ? "visible" : "hidden", input.moderatorWallet, now],
      now,
    )
  ) {
    throw new ModerationQueueError("VERSION_CONFLICT", "queue item changed")
  }
  let agreedWithAi: boolean | null = null
  if (item.decision === "auto_hold") agreedWithAi = input.action === "takedown"
  else if (item.decision === "auto_allow") agreedWithAi = input.action === "allow"
  if (agreedWithAi !== null) incSecurityCounter(agreedWithAi ? "moderation_override_agree" : "moderation_override_disagree")
  return { item: getQueueItem(input.id)!, agreedWithAi }
}

/** One appeal per hidden item, by its author; reopens it for review. */
export function appealQueueItem(input: { id: string; authorWallet: string; reason: string; now?: number }): QueueItem {
  const now = input.now ?? Date.now()
  const item = getQueueItem(input.id)
  if (!item) throw new ModerationQueueError("NOT_FOUND", "queue item not found")
  if (item.author_wallet !== input.authorWallet.toUpperCase() || item.visibility !== "hidden") {
    throw new ModerationQueueError("NOT_APPEALABLE", "only the author of hidden content may appeal")
  }
  if (item.appealed_at !== null) throw new ModerationQueueError("ALREADY_APPEALED", "already appealed")
  if (
    !bumpVersion(
      input.id,
      item.version,
      "state = 'needs_review', appeal_reason = ?, appealed_at = ?, due_at = ?, resolution = NULL, assigned_to = NULL",
      [input.reason.slice(0, 500), now, now + SLA_MS.appeal],
      now,
    )
  ) {
    throw new ModerationQueueError("VERSION_CONFLICT", "queue item changed")
  }
  incSecurityCounter("moderation_appeals")
  return getQueueItem(input.id)!
}

// ── default wiring ──────────────────────────────────────────────────────────

/**
 * Production dependencies. Text is read straight from SQLite rather than via
 * signal-store, which imports this module for its list filter.
 */
export function defaultScoreDeps(): ScoreDeps {
  return {
    loadText: async (kind, targetId) => {
      if (kind === "signal") {
        const row = getDb().prepare("SELECT title, body FROM signals WHERE id = ?").get(targetId) as
          | { title: string; body: string }
          | undefined
        return row ?? null
      }
      const row = getDb().prepare("SELECT body FROM signal_replies WHERE id = ?").get(targetId) as { body: string } | undefined
      return row ? { title: "", body: row.body } : null
    },
    authorRisk: async (wallet) => {
      const { assessWalletSybilRisk, isSybilResistanceEnabled } = await import("@/lib/sybil-resistance")
      if (!isSybilResistanceEnabled()) return 0
      const score = await assessWalletSybilRisk(wallet)
      return score?.suspect ? 0.2 : 0
    },
  }
}

/** Score with production deps and tell the author when their content is hidden. */
export async function scoreAndNotify(id: string, deps: ScoreDeps = defaultScoreDeps()): Promise<QueueItem | null> {
  const before = getQueueItem(id)
  const item = await scoreQueueItem(id, deps)
  if (item && before?.state === "pending_score" && item.state === "needs_review" && item.visibility === "hidden") {
    void createNotification(item.author_wallet, "moderation_hold", { queue_id: item.id, target_kind: item.target_kind, target_id: item.target_id }).catch(
      () => {},
    )
  }
  return item
}

/**
 * Enqueue and kick off scoring without awaiting it. The drain route recovers
 * anything this loses to a frozen serverless instance.
 */
export function screenInBackground(input: Parameters<typeof enqueueForModeration>[0]): QueueItem | null {
  try {
    const item = enqueueForModeration(input)
    void scoreAndNotify(item.id).catch((error) => {
      console.warn("[phase-146] background scoring failed; left for drain:", error)
    })
    return item
  } catch (error) {
    // Screening must not fail the write it screens; the drain cannot recover an
    // item that was never enqueued, so this is logged loudly.
    console.error("[phase-146] enqueue failed:", error)
    incSecurityCounter("moderation_classifier_failed")
    return null
  }
}

/**
 * phase-168 / Spike 635: Export triage queue items for regulatory audit with author wallet redaction.
 */
export function exportTriageItemsForAudit(role: "moderator" | "regulator" = "moderator"): QueueItem[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM moderation_queue ORDER BY created_at ASC LIMIT 500").all() as unknown as QueueItem[];
  if (role === "regulator") {
    return rows.map((r) => ({
      ...r,
      author_wallet: `${r.author_wallet.slice(0, 4)}...${r.author_wallet.slice(-4)}`,
    }));
  }
  return rows;
}

