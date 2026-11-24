/**
 * Module #67 — Explore domain isolation.
 *
 * AUDIT NOTE (concurrent execution):
 * The prior api/explore route inline-logic ran parallel metadata fetches with a
 * fixed-concurrency worker pool but mixed concerns (schema, hashing, dedupe,
 * pagination) into a single server file. That made the "messages overwrite each
 * other" behaviour — concurrent fetch results racing on the client and stale
 * snapshots clobbering fresher ones — hard to reason about and to test.
 *
 * This module is the single source of truth for the pure explore domain:
 * type-safe schema validation, truncation, content-hash dedup, bounded
 * concurrency and pagination. It contains ZERO server/network imports so it can
 * be unit-tested in isolation with `npx tsx`.
 */

import { createHash } from "node:crypto"
import { z } from "zod"

export const exploreItemSchema = z.object({
  tokenId: z.number().int().nonnegative(),
  name: z.string(),
  image: z.string(),
  contentHash: z.string().optional(),
  duplicateOfTokenId: z.number().int().nonnegative().optional(),
  collectionId: z.number().int().nullable(),
  ownerTruncated: z.string(),
  worldName: z.string().optional(),
})

export type ExploreItem = z.infer<typeof exploreItemSchema>

export const exploreResponseSchema = z.object({
  items: z.array(exploreItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  perPage: z.number().int().positive(),
  content_hash_dedup_enabled: z.boolean().optional(),
  quest_expiry_windows_enabled: z.boolean().optional(),
})

export type ExploreResponse = z.infer<typeof exploreResponseSchema>

/**
 * Error raised when an explore payload fails type-safe schema validation.
 * Normalised so the UI can distinguish "invalid data" from "fetch failed".
 */
export class ExploreValidationError extends Error {
  readonly code = "EXPLORE_VALIDATION_ERROR" as const
  readonly issues: z.ZodIssue[]
  constructor(issues: z.ZodIssue[]) {
    super(`Explore response failed schema validation (${issues.length} issue(s))`)
    this.name = "ExploreValidationError"
    this.issues = issues
  }
}

export function parseExploreResponse(raw: unknown): ExploreResponse {
  const parsed = exploreResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ExploreValidationError(parsed.error.issues)
  }
  return parsed.data
}

export function truncateAddress(addr: string): string {
  const t = addr.trim()
  if (t.length < 14) return t
  return `${t.slice(0, 6)}…${t.slice(-4)}`
}

/**
 * Bounded-concurrency map. Runs `fn` over `items` with at most `limit`
 * in-flight promises, preserving input order in the output array.
 *
 * AUDIT: this removes the unbounded `Promise.all(ids.map(...))` hazard that let
 * an arbitrarily large scan fan out thousands of RPC calls simultaneously,
 * which is what caused concurrent responses to clobber each other under load.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (limit <= 0 || items.length === 0) return []
  const out: R[] = new Array(items.length)
  let cursor = 0
  async function worker() {
    for (;;) {
      const idx = cursor++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export function assetContentHash(item: Pick<ExploreItem, "image">): string | null {
  const image = item.image.trim().toLowerCase()
  if (!image) return null
  return createHash("sha256").update(image, "utf8").digest("hex")
}

/**
 * Marks repeated asset images with the first-seen token id. Pure — no feature
 * flag read internally so callers decide whether to activate it (see route).
 */
export function dedupeExploreItems(items: ExploreItem[]): ExploreItem[] {
  const firstByHash = new Map<string, number>()
  return items.map((item) => {
    const contentHash = assetContentHash(item)
    if (!contentHash) return item
    const firstTokenId = firstByHash.get(contentHash)
    if (firstTokenId === undefined) {
      firstByHash.set(contentHash, item.tokenId)
      return { ...item, contentHash }
    }
    return { ...item, contentHash, duplicateOfTokenId: firstTokenId }
  })
}

export function paginateExploreItems<T>(items: readonly T[], page: number, perPage: number): T[] {
  if (perPage <= 0) return []
  const start = (page - 1) * perPage
  return items.slice(Math.max(0, start), Math.max(0, start) + perPage)
}

