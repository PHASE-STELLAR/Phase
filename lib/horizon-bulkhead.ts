/** Shared process-local concurrency gate for Horizon/Soroban reads. */

export const HORIZON_BULKHEAD_LIMIT = 5

type Waiter = () => void
let inFlight = 0
const waiters: Waiter[] = []
let batch429Count = 0

export type HorizonBulkheadMetrics = {
  inFlight: number
  queued: number
  limit: number
  horizon_429_batch: number
}

function statusOf(error: unknown): number | undefined {
  const value = error as { status?: unknown; response?: { status?: unknown } } | null
  if (typeof value?.status === "number") return value.status
  if (typeof value?.response?.status === "number") return value.response.status
  return undefined
}

export function isHorizon429(error: unknown): boolean {
  return statusOf(error) === 429
}

export function getHorizonBulkheadMetrics(): HorizonBulkheadMetrics {
  return { inFlight, queued: waiters.length, limit: HORIZON_BULKHEAD_LIMIT, horizon_429_batch: batch429Count }
}

export function resetHorizonBulkheadMetrics(): void {
  batch429Count = 0
}

async function acquire(): Promise<() => void> {
  if (inFlight >= HORIZON_BULKHEAD_LIMIT) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  inFlight += 1
  let released = false
  return () => {
    if (released) return
    released = true
    inFlight -= 1
    waiters.shift()?.()
  }
}

export async function withHorizonBulkhead<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquire()
  try {
    return await operation()
  } catch (error) {
    if (isHorizon429(error)) batch429Count += 1
    throw error
  } finally {
    release()
  }
}

// ── Spike 672: admission note — timed-drop bursts reuse withHorizonBulkhead (limit 5)
// so thundering-herd mint traffic queues instead of saturating Horizon. No limit change.
export function spikeBulkheadNote(): string {
  return "drop mint traffic must go through withHorizonBulkhead; never raise HORIZON_BULKHEAD_LIMIT for drops";
}

// ── Spike 611: wallet-age classification with in-memory bulkhead cache ──────
export type WalletAgeBand = "<24h" | "1-7d" | "7-30d" | ">30d"

export function classifyWalletAgeBand(ageDays: number): WalletAgeBand {
  if (ageDays < 1) return "<24h"
  if (ageDays <= 7) return "1-7d"
  if (ageDays <= 30) return "7-30d"
  return ">30d"
}

type WalletAgeCacheEntry = {
  ageDays: number
  band: WalletAgeBand
  cachedAt: number
}

const WALLET_AGE_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const walletAgeCache = new Map<string, WalletAgeCacheEntry>()

/**
 * Returns wallet age in days and its age band, cached in-memory through the
 * Horizon bulkhead to protect Horizon from rate-limits during cohort scans.
 */
export async function getWalletAgeBandCached(
  wallet: string,
  fetchAgeDays: (w: string) => Promise<number | null>,
): Promise<{ ageDays: number; band: WalletAgeBand }> {
  const normalized = wallet.trim().toUpperCase()
  const now = Date.now()
  const hit = walletAgeCache.get(normalized)
  if (hit && now - hit.cachedAt < WALLET_AGE_CACHE_TTL_MS) {
    return { ageDays: hit.ageDays, band: hit.band }
  }

  let ageDays = 0
  try {
    const fetched = await withHorizonBulkhead(() => fetchAgeDays(normalized))
    if (fetched !== null && Number.isFinite(fetched)) {
      ageDays = Math.max(0, fetched)
    }
  } catch {
    // Fall back to 0 on failure
    ageDays = 0
  }

  const band = classifyWalletAgeBand(ageDays)
  walletAgeCache.set(normalized, { ageDays, band, cachedAt: now })
  return { ageDays, band }
}

export function resetWalletAgeCacheForTests(): void {
  walletAgeCache.clear()
}
