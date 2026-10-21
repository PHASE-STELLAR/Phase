/**
 * Autonomous curator exhibitions — phase-142
 *
 * A show is a named, themed, ordered hang of artifacts with a statement and one
 * wall text per work, published as a single versioned row (`exhibitions`).
 *
 * Division of labour, and why:
 *
 * - Selection, order, cover, and every exclusion are deterministic (BM25 over
 *   lore, MMR diversity, owner cap, wash exclusion). These decide whose work is
 *   promoted, so they must be reproducible, testable, and cheap to re-run.
 * - The model writes only words: title, statement, wall text. Its JSON reply is
 *   validated against the hang it was given — one wall per hung token id, no
 *   token id cited that is not on the wall — and any failure falls back to
 *   templated copy rather than publishing unverified text.
 *
 * Cost/latency: the model never sees whole lores. Each hung work is reduced to
 * the one sentence that best carries the theme (the "map" step, local and
 * free), and one call writes the whole show (the "reduce" step), so the prompt
 * is bounded by MAX_WORKS × EXCERPT_CHARS regardless of corpus size. A retry
 * with the same selection reuses the stored draft instead of calling again.
 *
 * Abuse: a curator run cannot be steered into promoting one holder's bag —
 * no owner may fill more than MAX_OWNER_SHARE of a hang, owners are verified
 * (an unverifiable owner is excluded, not assumed distinct), and tokens with a
 * wash-flagged sale in the lookback window are never hung.
 *
 * Feature flag: phase-142. Rollback: unset → routes 404; `exhibitions` rows are
 * inert on disk.
 */

import { createHash, randomUUID } from "node:crypto"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getDb } from "@/lib/sqlite-db"
import { incSecurityCounter } from "@/lib/security-counters"
import { chargeAiStep } from "@/lib/cost-attribution-ledger"
import { fillCopy, pickCopy } from "@/lib/phase-copy"
import { buildExhibitionPrompt } from "@/lib/forge/prompt-builder"
import { aiPromptHash, generateJsonStep, type AiJsonGenerator } from "@/lib/forge/ai-pipeline"
import {
  induceThemeTerms,
  rankLoreDocuments,
  tokenizeLore,
  type LoreDocument,
  type RankedLoreDocument,
} from "@/lib/narrative-search"

export function isCuratorEnabled(): boolean {
  return isFeatureEnabled("phase-142")
}

export const CURATOR_LIMITS = {
  MIN_WORKS: 4,
  MAX_WORKS: 12,
  SHORTLIST: 40,
  MAX_OWNER_SHARE: 0.25,
  WASH_LOOKBACK_MS: 30 * 24 * 3_600_000,
  EXCERPT_CHARS: 280,
  TITLE_CHARS: 80,
  STATEMENT_CHARS: 600,
  WALL_CHARS: 280,
} as const

export type ExhibitionStatus = "draft" | "published" | "rotated"
export type CuratorLang = "en" | "es"

export type HangSlot = {
  position: number
  token_id: number
  collection_id: number
  world_name: string
  owner: string
  score: number
  matched_terms: string[]
  wall_text: string
  /** Metadata image resolved at draft time; empty when it could not be read. */
  image: string
}

export type Exhibition = {
  id: string
  scope: string
  status: ExhibitionStatus
  version: number
  lang: CuratorLang
  title: string
  statement: string
  theme_terms: string[]
  hang: HangSlot[]
  cover_token_id: number
  input_hash: string
  model_id: string | null
  prompt_hash: string | null
  text_source: "model" | "fallback"
  created_at: number
  updated_at: number
  published_at: number | null
  rotated_at: number | null
}

export class CuratorError extends Error {
  constructor(
    readonly code:
      | "FLAG_DISABLED"
      | "VALIDATION_FAILED"
      | "INSUFFICIENT_CANDIDATES"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "INVALID_TRANSITION",
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "CuratorError"
  }
}

// ── pure: excerpt, hang planning, validation ────────────────────────────────

/** The sentence that carries the most theme terms, trimmed to `maxChars`. */
export function excerptForTheme(narrative: string, themeTerms: readonly string[], maxChars: number = CURATOR_LIMITS.EXCERPT_CHARS): string {
  const terms = new Set(themeTerms)
  const sentences = narrative.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean)
  let best = sentences[0] ?? narrative.trim()
  let bestHits = -1
  for (const sentence of sentences) {
    const hits = tokenizeLore(sentence).filter((t) => terms.has(t)).length
    if (hits > bestHits) {
      best = sentence
      bestHits = hits
    }
  }
  return best.length <= maxChars ? best : `${best.slice(0, maxChars - 1).trimEnd()}…`
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export type PlannedHang = {
  slots: Array<RankedLoreDocument & { owner: string }>
  ownerCapApplied: number
}