export function filterWorldOnly(items: ExploreItem[]): ExploreItem[] {
  return items.filter((item) => Boolean(item.worldName))
}

// ── module #52 (phase-52): quest_expiry windows with grace-period extension ──
//
// Quests had no lifetime: once written they sat in the store forever, so stale
// entries accumulated without bound and the explore/quest surfaces had to
// filter them by hand. This isolated, flag-gated, pure module gives every quest
// a TTL, an optional grace window after the TTL, and a bounded number of
// grace-period extensions. `computeQuestExpiry` is the single source of truth
// for a quest's lifecycle state; `pruneExpiredQuests` is the sweep the store
// runs to stop the unbounded growth.
//
// Feature flag: phase-52 (NEXT_PUBLIC_FEATURE_PHASE_52 / FEATURE_PHASE_52)
// Rollback: unset the flag → callers keep every quest indefinitely (prior
//           behaviour). No data migration to undo.

export function isQuestExpiryEnabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_52 ?? process.env.FEATURE_PHASE_52 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag52RollbackNote(): string {
  return "Rollback phase-52: unset NEXT_PUBLIC_FEATURE_PHASE_52 / FEATURE_PHASE_52 or set to 0/false and restart. Quests stop expiring and are retained indefinitely; no data migration to undo."
}

export type QuestExpiryState = "active" | "grace" | "expired"

const ONE_YEAR_MS = 365 * 24 * 3_600_000

export const QuestExpiryPolicySchema = z.object({
  ttlMs: z.number().int().positive().max(ONE_YEAR_MS),
  graceMs: z.number().int().nonnegative().max(ONE_YEAR_MS).default(0),
  extensionMs: z.number().int().nonnegative().max(ONE_YEAR_MS).default(0),
  maxExtensions: z.number().int().nonnegative().max(24).default(0),
})

export type QuestExpiryPolicy = z.infer<typeof QuestExpiryPolicySchema>

export const QuestRecordSchema = z.object({
  questId: z.string().trim().min(1).max(128),
  createdAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable().default(null),
  extensionsGranted: z.number().int().nonnegative().max(24).default(0),
})

export type QuestRecord = z.infer<typeof QuestRecordSchema>

export class QuestExpiryError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "EXTENSION_EXHAUSTED" | "ALREADY_EXPIRED"
  details?: unknown
  constructor(code: QuestExpiryError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "QuestExpiryError"
    this.code = code
    this.details = details
  }
}

export type QuestExpiryStatus = {
  questId: string
  state: QuestExpiryState
  expiresAt: number
  graceUntil: number
  msRemaining: number
  extensionsGranted: number
  extensionsRemaining: number
}

function parsePolicy(raw: unknown): QuestExpiryPolicy {
  const parsed = QuestExpiryPolicySchema.safeParse(raw)
  if (!parsed.success) {
    throw new QuestExpiryError("VALIDATION_FAILED", "Invalid quest expiry policy", parsed.error.flatten())
  }
  return parsed.data
}

function parseRecord(raw: unknown): QuestRecord {
  const parsed = QuestRecordSchema.safeParse(raw)
  if (!parsed.success) {
    throw new QuestExpiryError("VALIDATION_FAILED", "Invalid quest record", parsed.error.flatten())
  }
  return parsed.data
}

/** Pure lifecycle resolver: where a quest sits in its TTL → grace → expired timeline. */
export function computeQuestExpiry(rawRecord: unknown, rawPolicy: unknown, now: number = Date.now()): QuestExpiryStatus {
  const record = parseRecord(rawRecord)
  const policy = parsePolicy(rawPolicy)

  const grantedExtensionMs = record.extensionsGranted * policy.extensionMs
  const expiresAt = record.createdAt + policy.ttlMs + grantedExtensionMs
  const graceUntil = expiresAt + policy.graceMs
  const extensionsRemaining = Math.max(0, policy.maxExtensions - record.extensionsGranted)

  let state: QuestExpiryState
  if (record.completedAt != null || now < expiresAt) {
    state = "active"
  } else if (now < graceUntil) {
    state = "grace"
  } else {
    state = "expired"
  }

  return {
    questId: record.questId,
    state,
    expiresAt,
    graceUntil,
    msRemaining: Math.max(0, graceUntil - now),
    extensionsGranted: record.extensionsGranted,
    extensionsRemaining,
  }
}

