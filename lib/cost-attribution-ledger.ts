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

/**
 * AI steps that may be charged (phase-142/143/146/147). A closed set, so the
 * ledger's step label stays bounded the same way the security counters are.
 */
export const AI_COST_STEPS = [
  "curator.wall_text",
  "pricing.rationale",
  "moderation.classify",
  "quest_arc.narrative",
] as const
export type AiCostStep = (typeof AI_COST_STEPS)[number]

function unitPrice(envKey: string, fallback: number): number {
  const n = Number(process.env[envKey])
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Estimated cost of one text-model call. Characters, not tokens, because the
 * pipeline never sees a tokenizer; prices are per 1k chars and come from env so
 * treasury can track the provider's price sheet without a deploy.
 */
export function estimateAiTextCost(inputChars: number, outputChars: number): number {
  const inPrice = unitPrice("PHASE_AI_COST_PER_1K_INPUT_CHARS", 0.00002)
  const outPrice = unitPrice("PHASE_AI_COST_PER_1K_OUTPUT_CHARS", 0.00008)
  const cost = (Math.max(0, inputChars) / 1000) * inPrice + (Math.max(0, outputChars) / 1000) * outPrice
  return Number(cost.toFixed(9))
}

/** Idempotent per (jobId, step): a retried AI call for the same job is charged once. */
export function chargeAiStep(
  jobId: string,
  step: AiCostStep,
  inputChars: number,
  outputChars: number,
): CostLedgerEntry {
  return charge(jobId, step, estimateAiTextCost(inputChars, outputChars))
}

export const costAttributionLedger = {
  charge,
  chargeAiStep,
  getCost,
  getEntries,
  reset: resetCostLedger,
}

// ── Spikes 672-675 (flag-gated): job-step cost keys for new flows ──
// charge()/getCost() semantics unchanged; these closed-string keys keep new flows
// attributable without unbounded label cardinality.
export const SPIKE_COST_STEPS = ["edition_reserve", "split_fanout", "drop_ticket", "dutch_quote"] as const;
export type SpikeCostStep = (typeof SPIKE_COST_STEPS)[number];
export function spikeCostKey(jobId: string, step: SpikeCostStep): string {
  return `${jobId}:${step}`;
}