/**
 * Order the shortlist into a hang.
 *
 * Cover = the most relevant work. Each next slot maximises maximal marginal
 * relevance (relevance minus similarity to what is already hung), with a
 * penalty for repeating the previous slot's collection, so the walk alternates
 * worlds when the shortlist allows it. The closer is the most relevant work not
 * yet hung, giving the show a strong first and last wall. No owner may exceed
 * `maxOwnerShare` of the hang; a candidate whose owner is unknown is skipped.
 */
export function planHang(
  ranked: readonly RankedLoreDocument[],
  opts: { maxWorks: number; maxOwnerShare: number; ownerOf: ReadonlyMap<number, string>; lambda?: number },
): PlannedHang {
  const lambda = opts.lambda ?? 0.7
  const maxWorks = Math.max(1, Math.floor(opts.maxWorks))
  const ownerCap = Math.max(1, Math.floor(maxWorks * opts.maxOwnerShare))
  const pool = ranked
    .filter((d) => opts.ownerOf.has(d.tokenId))
    .map((d) => ({ ...d, owner: opts.ownerOf.get(d.tokenId)!.toUpperCase(), terms: new Set(tokenizeLore(d.narrative)) }))
  if (pool.length === 0) return { slots: [], ownerCapApplied: 0 }

  const maxScore = Math.max(...pool.map((d) => d.score)) || 1
  const perOwner = new Map<string, number>()
  let ownerCapApplied = 0
  const chosen: typeof pool = []
  const remaining = [...pool]

  const ownerFull = (owner: string) => (perOwner.get(owner) ?? 0) >= ownerCap
  const take = (idx: number) => {
    const [item] = remaining.splice(idx, 1)
    chosen.push(item!)
    perOwner.set(item!.owner, (perOwner.get(item!.owner) ?? 0) + 1)
  }
  const dropCapped = () => {
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (ownerFull(remaining[i]!.owner)) {
        remaining.splice(i, 1)
        ownerCapApplied++
      }
    }
  }

  take(0)
  dropCapped()
  // Reserve the closer before filling the middle, so diversity never crowds out
  // the second strongest work.
  const closer = remaining.length > 0 && maxWorks >= 3 ? remaining.shift()! : null
  if (closer) perOwner.set(closer.owner, (perOwner.get(closer.owner) ?? 0) + 1)
  dropCapped()

  const middleTarget = maxWorks - 1 - (closer ? 1 : 0)
  while (chosen.length - 1 < middleTarget && remaining.length > 0) {
    const prev = chosen[chosen.length - 1]!
    let bestIdx = 0
    let bestValue = -Infinity
    remaining.forEach((cand, idx) => {
      const rel = cand.score / maxScore
      const sim = Math.max(...chosen.map((c) => jaccard(c.terms, cand.terms)))
      const sameWorld = cand.collectionId === prev.collectionId ? 0.5 : 0
      const value = lambda * rel - (1 - lambda) * sim - sameWorld
      if (value > bestValue || (value === bestValue && cand.tokenId < remaining[bestIdx]!.tokenId)) {
        bestValue = value
        bestIdx = idx
      }
    })
    take(bestIdx)
    dropCapped()
  }
  if (closer) chosen.push(closer)

  return {
    slots: chosen.map(({ terms: _terms, ...rest }) => rest),
    ownerCapApplied,
  }
}

export type WallTextValidation =
  | { ok: true; title: string; statement: string; walls: Map<number, string> }
  | { ok: false; reason: "shape" | "missing_wall" | "unknown_token" | "length" | "citation" }

/**
 * Accept the model's JSON only if it describes exactly this hang: one non-empty
 * wall per hung token, no other token ids, every `#123` mention in any text
 * resolving to a hung token, and every field within its length budget.
 */