/**
 * Grants one grace-period extension, returning the updated record. Throws when
 * the extension budget is spent or the quest is already past its grace window
 * (an expired quest cannot be revived).
 */
export function grantGracePeriodExtension(rawRecord: unknown, rawPolicy: unknown, now: number = Date.now()): QuestRecord {
  const record = parseRecord(rawRecord)
  const policy = parsePolicy(rawPolicy)
  if (policy.maxExtensions === 0 || policy.extensionMs === 0) {
    throw new QuestExpiryError("EXTENSION_EXHAUSTED", `Quest "${record.questId}" policy allows no extensions`)
  }
  if (record.extensionsGranted >= policy.maxExtensions) {
    throw new QuestExpiryError("EXTENSION_EXHAUSTED", `Quest "${record.questId}" has used all ${policy.maxExtensions} extensions`)
  }
  const status = computeQuestExpiry(record, policy, now)
  if (status.state === "expired") {
    throw new QuestExpiryError("ALREADY_EXPIRED", `Quest "${record.questId}" is past its grace window and cannot be extended`)
  }
  return { ...record, extensionsGranted: record.extensionsGranted + 1 }
}

export function partitionQuestsByExpiry(
  rawRecords: unknown[],
  rawPolicy: unknown,
  now: number = Date.now(),
): { active: QuestExpiryStatus[]; grace: QuestExpiryStatus[]; expired: QuestExpiryStatus[] } {
  const policy = parsePolicy(rawPolicy)
  const out = { active: [] as QuestExpiryStatus[], grace: [] as QuestExpiryStatus[], expired: [] as QuestExpiryStatus[] }
  for (const raw of rawRecords) {
    const status = computeQuestExpiry(raw, policy, now)
    out[status.state].push(status)
  }
  return out
}

/** The store sweep: drops quests whose grace window has fully elapsed. */
export function pruneExpiredQuests<T>(
  records: readonly T[],
  rawPolicy: unknown,
  pick: (record: T) => unknown,
  now: number = Date.now(),
): { kept: T[]; removed: T[] } {
  const policy = parsePolicy(rawPolicy)
  const kept: T[] = []
  const removed: T[] = []
  for (const record of records) {
    const status = computeQuestExpiry(pick(record), policy, now)
    ;(status.state === "expired" ? removed : kept).push(record)
  }
  return { kept, removed }
}

export function auditQuestExpiryWiring(): { ok: boolean; note: string } {
  if (!isQuestExpiryEnabled()) {
    return { ok: true, note: "[phase-52] quest_expiry windows disabled; nothing to audit." }
  }
  const policy = { ttlMs: 1_000, graceMs: 500, extensionMs: 1_000, maxExtensions: 1 }
  const record = { questId: "diagnose-probe", createdAt: 0 }
  try {
    const active = computeQuestExpiry(record, policy, 500)
    const grace = computeQuestExpiry(record, policy, 1_200)
    const expired = computeQuestExpiry(record, policy, 5_000)
    if (active.state !== "active" || grace.state !== "grace" || expired.state !== "expired") {
      return { ok: false, note: `[phase-52] quest expiry state machine drift: ${active.state}/${grace.state}/${expired.state} (report).` }
    }
    grantGracePeriodExtension(record, policy, 1_200)
    return { ok: true, note: `[phase-52] quest_expiry windows wiring OK. ${flag52RollbackNote()}` }
  } catch (e) {
    return { ok: false, note: `[phase-52] quest expiry schema drift (unexpected, report): ${e instanceof Error ? e.message : String(e)}` }
  }
}
