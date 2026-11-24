import { createHash } from "node:crypto"
import { z } from "zod"
import { flagRollbackNote, isFeatureEnabled } from "@/lib/feature-flags"
import { readStore, updateStoreWithReader } from "@/lib/json-store"

// ── Spike 613 (phase-175): search analytics — query logs, zero-result rate,
// clickthrough and typo effectiveness ──
//
// World and profile search ran with no query logging at all: zero-result
// queries were invisible, clickthrough was unmeasured, and the one
// typo-tolerant path (follow suggestions) had no effectiveness baseline. This
// module logs hashed queries per closed surface into a bounded sidecar,
// records clicks, and aggregates zero-result / clickthrough / typo-correction
// rates from a pure function so the math is testable without disk.
//
// Feature flag: phase-175 (NEXT_PUBLIC_FEATURE_PHASE_175 / FEATURE_PHASE_175)
// Rollback: unset the flag → recordSearchQuery / recordSearchClick are no-ops
//           (return null) and search-query-log.json stays inert on disk. No
//           migration to undo.
//
// Privacy: queries are stored as sha256(normalized query) hex; viewer wallets
// are hashed the same way (market-store viewerAnalyticsKey precedent). Raw
// query text and raw wallets never reach the sidecar.

export function isSearchAnalyticsEnabled(): boolean {
  return isFeatureEnabled("phase-175")
}

export function searchAnalyticsRollbackNote(): string {
  return flagRollbackNote("phase-175")
}

export const SEARCH_SURFACES = ["world", "profile", "explore"] as const
export type SearchSurface = (typeof SEARCH_SURFACES)[number]

export const SEARCH_QUERY_KINDS = ["query", "click"] as const
export type SearchQueryKind = (typeof SEARCH_QUERY_KINDS)[number]

const SearchEventSchema = z.object({
  surface: z.enum(SEARCH_SURFACES),
  kind: z.enum(SEARCH_QUERY_KINDS).default("query"),
  /** sha256 hex of the normalized query (64 chars). */
  query_hash: z.string().regex(/^[a-f0-9]{64}$/, "query_hash must be sha256 hex"),
  result_count: z.number().int().min(0).max(10_000).optional(),
  duration_ms: z.number().int().min(0).max(600_000).optional(),
  /** Opaque session correlation id (bounded); never a wallet. */
  session_id: z.string().trim().min(1).max(64).optional(),
  /** sha256 hex of the pre-correction query, when the user fixed a typo. */
  corrected_from_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** sha256 hex of the clicked result reference (token id / wallet). */
  result_ref_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  ts: z.number().int().min(0).optional(),
})

export type SearchEventInput = z.infer<typeof SearchEventSchema>

export type SearchEvent = SearchEventInput & { ts: number }

export class SearchQueryLogError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED"
  details?: unknown
  constructor(code: SearchQueryLogError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "SearchQueryLogError"
    this.code = code
    this.details = details
  }
}

const MAX_QUERY_EVENTS = 5_000
export const DEFAULT_SEARCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

type SearchQueryLogStore = {
  version: number
  events: SearchEvent[]
}

function emptyStore(): SearchQueryLogStore {
  return { version: 1, events: [] }
}

function normalizeStore(raw: unknown): SearchQueryLogStore {
  const s = raw as SearchQueryLogStore | undefined
  if (!s || typeof s !== "object" || !Array.isArray(s.events)) return emptyStore()
  return { version: typeof s.version === "number" && s.version > 0 ? s.version : 1, events: s.events }
}

/** sha256 hex of the normalized query — the only form that is persisted. */
export function searchQueryHash(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase(), "utf8").digest("hex")
}

/** sha256 hex of a wallet or result reference — never store the raw value. */
export function searchRefHash(ref: string): string {
  return createHash("sha256").update(ref.trim().toUpperCase(), "utf8").digest("hex")
}

// Closed counter labels — no PII, no unbounded cardinality.
const counters = new Map<string, number>()

export function snapshotSearchCounters(): Record<string, number> {
  return Object.fromEntries(counters)
}