export function validateWallText(raw: unknown, hangTokenIds: readonly number[]): WallTextValidation {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "shape" }
  const r = raw as { title?: unknown; statement?: unknown; walls?: unknown }
  if (typeof r.title !== "string" || typeof r.statement !== "string" || !Array.isArray(r.walls)) {
    return { ok: false, reason: "shape" }
  }
  const title = r.title.trim()
  const statement = r.statement.trim()
  if (!title || !statement || title.length > CURATOR_LIMITS.TITLE_CHARS || statement.length > CURATOR_LIMITS.STATEMENT_CHARS) {
    return { ok: false, reason: "length" }
  }
  const hung = new Set(hangTokenIds)
  const walls = new Map<number, string>()
  for (const w of r.walls as Array<{ token_id?: unknown; text?: unknown }>) {
    const id = Number(w?.token_id)
    if (!Number.isInteger(id) || !hung.has(id)) return { ok: false, reason: "unknown_token" }
    const text = typeof w.text === "string" ? w.text.trim() : ""
    if (!text || text.length > CURATOR_LIMITS.WALL_CHARS) return { ok: false, reason: "length" }
    walls.set(id, text)
  }
  if (walls.size !== hung.size) return { ok: false, reason: "missing_wall" }
  const cited = [title, statement, ...walls.values()].flatMap((t) => [...t.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))
  if (cited.some((id) => !hung.has(id))) return { ok: false, reason: "citation" }
  return { ok: true, title, statement, walls }
}

export function selectionInputHash(scope: string, lang: CuratorLang, themeTerms: readonly string[], tokenIds: readonly number[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ scope, lang, themeTerms, tokenIds }), "utf8")
    .digest("hex")
    .slice(0, 32)
}

// ── persistence ─────────────────────────────────────────────────────────────

type ExhibitionRow = Omit<Exhibition, "theme_terms" | "hang" | "lang" | "status" | "text_source"> & {
  theme_json: string
  hang_json: string
  lang: string
  status: string
  text_source: string
}

function rowToExhibition(row: ExhibitionRow): Exhibition {
  const { theme_json, hang_json, ...rest } = row
  return {
    ...rest,
    lang: row.lang === "es" ? "es" : "en",
    status: row.status as ExhibitionStatus,
    text_source: row.text_source === "model" ? "model" : "fallback",
    theme_terms: JSON.parse(theme_json) as string[],
    hang: JSON.parse(hang_json) as HangSlot[],
  }
}

export function getExhibition(id: string): Exhibition | null {
  const row = getDb().prepare("SELECT * FROM exhibitions WHERE id = ?").get(id) as ExhibitionRow | undefined
  return row ? rowToExhibition(row) : null
}

export function listExhibitions(opts: { scope?: string; status?: ExhibitionStatus; limit?: number } = {}): Exhibition[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (opts.scope) {
    conditions.push("scope = ?")
    params.push(opts.scope)
  }
  if (opts.status) {
    conditions.push("status = ?")
    params.push(opts.status)
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)))
  const rows = getDb()
    .prepare(`SELECT * FROM exhibitions ${where} ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`)
    .all(...params, limit) as ExhibitionRow[]
  return rows.map(rowToExhibition)
}

function findReusableDraft(inputHash: string, lang: CuratorLang): Exhibition | null {
  const row = getDb()
    .prepare("SELECT * FROM exhibitions WHERE input_hash = ? AND lang = ? AND status = 'draft' LIMIT 1")
    .get(inputHash, lang) as ExhibitionRow | undefined
  return row ? rowToExhibition(row) : null
}

/**
 * Publish or rotate under BEGIN IMMEDIATE with a version guard. Publishing a
 * show rotates whatever is currently published in the same scope in the same
 * transaction, so a scope never has two shows on view.
 */
