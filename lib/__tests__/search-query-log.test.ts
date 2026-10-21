import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  computeSearchReport,
  recordSearchClick,
  recordSearchQuery,
  resetSearchCountersForTests,
  searchQueryHash,
  searchRefHash,
  snapshotSearchCounters,
  type SearchEvent,
} from "@/lib/search-query-log"

function queryEvent(over: Partial<SearchEvent> = {}): SearchEvent {
  return {
    surface: "world",
    kind: "query",
    query_hash: searchQueryHash("dragon citadel"),
    result_count: 3,
    ts: 1_000,
    ...over,
  }
}

describe("search-query-log (spike 613 / phase-175)", () => {
  let dataDir: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-search-log-"))
    process.env.PHASE_SERVER_DATA_DIR = dataDir
    for (const key of ["FEATURE_PHASE_175", "NEXT_PUBLIC_FEATURE_PHASE_175"]) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.FEATURE_PHASE_175 = "1"
    resetSearchCountersForTests()
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetSearchCountersForTests()
    await rm(dataDir, { recursive: true, force: true })
  })

  it("query and ref hashes are sha256 hex, never the raw text", () => {
    const q = searchQueryHash("Dragon Citadel")
    expect(q).toMatch(/^[a-f0-9]{64}$/)
    expect(q).not.toContain("Dragon")
    expect(searchQueryHash("Dragon Citadel")).toBe(searchQueryHash("  dragon citadel "))
    expect(searchRefHash("GABC")).toMatch(/^[a-f0-9]{64}$/)
  })

  it("records queries and increments closed counters", async () => {
    const event = await recordSearchQuery(queryEvent({ result_count: 0 }), { now: 1_000 })
    expect(event?.result_count).toBe(0)
    const counters = snapshotSearchCounters()
    expect(counters.search_query_total).toBe(1)
    expect(counters.search_zero_result).toBe(1)
  })

  it("records clicks with the click counter", async () => {
    const event = await recordSearchClick(
      { surface: "profile", query: "ganiyat", resultRef: "GABC", sessionId: "s1" },
      { now: 2_000 },
    )
    expect(event?.kind).toBe("click")
    expect(snapshotSearchCounters().search_click).toBe(1)
  })

  it("dedupes an identical event within a minute", async () => {
    await recordSearchQuery(queryEvent({ session_id: "s1" }), { now: 1_000 })
    const dup = await recordSearchQuery(queryEvent({ session_id: "s1" }), { now: 2_000 })
    expect(dup).toBeNull()
    expect(snapshotSearchCounters().search_query_total).toBe(1)
  })

  it("flag off is a silent no-op", async () => {
    delete process.env.FEATURE_PHASE_175
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_175
    expect(await recordSearchQuery(queryEvent())).toBeNull()
    expect(await recordSearchClick({ surface: "world", query: "x" })).toBeNull()
  })

  it("rejects malformed events with VALIDATION_FAILED", async () => {
    await expect(recordSearchQuery({ surface: "nope", query_hash: "zz" })).rejects.toMatchObject({
      name: "SearchQueryLogError",
      code: "VALIDATION_FAILED",
    })
  })

  it("aggregates zero-result rate, clickthrough and typo success", () => {
    const events: SearchEvent[] = [
      queryEvent({ result_count: 0, session_id: "a", ts: 1_000 }),
      queryEvent({ result_count: 2, session_id: "b", ts: 2_000 }),
      queryEvent({ result_count: 0, session_id: "c", corrected_from_hash: searchQueryHash("dragin"), ts: 3_000 }),
      queryEvent({ result_count: 5, session_id: "c", corrected_from_hash: searchQueryHash("dragin"), ts: 4_000 }),
      { ...queryEvent({ kind: "click", session_id: "b", ts: 5_000 }) },
    ]
    const report = computeSearchReport(events, { windowMs: 60_000, now: 10_000 })
    const world = report.surfaces.find((s) => s.surface === "world")!
    expect(world.queries).toBe(4)
    expect(world.zeroResultQueries).toBe(2)
    expect(world.zeroResultRate).toBeCloseTo(0.5)
    expect(world.clicks).toBe(1)
    expect(world.clickthroughRate).toBeCloseTo(0.25)
    expect(world.correctedQueries).toBe(2)
    expect(world.typoSuccessRate).toBeCloseTo(0.5)
  })

  it("windows the report", () => {
    const old: SearchEvent[] = [queryEvent({ ts: 1_000 })]
    const recent: SearchEvent[] = [queryEvent({ ts: 90_000 })]
    const report = computeSearchReport([...old, ...recent], { windowMs: 10_000, now: 100_000 })
    expect(report.totalQueries).toBe(1)
  })
})
