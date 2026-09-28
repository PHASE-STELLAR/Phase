/**
 * phase-131: Quest streak daily-claim multiplier with decay rules.
 *
 * Rewards consecutive daily claims with a escalating multiplier:
 *   Day 1–2:  1.0x (baseline)
 *   Day 3–6:  1.25x
 *   Day 7–13: 1.5x
 *   Day 14–29: 2.0x
 *   Day 30+:  3.0x
 *
 * Decay: if the user misses a day (gap > 24h), the streak resets to 1.
 * A grace window of 24h allows the claim to land within the next calendar
 * day without breaking the streak (i.e. up to 48h gap still counts).
 *
 * Data lives in the existing achievements store (daily_streak counter +
 * last_daily timestamp), so there is zero schema migration.
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_131 / FEATURE_PHASE_131
 * Rollback: unset the flag. Daily rewards revert to their flat amount.
 */

import { getWalletData, checkAndUnlock } from "@/lib/achievement-store"
import { isFeatureEnabled } from "@/lib/feature-flags"

const FLAG: "phase-131" = "phase-131"

export function isStreakMultiplierEnabled(): boolean {
  return isFeatureEnabled(FLAG)
}

const DAY_MS = 86_400_000
const GRACE_WINDOW_MS = DAY_MS // 24h grace on top of the 24h day

const MULTIPLIER_TIERS: Array<{ minDay: number; multiplier: number }> = [
  { minDay: 30, multiplier: 3.0 },
  { minDay: 14, multiplier: 2.0 },
  { minDay: 7, multiplier: 1.5 },
  { minDay: 3, multiplier: 1.25 },
  { minDay: 1, multiplier: 1.0 },
]

export function streakMultiplier(streak: number): number {
  for (const tier of MULTIPLIER_TIERS) {
    if (streak >= tier.minDay) return tier.multiplier
  }
  return 1.0
}

export type StreakInfo = {
  currentStreak: number
  multiplier: number
  lastDailyAt: number | null
  streakActive: boolean
}

/**
 * Read the current streak state for a wallet from the achievements store.
 * Does NOT mutate — purely read-only for the calling route.
 */
export async function getStreakInfo(wallet: string): Promise<StreakInfo> {
  const data = await getWalletData(wallet)
  const now = Date.now()
  const lastDaily = data.last_daily ?? 0
  const streak = data.daily_streak ?? 0

  // Streak is "active" if the last claim was within grace window
  const streakActive = lastDaily > 0 && now - lastDaily < DAY_MS + GRACE_WINDOW_MS

  return {
    currentStreak: streakActive ? streak : 0,
    multiplier: streakMultiplier(streakActive ? streak : 0),
    lastDailyAt: lastDaily || null,
    streakActive,
  }
}

/**
 * Apply the streak multiplier to a base amount (in stroops).
 * Returns the adjusted amount as a string (bigint-safe).
 */
export function applyStreakMultiplier(baseAmountStroops: string, multiplier: number): string {
  const base = BigInt(baseAmountStroops)
  const adjusted = BigInt(Math.round(multiplier * 100))
  const result = (base * adjusted) / 100n
  return result.toString()
}

/**
 * Record a daily claim and return the new streak info.
 * This delegates to the existing achievement-store daily streak logic.
 * Returns the updated streak info so the caller can display/return it.
 */
export async function recordDailyClaim(wallet: string): Promise<StreakInfo> {
  // Trigger the achievement-store streak tracking
  await checkAndUnlock(wallet, { daily_claim: true })
  // Re-read to get the updated values
  return getStreakInfo(wallet)
}
