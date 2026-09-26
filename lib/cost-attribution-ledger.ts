/** Idempotent per-job cost ledger.  The key is the job/step pair, so retries
 * cannot charge the same forge step twice.  Replace the adapter with SQL in
 * production; the semantics intentionally match INSERT ... ON CONFLICT DO NOTHING.
 */
export type CostLedgerEntry = {
  jobId: string
  step: string
  costEstimate: number
  costActual: number
  charged: boolean
}

const entries = new Map<string, CostLedgerEntry>()

export function charge(jobId: string, step: string, cost: number): CostLedgerEntry {
  if (!jobId.trim() || !step.trim() || !Number.isFinite(cost) || cost < 0) {
    throw new Error("jobId, step and non-negative cost are required")
  }
  const key = `${jobId}:${step}`
  const existing = entries.get(key)
  if (existing) return existing
  const entry = { jobId, step, costEstimate: cost, costActual: cost, charged: true }
  entries.set(key, entry)
  return entry
}

export function getCost(jobId: string): number {
  let total = 0
  for (const entry of entries.values()) if (entry.jobId === jobId) total += entry.costActual
  return Number(total.toFixed(9))
}

export function getEntries(jobId?: string): CostLedgerEntry[] {
  return [...entries.values()].filter((entry) => !jobId || entry.jobId === jobId)
}

export function resetCostLedger(): void { entries.clear() }

export const costAttributionLedger = {
  charge,
  getCost,
  getEntries,
  reset: resetCostLedger,
}
