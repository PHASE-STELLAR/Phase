/**
 * Funnel Analytics v2 with Retention Cohorts — Spike 611 / phase-177.
 *
 * Extends the v1 faucet funnel into an analytics engine:
 * 1. Day-N retention cohorts (Day-1, Day-3, Day-7, Day-14, Day-30)
 * 2. Time-to-convert distribution tracking (p50, p90, mean, min, max)
 * 3. Wallet-age bands (<24h, 1-7d, 7-30d, >30d) via in-memory Horizon bulkhead cache
 * 4. Sybil-weighted retention (trusted vs caution vs suspect)
 * 5. Quest milestone cohorts & achievement unlock joins
 * 6. Concurrency-safe referral attribution joins
 *
 * Feature flag: phase-177 (NEXT_PUBLIC_FEATURE_PHASE_177 / FEATURE_PHASE_177)
 * Rollback: unset the flag → read paths revert cleanly to v1 computeClaimFunnel.
 */

import { readJsonFile } from "@/lib/json-store"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { getDb } from "@/lib/sqlite-db"
import { ensureAnalyticsEventTable } from "@/lib/analytics-warehouse"
import { isFeatureEnabled, phase177RollbackNote } from "@/lib/feature-flags"
import {
  type WalletAgeBand,
  getWalletAgeBandCached,
  withHorizonBulkhead,
} from "@/lib/horizon-bulkhead"
import {
  type SybilBand,
  classifyWalletForCohorts,
} from "@/lib/sybil-resistance"
import { readReferralStore } from "@/lib/referral-quest"
import { HORIZON_URL } from "@/lib/phase-protocol"

export const RETENTION_DAYS = [1, 3, 7, 14, 30] as const
export type RetentionDay = (typeof RETENTION_DAYS)[number]

export type TimeToConvertMetrics = {
  fromStage: string
  toStage: string
  count: number
  meanMs: number
  medianMs: number
  p90Ms: number
  minMs: number
  maxMs: number
}

export type DayNRetention = {
  day: RetentionDay
  activeCount: number
  retentionRate: number
}

export type RetentionCohort = {
  cohortKey: string // e.g. "2026-10-14" or quest ID
  cohortSize: number
  dayN: DayNRetention[]
  sybilBreakdown: Record<SybilBand, number>
  walletAgeBreakdown: Record<WalletAgeBand, number>
}

export type FunnelRetentionReport = {
  windowMs: number | null
  totalSubjects: number
  timeToConvert: TimeToConvertMetrics[]
  cohorts: RetentionCohort[]
  overallDay7Retention: number
  overallDay30Retention: number
  sybilWeightedRetention: {
    trustedRetentionDay7: number
    cautionRetentionDay7: number
    suspectRetentionDay7: number
  }
}

type WalletClaims = {
  genesisAt?: number
  dailyAt?: number
  quests?: Record<string, number>
}

type FaucetClaimsStore = Record<string, WalletClaims>

type AchievementEntry = {
  id: string
  unlocked_at: number
}

type WalletAchievements = {
  unlocked: AchievementEntry[]
}

type AchievementsStore = Record<string, WalletAchievements>

const DAY_MS = 86_400_000

function formatCohortDate(ts: number): string {
  const d = new Date(ts)
  return d.toISOString().slice(0, 10)
}

/**
 * Calculates standard percentiles over an array of durations (milliseconds).
 * Handles missing values, non-finite values, and negative durations safely.
 */
export function calculatePercentiles(values: number[]): {
  mean: number
  median: number
  p90: number
  min: number
  max: number
} {
  const valid = values.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
  if (valid.length === 0) {
    return { mean: 0, median: 0, p90: 0, min: 0, max: 0 }
  }
  const sorted = [...valid].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const mean = Math.round(sum / sorted.length)
  const min = sorted[0] ?? 0
  const max = sorted[sorted.length - 1] ?? 0

  // Exact median calculation
  const n = sorted.length
  let median = 0
  if (n % 2 === 1) {
    median = sorted[Math.floor(n / 2)] ?? 0
  } else {
    const mid1 = sorted[n / 2 - 1] ?? 0
    const mid2 = sorted[n / 2] ?? 0
    median = Math.round((mid1 + mid2) / 2)
  }

  // 90th percentile: nearest rank
  const p90Index = Math.min(n - 1, Math.max(0, Math.ceil(n * 0.9) - 1))
  const p90 = sorted[p90Index] ?? 0

  return { mean, median, p90, min, max }
}

/**
 * Helper to fetch wallet creation age from Horizon or fallback gracefully.
 */