export function resetSearchCountersForTests(): void {
  counters.clear()
}

function bump(
  name:
    | "search_query_total"
    | "search_zero_result"
    | "search_click"
    | "search_typo_corrected"
    | "search_typo_suggested"
    | "search_retention_pruned",
): void {
  counters.set(name, (counters.get(name) ?? 0) + 1)
}

function isRecentDuplicate(store: SearchQueryLogStore, event: SearchEvent, windowMs = 60_000): boolean {
  const last = store.events[store.events.length - 1]
  if (!last) return false
  return (
    last.surface === event.surface &&
    last.kind === event.kind &&
    last.query_hash === event.query_hash &&
    last.session_id === event.session_id &&
    event.ts - last.ts < windowMs
  )
}

/**
 * Appends a search event. Returns the stored event, or null when the flag is
 * off (silent no-op so the hot search path never breaks on analytics).
 */
export async function recordSearchQuery(
  raw: unknown,
  opts: { now?: number; retentionMs?: number } = {},
): Promise<SearchEvent | null> {
  if (!isSearchAnalyticsEnabled()) return null
  const parsed = SearchEventSchema.safeParse(raw)
  if (!parsed.success) {
    throw new SearchQueryLogError("VALIDATION_FAILED", "valid search event required", parsed.error.flatten())
  }
  const now = opts.now ?? Date.now()
  const retentionMs = opts.retentionMs ?? DEFAULT_SEARCH_RETENTION_MS
  const cutoff = now - retentionMs
  const event: SearchEvent = { ...parsed.data, ts: parsed.data.ts ?? now }

  return updateStoreWithReader<SearchQueryLogStore, SearchEvent | null>(
    "searchQueryLog",
    normalizeStore,
    (store) => {
      if (isRecentDuplicate(store, event)) return null
      const beforePrune = store.events.length
      if (retentionMs > 0) {
        store.events = store.events.filter((e) => e.ts >= cutoff)
        if (store.events.length < beforePrune) bump("search_retention_pruned")
      }
      store.events.push(event)
      if (store.events.length > MAX_QUERY_EVENTS) {
        store.events.splice(0, store.events.length - MAX_QUERY_EVENTS)
      }
      store.version += 1
      if (event.kind === "click") bump("search_click")
      else {
        bump("search_query_total")
        if (event.result_count === 0) bump("search_zero_result")
        if (event.corrected_from_hash) bump("search_typo_corrected")
      }
      return event
    },
  )
}

/** Prunes events older than `retentionMs` from the sidecar; returns count removed. */
export async function pruneSearchQueryLog(
  opts: { retentionMs?: number; now?: number } = {},
): Promise<number> {
  if (!isSearchAnalyticsEnabled()) return 0
  const retentionMs = opts.retentionMs ?? DEFAULT_SEARCH_RETENTION_MS
  const now = opts.now ?? Date.now()
  const cutoff = now - retentionMs
  return updateStoreWithReader<SearchQueryLogStore, number>(
    "searchQueryLog",
    normalizeStore,
    (store) => {
      const before = store.events.length
      store.events = store.events.filter((e) => e.ts >= cutoff)
      const removed = before - store.events.length
      if (removed > 0) {
        store.version += 1
        bump("search_retention_pruned")
      }
      return removed
    },
  )
}

/** Convenience wrapper for clickthrough beacons. */
export async function recordSearchClick(
  input: { surface: SearchSurface; query: string; resultRef?: string; sessionId?: string },
  opts: { now?: number } = {},
): Promise<SearchEvent | null> {
  return recordSearchQuery(
    {
      surface: input.surface,
      kind: "click",
      query_hash: searchQueryHash(input.query),
      result_ref_hash: input.resultRef ? searchRefHash(input.resultRef) : undefined,
      session_id: input.sessionId,
    },
    opts,
  )
}

