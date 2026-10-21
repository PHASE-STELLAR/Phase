/**
 * Narrative search indexed by entity and location — phase-110
 *
 * "Entity" = a forged artifact/token (its narrative). "Location" = the
 * world/collection the artifact belongs to (`world_name`). Finding lore
 * about a specific artifact today requires manually scanning collections
 * one by one; this module builds a simple query over the existing
 * narrative + world data so both dimensions can be searched directly,
 * plus a free-text match against the narrative body.
 *
 * Feature flag: phase-110 (NEXT_PUBLIC_FEATURE_PHASE_110 / FEATURE_PHASE_110)
 * Rollback: disable flag → GET /api/world/search returns 404, no data migration.
 */
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getAllNarrativesWithTokenIds, getAllWorldCollections } from "@/lib/narrative-world-store"

export type NarrativeSearchResult = {
  tokenId: number
  narrative: string
  collectionId: number
  worldName: string
  generatedAt: number
}

export type NarrativeSearchQuery = {
  /** Entity id — the artifact/token this narrative belongs to. */
  entity?: number
  /** Location — matched against the world/collection name (substring, case-insensitive). */
  location?: string
  /** Free-text match against the narrative body (substring, case-insensitive). */
  text?: string
}

export function isNarrativeSearchEnabled(): boolean {
  return isFeatureEnabled("phase-110")
}

export async function searchNarratives(query: NarrativeSearchQuery): Promise<NarrativeSearchResult[]> {
  const [narratives, worlds] = await Promise.all([getAllNarrativesWithTokenIds(), getAllWorldCollections()])

  const locationQuery = query.location?.trim().toLowerCase()
  const textQuery = query.text?.trim().toLowerCase()

  const results: NarrativeSearchResult[] = []
  for (const n of narratives) {
    if (query.entity !== undefined && n.tokenId !== query.entity) continue

    const world = worlds[String(n.collection_id)]
    const worldName = world?.world_name ?? ""
    if (locationQuery && !worldName.toLowerCase().includes(locationQuery)) continue
    if (textQuery && !n.narrative.toLowerCase().includes(textQuery)) continue

    results.push({
      tokenId: n.tokenId,
      narrative: n.narrative,
      collectionId: n.collection_id,
      worldName,
      generatedAt: n.generated_at,
    })
  }

  results.sort((a, b) => b.generatedAt - a.generatedAt)
  return results
}

// ── phase-142: ranked retrieval and theme induction ─────────────────────────
//
// searchNarratives is a substring filter: fine for a reader looking up one
// artifact, useless for assembling a show, because it cannot say which of 400
// matching lores is *most* about a theme. These helpers rank instead of filter
// (BM25 over EN/ES lore) and induce a theme when none is given. They are pure
// over the documents passed in, so the curator decides how large a corpus to
// read and the ranking itself never touches disk or RPC.

const LORE_STOPWORDS = new Set(
  (
    "the and for with that this from into over under their there they them were was are has have had " +
    "its his her who whom which what when where while than then thus also only each every some any all " +
    "not but yet nor upon about after before again against between through during without within across " +
    "artifact artifacts phase world forged forge " +
    "los las del una uno unos unas que con por para como pero sus ese esa esos esas este esta estos estas " +
    "entre sobre bajo desde hasta cada todo toda todos todas donde cuando mientras tambien solo sin mas muy " +
    "artefacto artefactos mundo forjado forja"
  ).split(/\s+/),
)

/** Lowercase, accent-folded content words of 3+ letters, stopwords removed. */
export function tokenizeLore(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !LORE_STOPWORDS.has(w) && !/^\d+$/.test(w))
}

export type LoreDocument = {
  tokenId: number
  narrative: string
  collectionId: number
  generatedAt: number
}

export type RankedLoreDocument = LoreDocument & {
  score: number
  /** Query terms that actually occur in this document. */
  matchedTerms: string[]
}

/**
 * Okapi BM25 over `docs` for `queryTerms`. Documents with no matching term are
 * dropped; ties break on token id so the ranking is deterministic.
 */
export function rankLoreDocuments(
  docs: readonly LoreDocument[],
  queryTerms: readonly string[],
  opts: { k1?: number; b?: number } = {},
): RankedLoreDocument[] {
  const k1 = opts.k1 ?? 1.2
  const b = opts.b ?? 0.75
  const terms = [...new Set(queryTerms.flatMap((t) => tokenizeLore(t)))]
  if (terms.length === 0 || docs.length === 0) return []

  const tokenized = docs.map((d) => tokenizeLore(d.narrative))
  const avgLen = tokenized.reduce((sum, t) => sum + t.length, 0) / tokenized.length || 1
  const df = new Map<string, number>()
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) if (terms.includes(term)) df.set(term, (df.get(term) ?? 0) + 1)
  }

  const out: RankedLoreDocument[] = []
  docs.forEach((doc, i) => {
    const tokens = tokenized[i]!
    const tf = new Map<string, number>()
    for (const t of tokens) if (terms.includes(t)) tf.set(t, (tf.get(t) ?? 0) + 1)
    if (tf.size === 0) return
    let score = 0
    for (const [term, f] of tf) {
      const n = df.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokens.length) / avgLen)))
    }
    out.push({ ...doc, score, matchedTerms: [...tf.keys()].sort() })
  })
  return out.sort((x, y) => y.score - x.score || x.tokenId - y.tokenId)
}

/**
 * Pick a theme the corpus can actually support: a term that recurs across
 * several documents *and* several collections (a term confined to one world is
 * that world's vocabulary, not a cross-collection theme), but is not so common
 * it describes everything. The top term is extended with the terms that co-occur
 * with it in at least half its documents.
 */
export function induceThemeTerms(
  docs: readonly LoreDocument[],
  opts: { maxTerms?: number; minDocs?: number; minCollections?: number } = {},
): string[] {
  const maxTerms = opts.maxTerms ?? 3
  const minDocs = opts.minDocs ?? 3
  const minCollections = opts.minCollections ?? 2
  const docsByTerm = new Map<string, Set<number>>()
  const collectionsByTerm = new Map<string, Set<number>>()
  docs.forEach((doc, i) => {
    for (const term of new Set(tokenizeLore(doc.narrative))) {
      if (!docsByTerm.has(term)) {
        docsByTerm.set(term, new Set())
        collectionsByTerm.set(term, new Set())
      }
      docsByTerm.get(term)!.add(i)
      collectionsByTerm.get(term)!.add(doc.collectionId)
    }
  })

  const ceiling = Math.max(minDocs, Math.floor(docs.length * 0.5))
  const candidates = [...docsByTerm.entries()]
    .filter(([term, set]) => set.size >= minDocs && set.size <= ceiling && collectionsByTerm.get(term)!.size >= minCollections)
    .map(([term, set]) => ({ term, score: Math.log(set.size) * collectionsByTerm.get(term)!.size }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
  if (candidates.length === 0) return []

  const seed = candidates[0]!.term
  const seedDocs = docsByTerm.get(seed)!
  const companions = candidates
    .slice(1)
    .map(({ term }) => {
      let overlap = 0
      for (const i of docsByTerm.get(term)!) if (seedDocs.has(i)) overlap++
      return { term, ratio: overlap / seedDocs.size }
    })
    .filter((c) => c.ratio >= 0.5)
    .sort((a, b) => b.ratio - a.ratio || a.term.localeCompare(b.term))
    .slice(0, maxTerms - 1)
    .map((c) => c.term)
  return [seed, ...companions]
}
