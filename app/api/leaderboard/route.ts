import { NextRequest, NextResponse } from "next/server"
import {
  isLeaderboardIntegrityEnabled,
  rankLeaderboard,
  scoreLeaderboardCandidate,
  LeaderboardIntegrityError,
  LEADERBOARD_SCHEMA_VERSION,
  type LeaderboardCandidate,
  type SybilBand,
} from "@/lib/leaderboard-integrity"
import { checkAdminKey } from "@/lib/admin-key"
import { readStore, updateStore } from "@/lib/json-store"
import { readBoundedBody } from "@/lib/bounded-body"
import { incSecurityCounter } from "@/lib/security-counters"

export const dynamic = "force-dynamic"

type EntriesStore = {
  schema?: string
  version?: string
  entries?: Record<string, LeaderboardCandidate>
}

const G_ADDRESS_RE = /^G[A-Z2-7]{55}$/
const SYBIL_BANDS: SybilBand[] = ["trusted", "caution", "suspect"]
const MAX_EVENTS_PER_ENTRY = 500
const MAX_BODY_BYTES = 256 * 1024

function normalizeStore(raw: unknown): EntriesStore {
  const parsed = (raw ?? {}) as Partial<EntriesStore>
  return {
    schema: LEADERBOARD_SCHEMA_VERSION,
    version: LEADERBOARD_SCHEMA_VERSION,
    entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
  }
}

function parseCandidate(body: unknown): LeaderboardCandidate {
  if (typeof body !== "object" || body === null) {
    throw new LeaderboardIntegrityError("VALIDATION_FAILED", "JSON object body required")
  }
  const raw = body as Record<string, unknown>
  if (typeof raw.wallet !== "string" || !G_ADDRESS_RE.test(raw.wallet)) {
    throw new LeaderboardIntegrityError("VALIDATION_FAILED", "wallet must be a Stellar G... address")
  }
  if (!Array.isArray(raw.events) || raw.events.length > MAX_EVENTS_PER_ENTRY) {
    throw new LeaderboardIntegrityError(
      "VALIDATION_FAILED",
      `events must be an array of at most ${MAX_EVENTS_PER_ENTRY} entries`,
    )
  }
  const events = raw.events.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>
    if (!Number.isFinite(e.points as number) || !Number.isFinite(e.at as number)) {
      throw new LeaderboardIntegrityError("VALIDATION_FAILED", "each event needs finite points and at (epoch ms)")
    }
    if (e.counterparty !== undefined && e.counterparty !== null && typeof e.counterparty !== "string") {
      throw new LeaderboardIntegrityError("VALIDATION_FAILED", "counterparty must be a string when present")
    }
    return {
      points: e.points as number,
      at: e.at as number,
      ...(typeof e.counterparty === "string" && e.counterparty.length > 0 ? { counterparty: e.counterparty } : {}),
    }
  })
  const band =
    raw.sybil_band === undefined || raw.sybil_band === null
      ? undefined
      : SYBIL_BANDS.includes(raw.sybil_band as SybilBand)
        ? (raw.sybil_band as SybilBand)
        : (() => {
            throw new LeaderboardIntegrityError("VALIDATION_FAILED", "sybil_band must be trusted|caution|suspect")
          })()
  return { wallet: raw.wallet, events, ...(band ? { sybilBand: band } : {}) }
}

export async function GET(request: NextRequest) {
  if (!isLeaderboardIntegrityEnabled()) {
    return NextResponse.json(
      { error: "Leaderboard integrity is disabled (set NEXT_PUBLIC_FEATURE_PHASE_178=1)" },
      { status: 404 },
    )
  }

  const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? "50")
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(Math.floor(limitParam), 200)) : 50

  const store = await readStore<EntriesStore>("leaderboardEntries", () => ({}))
  const entries = Object.values(normalizeStore(store).entries ?? {})
  const ranked = rankLeaderboard(entries).slice(0, limit)

  incSecurityCounter("leaderboard_scored")
  return NextResponse.json({
    schema: LEADERBOARD_SCHEMA_VERSION,
    generated_at: Date.now(),
    count: ranked.length,
    entries: ranked,
  })
}

export async function POST(request: NextRequest) {
  if (!isLeaderboardIntegrityEnabled()) {
    return NextResponse.json(
      { error: "Leaderboard integrity is disabled (set NEXT_PUBLIC_FEATURE_PHASE_178=1)" },
      { status: 404 },
    )
  }

  if (checkAdminKey(request) !== "ok") {
    return NextResponse.json({ error: "Unauthorized: valid x-admin-key required" }, { status: 401 })
  }

  let body: unknown
  try {
    const text = await readBoundedBody(request, MAX_BODY_BYTES)
    body = JSON.parse(text || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    const candidate = parseCandidate(body)
    // Score before persisting so malformed events never reach the store.
    const score = scoreLeaderboardCandidate(candidate)
    await updateStore<EntriesStore, void>("leaderboardEntries", (data) => {
      const store = normalizeStore(data)
      store.entries = store.entries ?? {}
      store.entries[candidate.wallet] = candidate
      data.schema = store.schema
      data.version = store.version
      data.entries = store.entries
    })
    incSecurityCounter("leaderboard_entries_ingested")
    if (score.farmPenalty < 1) incSecurityCounter("leaderboard_farm_penalized")
    if (score.sybilDiscount < 1) incSecurityCounter("leaderboard_sybil_discounted")
    return NextResponse.json({ ok: true, score })
  } catch (error) {
    if (error instanceof LeaderboardIntegrityError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "FLAG_DISABLED" ? 404 : 400 },
      )
    }
    throw error
  }
}