export function transitionExhibition(
  id: string,
  expectedVersion: number,
  to: "published" | "rotated",
  now: number = Date.now(),
): { exhibition: Exhibition; rotated: string[] } {
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const row = db.prepare("SELECT * FROM exhibitions WHERE id = ?").get(id) as ExhibitionRow | undefined
    if (!row) throw new CuratorError("NOT_FOUND", "exhibition not found")
    if (row.version !== expectedVersion) {
      incSecurityCounter("ai_store_version_conflicts")
      throw new CuratorError("VERSION_CONFLICT", "exhibition version changed", { current_version: row.version })
    }
    const from = row.status as ExhibitionStatus
    if ((to === "published" && from !== "draft") || (to === "rotated" && from !== "published")) {
      throw new CuratorError("INVALID_TRANSITION", `cannot move ${from} → ${to}`)
    }

    const rotated: string[] = []
    if (to === "published") {
      const live = db
        .prepare("SELECT id FROM exhibitions WHERE scope = ? AND status = 'published' AND id != ?")
        .all(row.scope, id) as Array<{ id: string }>
      for (const { id: liveId } of live) {
        db.prepare(
          "UPDATE exhibitions SET status = 'rotated', rotated_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        ).run(now, now, liveId)
        rotated.push(liveId)
      }
    }
    const result = db
      .prepare(
        `UPDATE exhibitions SET status = ?, version = version + 1, updated_at = ?,
           published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END,
           rotated_at   = CASE WHEN ? = 'rotated'   THEN ? ELSE rotated_at   END
         WHERE id = ? AND version = ?`,
      )
      .run(to, now, to, now, to, now, id, expectedVersion)
    if (Number(result.changes) !== 1) {
      throw new CuratorError("VERSION_CONFLICT", "exhibition version changed")
    }
    db.exec("COMMIT")
    if (to === "published") incSecurityCounter("curator_exhibitions_published")
    return { exhibition: getExhibition(id)!, rotated }
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // already rolled back
    }
    throw error
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

export type DraftExhibitionInput = {
  scope: string
  collectionIds?: number[]
  theme?: string
  lang: CuratorLang
  maxWorks?: number
}

export type DraftExhibitionDeps = {
  corpus: () => Promise<LoreDocument[]>
  worldNames: () => Promise<Record<string, string>>
  washFlaggedTokenIds: (tokenIds: number[], since: number) => Set<number>
  /** Resolves owners; ids it cannot verify must be absent from the map. */
  resolveOwners: (tokenIds: number[]) => Promise<Map<number, string>>
  /** Optional: images for the final hang only (≤ MAX_WORKS lookups). */
  resolveImages?: (tokenIds: number[]) => Promise<Map<number, string>>
  generate?: AiJsonGenerator
  now?: number
}

export async function draftExhibition(
  input: DraftExhibitionInput,
  deps: DraftExhibitionDeps,
): Promise<{ exhibition: Exhibition; reused: boolean }> {
  const now = deps.now ?? Date.now()
  const maxWorks = Math.min(CURATOR_LIMITS.MAX_WORKS, Math.max(CURATOR_LIMITS.MIN_WORKS, Math.floor(input.maxWorks ?? 8)))
  const corpus = await deps.corpus()

  const themeTerms = input.theme?.trim()
    ? [...new Set(tokenizeLore(input.theme))].slice(0, 6)
    : induceThemeTerms(corpus)
  if (themeTerms.length === 0) {
    throw new CuratorError("INSUFFICIENT_CANDIDATES", "no theme the corpus can support")
  }

  let shortlist = rankLoreDocuments(corpus, themeTerms).slice(0, CURATOR_LIMITS.SHORTLIST)
  const washed = deps.washFlaggedTokenIds(
    shortlist.map((d) => d.tokenId),
    now - CURATOR_LIMITS.WASH_LOOKBACK_MS,
  )
  if (washed.size > 0) {
    incSecurityCounter("curator_wash_tokens_excluded", washed.size)
    shortlist = shortlist.filter((d) => !washed.has(d.tokenId))
  }

  const owners = await deps.resolveOwners(shortlist.map((d) => d.tokenId))
  const unverified = shortlist.filter((d) => !owners.has(d.tokenId)).length
  if (unverified > 0) incSecurityCounter("curator_owner_unverified_excluded", unverified)

  const planned = planHang(shortlist, { maxWorks, maxOwnerShare: CURATOR_LIMITS.MAX_OWNER_SHARE, ownerOf: owners })
  if (planned.ownerCapApplied > 0) incSecurityCounter("curator_owner_cap_applied", planned.ownerCapApplied)
  if (planned.slots.length < CURATOR_LIMITS.MIN_WORKS) {
    throw new CuratorError("INSUFFICIENT_CANDIDATES", "not enough eligible works for this theme", {
      eligible: planned.slots.length,
      required: CURATOR_LIMITS.MIN_WORKS,
    })
  }

  const tokenIds = planned.slots.map((s) => s.tokenId)
  const inputHash = selectionInputHash(input.scope, input.lang, themeTerms, tokenIds)
  const reusable = findReusableDraft(inputHash, input.lang)
  if (reusable) {
    incSecurityCounter("curator_draft_reused")
    return { exhibition: reusable, reused: true }
  }

  const worlds = await deps.worldNames()
  const worldName = (collectionId: number) => worlds[String(collectionId)] ?? `#${collectionId}`
  const excerpts = new Map(planned.slots.map((s) => [s.tokenId, excerptForTheme(s.narrative, themeTerms)]))

  const copy = pickCopy(input.lang).curator
  const themeLabel = themeTerms.join(" · ")
  let title = fillCopy(copy.titleFallback, { theme: themeLabel })
  let statement = fillCopy(copy.statementFallback, {
    theme: themeLabel,
    count: new Set(planned.slots.map((s) => s.collectionId)).size,
  })
  let walls = new Map(
    planned.slots.map((s) => [s.tokenId, fillCopy(copy.wallTextFallback, { world: worldName(s.collectionId), excerpt: excerpts.get(s.tokenId)! })]),
  )
  let textSource: Exhibition["text_source"] = "fallback"
  let modelId: string | null = null

  const prompt = buildExhibitionPrompt({
    lang: input.lang,
    themeTerms,
    items: planned.slots.map((s) => ({ token_id: s.tokenId, world_name: worldName(s.collectionId), excerpt: excerpts.get(s.tokenId)! })),
  })
  const generate = deps.generate ?? generateJsonStep
  try {
    const reply = await generate({ prompt })
    chargeAiStep(`curator:${inputHash}`, "curator.wall_text", prompt.length, reply.outputChars)
    const checked = validateWallText(reply.json, tokenIds)
    if (checked.ok) {
      title = checked.title
      statement = checked.statement
      walls = checked.walls
      textSource = "model"
      modelId = reply.modelId
    } else {
      incSecurityCounter("curator_citation_rejected")
    }
  } catch {
    // Model unavailable or timed out: the templated text below is already grounded.
  }
  if (textSource === "fallback") incSecurityCounter("curator_text_fallback")
  const images = deps.resolveImages ? await deps.resolveImages(tokenIds).catch(() => new Map<number, string>()) : new Map<number, string>()

  const hang: HangSlot[] = planned.slots.map((s, i) => ({
    position: i + 1,
    token_id: s.tokenId,
    collection_id: s.collectionId,
    world_name: worldName(s.collectionId),
    owner: s.owner,
    score: Number(s.score.toFixed(4)),
    matched_terms: s.matchedTerms,
    wall_text: walls.get(s.tokenId)!,
    image: images.get(s.tokenId) ?? "",
  }))

  const exhibition: Exhibition = {
    id: randomUUID(),
    scope: input.scope,
    status: "draft",
    version: 1,
    lang: input.lang,
    title,
    statement,
    theme_terms: themeTerms,
    hang,
    cover_token_id: hang[0]!.token_id,
    input_hash: inputHash,
    model_id: modelId,
    prompt_hash: aiPromptHash(prompt),
    text_source: textSource,
    created_at: now,
    updated_at: now,
    published_at: null,
    rotated_at: null,
  }

  // Re-check under the write lock: two concurrent identical requests both miss
  // the reuse lookup above, but only the first may persist a draft.
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const raced = findReusableDraft(inputHash, input.lang)
    if (raced) {
      db.exec("COMMIT")
      incSecurityCounter("curator_draft_reused")
      return { exhibition: raced, reused: true }
    }
    db.prepare(
      `INSERT INTO exhibitions
         (id, scope, status, version, lang, title, statement, theme_json, hang_json,
          cover_token_id, input_hash, model_id, prompt_hash, text_source,
          created_at, updated_at, published_at, rotated_at)
       VALUES (?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      exhibition.id,
      exhibition.scope,
      exhibition.lang,
      exhibition.title,
      exhibition.statement,
      JSON.stringify(exhibition.theme_terms),
      JSON.stringify(exhibition.hang),
      exhibition.cover_token_id,
      exhibition.input_hash,
      exhibition.model_id,
      exhibition.prompt_hash,
      exhibition.text_source,
      now,
      now,
    )
    db.exec("COMMIT")
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // already rolled back
    }
    throw error
  }
  incSecurityCounter("curator_exhibitions_drafted")
  return { exhibition, reused: false }
}

/** Public projection: owners truncated, scores kept for transparency. */
export function publicExhibition(e: Exhibition) {
  return {
    ...e,
    hang: e.hang.map(({ owner, ...slot }) => ({ ...slot, owner_truncated: `${owner.slice(0, 6)}…${owner.slice(-4)}` })),
  }
}