export type SearchSurfaceReport = {
  surface: SearchSurface
  queries: number
  zeroResultQueries: number
  zeroResultRate: number
  clicks: number
  clickthroughRate: number
  /** Clicks that join to a recorded query on the same surface, query_hash (and session_id if present). */
  joinedClicks: number
  joinedClickthroughRate: number
  correctedQueries: number
  /** Share of typo-corrected queries whose same-session follow-up query hit results. */
  typoSuccessRate: number
}

export type SearchAnalyticsReport = {
  enabled: boolean
  windowMs: number
  totalQueries: number
  totalClicks: number
  totalJoinedClicks: number
  overallZeroResultRate: number
  overallClickthroughRate: number
  overallJoinedClickthroughRate: number
  overallTypoSuccessRate: number
  surfaces: SearchSurfaceReport[]
}

/**
 * Deterministic bounded Damerau-Levenshtein (optimal string alignment) distance.
 * Returns `maxDistance + 1` as soon as the edit distance is guaranteed to exceed `maxDistance`.
 */
export function boundedEditDistance(a: string, b: string, maxDistance = 2): number {
  const cap = Math.max(0, Math.min(3, Math.floor(maxDistance)))
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1

  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(cap + 1))

  for (let i = 0; i <= m; i++) dp[i]![0] = i
  for (let j = 0; j <= n; j++) dp[0]![j] = j

  for (let i = 1; i <= m; i++) {
    let rowMin = cap + 1
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let val = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2]![j - 2]! + cost)
      }
      dp[i]![j] = val
      if (val < rowMin) rowMin = val
    }
    if (rowMin > cap) return cap + 1
  }

  return dp[m]![n]! <= cap ? dp[m]![n]! : cap + 1
}

export type TypoCorrectionSuggestion = {
  suggestion: string
  distance: number
  queryHash: string
  suggestionHash: string
}

/**
 * Deterministic typo correction over a candidate vocabulary within a bounded edit distance.
 * Ties are broken by smallest edit distance, then lexicographical order of the normalized term.
 */
export function suggestSearchTypoCorrection(
  query: string,
  vocabulary: readonly string[],
  opts: { maxDistance?: number; minQueryLength?: number } = {},
): TypoCorrectionSuggestion | null {
  const normalized = query.trim().toLowerCase()
  const minLen = opts.minQueryLength ?? 3
  const maxDist = Math.max(1, Math.min(3, opts.maxDistance ?? 2))
  if (normalized.length < minLen) return null

  const candidates = Array.from(
    new Set(vocabulary.map((v) => v.trim().toLowerCase()).filter((v) => v.length >= minLen)),
  ).sort()

  if (candidates.includes(normalized)) return null

  let best: { term: string; distance: number } | null = null
  for (const term of candidates) {
    const d = boundedEditDistance(normalized, term, maxDist)
    if (d <= maxDist && (!best || d < best.distance)) {
      best = { term, distance: d }
    }
  }

  if (!best) return null
  if (isSearchAnalyticsEnabled()) bump("search_typo_suggested")
  return {
    suggestion: best.term,
    distance: best.distance,
    queryHash: searchQueryHash(normalized),
    suggestionHash: searchQueryHash(best.term),
  }
}

/**
 * Pure aggregation over events — testable without disk. Zero-result rate is
 * zero-result queries / queries. Clickthrough rate is clicks / queries.
 * Typo effectiveness: for queries carrying corrected_from_hash, look for a
 * later same-session query event with result_count > 0; the share of such
 * sessions that "recovered" is the typo success rate.
 */