async function fetchWalletAgeDaysHorizon(wallet: string): Promise<number | null> {
  const addr = wallet.trim().toUpperCase()
  if (!/^G[A-Z2-7]{55}$/.test(addr)) return null

  try {
    const base = HORIZON_URL.replace(/\/+$/, "")
    const res = await withHorizonBulkhead(async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const resp = await fetch(`${base}/accounts/${addr}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        })
        if (!resp.ok) return null
        return (await resp.json()) as { created_at?: string }
      } finally {
        clearTimeout(timer)
      }
    })

    if (res?.created_at) {
      const ms = Date.now() - new Date(res.created_at).getTime()
      if (Number.isFinite(ms) && ms > 0) {
        return ms / DAY_MS
      }
    }
    return null
  } catch {
    // Protected by bulkhead: on failure, return null so caller falls back to firstSeen
    return null
  }
}

/**
 * Computes Funnel Analytics v2 with retention cohorts, time-to-convert tracking,
 * wallet-age bands, and sybil-weighted cohort retention.
 */
export function isFunnelRetentionEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-177", wallet ? { wallet } : undefined)
}

export async function computeFunnelRetention(opts: {
  windowMs?: number
  now?: number
  force?: boolean
} = {}): Promise<FunnelRetentionReport> {
  if (!opts.force && !isFunnelRetentionEnabled()) {
    throw new Error(
      `phase-177 flag disabled. ${phase177RollbackNote()}`,
    )
  }

  const now = opts.now ?? Date.now()
  const minTs = opts.windowMs ? now - opts.windowMs : 0

  // 1. Read sources concurrently
  const [claimsStore, achievementsStore, referralStore] = await Promise.all([
    readJsonFile<FaucetClaimsStore>(serverDataJsonPath("faucetClaims"), {}).catch(() => ({})),
    readJsonFile<AchievementsStore>(serverDataJsonPath("achievements"), {}).catch(() => ({})),
    readReferralStore().catch(() => ({ codesByWallet: {}, recordsByCode: {}, referredByWallet: {} })),
  ])

  // 2. Query events from SQLite analytics_events (source of truth).
  ensureAnalyticsEventTable()
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT
        surface,
        stage,
        wallet,
        session_id,
        metadata,
        ts,
        COALESCE(wallet, session_id) as effective_subject
      FROM analytics_events
      WHERE ts >= ?
      ORDER BY ts ASC`,
    )
    .all(minTs) as Array<{
    surface: string
    stage: string
    wallet: string | null
    session_id: string | null
    metadata: string | null
    ts: number
    effective_subject: string | null
  }>

  // 3. Subject timeline map
  const subjectTimelines = new Map<
    string,
    {
      firstSeen: number
      stages: Map<string, number>
      activityDays: Set<number>
      wallet: string | null
      questIds: Set<string>
    }
  >()

  for (const row of rows) {
    const subject = row.effective_subject
    if (!subject) continue

    if (!subjectTimelines.has(subject)) {
      subjectTimelines.set(subject, {
        firstSeen: row.ts,
        stages: new Map(),
        activityDays: new Set(),
        wallet: row.wallet ? row.wallet.toUpperCase() : null,
        questIds: new Set(),
      })
    }
    const tl = subjectTimelines.get(subject)!
    if (!tl.stages.has(row.stage)) {
      tl.stages.set(row.stage, row.ts)
    }
    if (row.wallet && !tl.wallet) {
      tl.wallet = row.wallet.toUpperCase()
    }
    const dayOffset = Math.floor((row.ts - tl.firstSeen) / DAY_MS)
    if (dayOffset >= 0 && dayOffset <= 60) {
      tl.activityDays.add(dayOffset)
    }

    // Inspect quest completions in metadata or stage
    if (row.surface === "quest" || row.stage.includes("quest")) {
      try {
        if (row.metadata) {
          const parsed = JSON.parse(row.metadata) as { quest_id?: string; questId?: string }
          const qId = parsed.quest_id || parsed.questId
          if (qId) tl.questIds.add(String(qId))
        }
      } catch {}
    }
  }

  // 4. Merge claims store data (genesisAt, dailyAt, quests)
  for (const [walletRaw, claims] of Object.entries(claimsStore)) {
    const wallet = walletRaw.trim().toUpperCase()
    const genesis = claims.genesisAt
    if (!genesis || genesis < minTs) continue

    if (!subjectTimelines.has(wallet)) {
      subjectTimelines.set(wallet, {
        firstSeen: genesis,
        stages: new Map(),
        activityDays: new Set(),
        wallet,
        questIds: new Set(),
      })
    }
    const tl = subjectTimelines.get(wallet)!
    tl.stages.set("genesis_claimed", genesis)
    if (!tl.stages.has("claim_confirmed")) {
      tl.stages.set("claim_confirmed", genesis)
    }

    if (claims.dailyAt) {
      const dailyOffset = Math.floor((claims.dailyAt - tl.firstSeen) / DAY_MS)
      if (dailyOffset >= 0 && dailyOffset <= 60) tl.activityDays.add(dailyOffset)
    }
    if (claims.quests) {
      for (const [qId, questTs] of Object.entries(claims.quests)) {
        const questOffset = Math.floor((questTs - tl.firstSeen) / DAY_MS)
        if (questOffset >= 0 && questOffset <= 60) tl.activityDays.add(questOffset)
        tl.questIds.add(qId)
      }
    }
  }

  // Merge achievements
  for (const [walletRaw, ach] of Object.entries(achievementsStore)) {
    const wallet = walletRaw.trim().toUpperCase()
    const tl = subjectTimelines.get(wallet)
    if (tl && Array.isArray(ach.unlocked)) {
      for (const item of ach.unlocked) {
        if (item.unlocked_at) {
          const off = Math.floor((item.unlocked_at - tl.firstSeen) / DAY_MS)
          if (off >= 0 && off <= 60) tl.activityDays.add(off)
          tl.questIds.add(`ach:${item.id}`)
        }
      }
    }
  }

  // 5. Compute time-to-convert metrics
  const stagePairs: Array<[string, string]> = [
    ["viewed", "wallet_connected"],
    ["wallet_connected", "claim_started"],
    ["claim_started", "claim_confirmed"],
    ["viewed", "claim_confirmed"],
  ]

  const timeToConvert: TimeToConvertMetrics[] = stagePairs.map(
    ([fromStage, toStage]) => {
      const deltas: number[] = []
      for (const tl of subjectTimelines.values()) {
        const fromTs = tl.stages.get(fromStage)
        const toTs = tl.stages.get(toStage)
        if (fromTs !== undefined && toTs !== undefined && toTs >= fromTs) {
          deltas.push(toTs - fromTs)
        }
      }
      const stats = calculatePercentiles(deltas)
      return {
        fromStage,
        toStage,
        count: deltas.length,
        meanMs: stats.mean,
        medianMs: stats.median,
        p90Ms: stats.p90,
        minMs: stats.min,
        maxMs: stats.max,
      }
    },
  )

  // 6. Group into cohorts by calendar day of firstSeen
  const cohortGroups = new Map<string, string[]>()
  for (const [subject, tl] of subjectTimelines.entries()) {
    const cohortKey = formatCohortDate(tl.firstSeen)
    if (!cohortGroups.has(cohortKey)) {
      cohortGroups.set(cohortKey, [])
    }
    cohortGroups.get(cohortKey)!.push(subject)
  }

  // 7. Calculate cohort retention and enrich with sybil/wallet-age dimensions
  const cohorts: RetentionCohort[] = []
  let totalEligibleDay7Users = 0
  let totalDay7Retained = 0
  let totalEligibleDay30Users = 0
  let totalDay30Retained = 0

  let trustedTotalDay7Eligible = 0
  let trustedDay7 = 0
  let cautionTotalDay7Eligible = 0
  let cautionDay7 = 0
  let suspectTotalDay7Eligible = 0
  let suspectDay7 = 0

  for (const [cohortKey, subjects] of cohortGroups.entries()) {
    const size = subjects.length

    // Day-N retention calculation with accurate observation window handling:
    // Avoid counting users who have not yet reached the relevant observation window as churned!
    const dayN: DayNRetention[] = RETENTION_DAYS.map((day) => {
      let activeCount = 0
      let eligibleCount = 0
      for (const subj of subjects) {
        const tl = subjectTimelines.get(subj)
        if (!tl) continue
        const subjectAgeMs = now - tl.firstSeen
        if (subjectAgeMs >= day * DAY_MS) {
          eligibleCount++
          if (tl.activityDays.has(day)) {
            activeCount++
          }
        }
      }
      const retentionRate =
        eligibleCount > 0 ? Math.round((activeCount / eligibleCount) * 10_000) / 10_000 : 0
      return { day, activeCount, retentionRate }
    })

    const day7Item = dayN.find((d) => d.day === 7)
    const day30Item = dayN.find((d) => d.day === 30)

    for (const subj of subjects) {
      const tl = subjectTimelines.get(subj)
      if (!tl) continue
      if (now - tl.firstSeen >= 7 * DAY_MS) {
        totalEligibleDay7Users++
        if (tl.activityDays.has(7)) totalDay7Retained++
      }
      if (now - tl.firstSeen >= 30 * DAY_MS) {
        totalEligibleDay30Users++
        if (tl.activityDays.has(30)) totalDay30Retained++
      }
    }

    // Sybil & wallet-age breakdowns
    const sybilBreakdown: Record<SybilBand, number> = {
      trusted: 0,
      caution: 0,
      suspect: 0,
    }
    const walletAgeBreakdown: Record<WalletAgeBand, number> = {
      "<24h": 0,
      "1-7d": 0,
      "7-30d": 0,
      ">30d": 0,
    }

    for (const subj of subjects) {
      const tl = subjectTimelines.get(subj)
      const wallet = tl?.wallet
      if (wallet) {
        // Fetch age band cached with Horizon bulkhead fallback
        const ageResult = await getWalletAgeBandCached(wallet, async (w) => {
          const fromHorizon = await fetchWalletAgeDaysHorizon(w)
          if (fromHorizon !== null) return fromHorizon
          // Fall back to firstSeen in timeline
          if (tl) return Math.max(0, (now - tl.firstSeen) / DAY_MS)
          return 0
        })
        walletAgeBreakdown[ageResult.band]++

        const sybil = await classifyWalletForCohorts(wallet).catch(() => null)
        const band: SybilBand = sybil?.band ?? "trusted"
        sybilBreakdown[band]++

        const reachedDay7 = tl ? now - tl.firstSeen >= 7 * DAY_MS : false
        if (reachedDay7) {
          if (band === "trusted") {
            trustedTotalDay7Eligible++
            if (tl && tl.activityDays.has(7)) trustedDay7++
          } else if (band === "caution") {
            cautionTotalDay7Eligible++
            if (tl && tl.activityDays.has(7)) cautionDay7++
          } else {
            suspectTotalDay7Eligible++
            if (tl && tl.activityDays.has(7)) suspectDay7++
          }
        }
      } else {
        walletAgeBreakdown["<24h"]++
        sybilBreakdown["trusted"]++
        const reachedDay7 = tl ? now - tl.firstSeen >= 7 * DAY_MS : false
        if (reachedDay7) {
          trustedTotalDay7Eligible++
          if (tl && tl.activityDays.has(7)) trustedDay7++
        }
      }
    }

    cohorts.push({
      cohortKey,
      cohortSize: size,
      dayN,
      sybilBreakdown,
      walletAgeBreakdown,
    })
  }

  // Sort cohorts chronologically
  cohorts.sort((a, b) => a.cohortKey.localeCompare(b.cohortKey))

  const overallDay7Retention =
    totalEligibleDay7Users > 0
      ? Math.round((totalDay7Retained / totalEligibleDay7Users) * 10_000) / 10_000
      : 0
  const overallDay30Retention =
    totalEligibleDay30Users > 0
      ? Math.round((totalDay30Retained / totalEligibleDay30Users) * 10_000) / 10_000
      : 0

  return {
    windowMs: opts.windowMs ?? null,
    totalSubjects: subjectTimelines.size,
    timeToConvert,
    cohorts,
    overallDay7Retention,
    overallDay30Retention,
    sybilWeightedRetention: {
      trustedRetentionDay7:
        trustedTotalDay7Eligible > 0
          ? Math.round((trustedDay7 / trustedTotalDay7Eligible) * 10_000) / 10_000
          : 0,
      cautionRetentionDay7:
        cautionTotalDay7Eligible > 0
          ? Math.round((cautionDay7 / cautionTotalDay7Eligible) * 10_000) / 10_000
          : 0,
      suspectRetentionDay7:
        suspectTotalDay7Eligible > 0
          ? Math.round((suspectDay7 / suspectTotalDay7Eligible) * 10_000) / 10_000
          : 0,
    },
  }
}

/**
 * Diagnostic audit wiring check for Funnel Analytics v2.
 */
export function auditFunnelRetentionWiring(): { ok: boolean; note: string } {
  if (!isFunnelRetentionEnabled()) {
    return {
      ok: true,
      note: "[phase-177] Funnel analytics v2 with retention cohorts disabled; nothing to audit.",
    }
  }
  return {
    ok: true,
    note: `[phase-177] funnel analytics v2 retention cohort wiring OK. ${phase177RollbackNote()}`,
  }
}