export function computeSearchReport(
  events: readonly SearchEvent[],
  opts: { windowMs?: number; now?: number } = {},
): SearchAnalyticsReport {
  const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000
  const now = opts.now ?? Date.now()
  const cutoff = now - windowMs
  const recent = events.filter((e) => e.ts >= cutoff)

  const perSurface = new Map<
    SearchSurface,
    { queries: number; zero: number; clicks: number; joinedClicks: number; corrected: number; recovered: number }
  >()
  for (const surface of SEARCH_SURFACES) {
    perSurface.set(surface, { queries: 0, zero: 0, clicks: 0, joinedClicks: 0, corrected: 0, recovered: 0 })
  }

  const queryKeys = new Set<string>()
  const sessionQueryKeys = new Set<string>()
  const sessionSuccessAfter = new Map<string, number[]>()
  for (const e of recent) {
    if (e.kind === "query") {
      queryKeys.add(`${e.surface}:${e.query_hash}`)
      if (e.session_id) {
        sessionQueryKeys.add(`${e.surface}:${e.query_hash}:${e.session_id}`)
        if ((e.result_count ?? 0) > 0) {
          const list = sessionSuccessAfter.get(e.session_id) ?? []
          list.push(e.ts)
          sessionSuccessAfter.set(e.session_id, list)
        }
      }
    }
  }

  for (const e of recent) {
    const bucket = perSurface.get(e.surface)
    if (!bucket) continue
    if (e.kind === "click") {
      bucket.clicks += 1
      const joined = e.session_id
        ? sessionQueryKeys.has(`${e.surface}:${e.query_hash}:${e.session_id}`) ||
          queryKeys.has(`${e.surface}:${e.query_hash}`)
        : queryKeys.has(`${e.surface}:${e.query_hash}`)
      if (joined) bucket.joinedClicks += 1
      continue
    }
    bucket.queries += 1
    if (e.result_count === 0) bucket.zero += 1
    if (e.corrected_from_hash) {
      bucket.corrected += 1
      // A typo recovered only if a LATER same-session query hit results — a
      // success that preceded the correction does not count.
      const laterHits = e.session_id ? (sessionSuccessAfter.get(e.session_id) ?? []).filter((ts) => ts > e.ts) : []
      if (laterHits.length > 0) bucket.recovered += 1
    }
  }

  const surfaces: SearchSurfaceReport[] = SEARCH_SURFACES.map((surface) => {
    const b = perSurface.get(surface)!
    return {
      surface,
      queries: b.queries,
      zeroResultQueries: b.zero,
      zeroResultRate: b.queries > 0 ? b.zero / b.queries : 0,
      clicks: b.clicks,
      clickthroughRate: b.queries > 0 ? b.clicks / b.queries : 0,
      joinedClicks: b.joinedClicks,
      joinedClickthroughRate: b.queries > 0 ? b.joinedClicks / b.queries : 0,
      correctedQueries: b.corrected,
      typoSuccessRate: b.corrected > 0 ? b.recovered / b.corrected : 0,
    }
  })

  const totalQueries = surfaces.reduce((s, r) => s + r.queries, 0)
  const totalZero = surfaces.reduce((s, r) => s + r.zeroResultQueries, 0)
  const totalClicks = surfaces.reduce((s, r) => s + r.clicks, 0)
  const totalJoinedClicks = surfaces.reduce((s, r) => s + r.joinedClicks, 0)
  const totalCorrected = surfaces.reduce((s, r) => s + r.correctedQueries, 0)
  const totalRecovered = Array.from(perSurface.values()).reduce((s, b) => s + b.recovered, 0)

  return {
    enabled: isSearchAnalyticsEnabled(),
    windowMs,
    totalQueries,
    totalClicks,
    totalJoinedClicks,
    overallZeroResultRate: totalQueries > 0 ? totalZero / totalQueries : 0,
    overallClickthroughRate: totalQueries > 0 ? totalClicks / totalQueries : 0,
    overallJoinedClickthroughRate: totalQueries > 0 ? totalJoinedClicks / totalQueries : 0,
    overallTypoSuccessRate: totalCorrected > 0 ? totalRecovered / totalCorrected : 0,
    surfaces,
  }
}

/** Reads the sidecar and aggregates; flag off → empty disabled report. */
export async function getSearchAnalyticsReport(
  opts: { windowMs?: number; now?: number } = {},
): Promise<SearchAnalyticsReport> {
  if (!isSearchAnalyticsEnabled()) {
    return computeSearchReport([], opts)
  }
  const store = await readStore<SearchQueryLogStore>("searchQueryLog", emptyStore)
  return computeSearchReport(normalizeStore(store).events, opts)
}
