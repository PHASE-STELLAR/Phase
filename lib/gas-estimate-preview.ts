/**
 * phase-256: Gas estimate preview before wallet signing (#709).
 *
 * Simulates a Soroban/Stellar transaction and derives a bounded fee/resource
 * estimate with:
 * - canonical input digest so input changes invalidate stale estimates
 * - explicit staleness timestamp (`simulatedAt` + `GAS_ESTIMATE_TTL_MS`)
 * - bounded fee clamping (`MIN_GAS_FEE_STROOPS` .. `MAX_GAS_FEE_STROOPS`)
 * - honest fallback when live simulation fails (never presented as a guarantee)
 * - `phase-256` feature flag gate (flag off = no preview step)
 *
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_256 / FEATURE_PHASE_256 — signing
 * modal shows no estimate.
 */

import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  calculateGasEstimatePreview,
  type GasEstimateOperation,
} from "@/lib/phase-nft-metadata-build"

export const GAS_ESTIMATE_TTL_MS = 30_000
export const MIN_GAS_FEE_STROOPS = 100
export const MAX_GAS_FEE_STROOPS = 50_000_000 // 5 XLM hard upper bound for preview clamping
export const DEFAULT_BUFFER_MULTIPLIER = 1.2

export function isGasEstimatePreviewEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-256", wallet ? { wallet } : undefined)
}

export function gasEstimatePreviewRollbackNote(): string {
  return "Rollback phase-256: unset NEXT_PUBLIC_FEATURE_PHASE_256 / FEATURE_PHASE_256. Signing modal shows no estimate."
}

export const GasSimulationInputSchema = z.object({
  operationType: z.enum([
    "create_listing",
    "cancel_listing",
    "accept_offer",
    "mint_token",
    "transfer_nft",
    "update_price",
  ]),
  xdr: z.string().optional(),
  contractId: z.string().optional(),
  payloadSizeBytes: z.number().int().min(0).max(1_048_576).default(512),
  bufferedMultiplier: z.number().min(1.0).max(3.0).default(DEFAULT_BUFFER_MULTIPLIER),
  params: z.record(z.string(), z.unknown()).optional(),
})

export type GasSimulationInput = z.input<typeof GasSimulationInputSchema>

export type GasSimulationRawResult = {
  baseFeeStroops?: number
  minResourceFeeStroops?: number
  simulatedInstructions?: number
}

export type GasSimulatorFn = (
  input: z.infer<typeof GasSimulationInputSchema>,
) => Promise<GasSimulationRawResult>

export type WalletGasEstimatePreview = {
  enabled: true
  status: "simulated" | "fallback"
  isGuarantee: false
  inputDigest: string
  operationType: GasEstimateOperation
  baseFeeStroops: number
  resourceFeeStroops: number
  estimatedFeeStroops: number
  minFeeStroops: number
  maxFeeStroops: number
  totalFeeXlm: string
  simulatedAt: number
  ttlMs: number
  fallbackReason?: string
}

function canonicalSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSort)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonicalSort(v)
    }
    return out
  }
  return value
}

/**
 * Pure-TS deterministic 64-bit FNV-1a hex digest (browser + Node safe) for
 * detecting transaction input changes without pulling Node-only crypto.
 */
export function computeGasInputDigest(input: GasSimulationInput): string {
  const canonical = JSON.stringify(canonicalSort(input))
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= c + i
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
}

function clampStroops(value: number): number {
  if (!Number.isFinite(value)) return MIN_GAS_FEE_STROOPS
  return Math.max(MIN_GAS_FEE_STROOPS, Math.min(MAX_GAS_FEE_STROOPS, Math.ceil(value)))
}

function formatXlm(stroops: number): string {
  return (stroops / 10_000_000).toFixed(7)
}

/**
 * Returns `true` when the estimate's age exceeds `ttlMs` (default 30s).
 */
export function isGasEstimateStale(
  estimate: Pick<WalletGasEstimatePreview, "simulatedAt" | "ttlMs">,
  nowMs = Date.now(),
): boolean {
  return nowMs - estimate.simulatedAt >= estimate.ttlMs
}

export function gasEstimateAgeSeconds(
  estimate: Pick<WalletGasEstimatePreview, "simulatedAt">,
  nowMs = Date.now(),
): number {
  return Math.max(0, Math.floor((nowMs - estimate.simulatedAt) / 1000))
}

/**
 * Simulate a transaction and derive a bounded fee/resource estimate.
 * Returns `null` when `phase-256` is disabled (unless `opts.force` is true).
 * Never throws on simulation failure: returns an honest `status: "fallback"`
 * bounded estimate so the user sees transparent uncertainty before signing.
 */
export async function simulateGasEstimate(
  rawInput: GasSimulationInput,
  opts: {
    wallet?: string
    nowMs?: number
    ttlMs?: number
    force?: boolean
    simulator?: GasSimulatorFn
  } = {},
): Promise<WalletGasEstimatePreview | null> {
  if (!opts.force && !isGasEstimatePreviewEnabled(opts.wallet)) {
    return null
  }

  const parsed = GasSimulationInputSchema.parse(rawInput)
  const nowMs = opts.nowMs ?? Date.now()
  const ttlMs = opts.ttlMs ?? GAS_ESTIMATE_TTL_MS
  const inputDigest = computeGasInputDigest(parsed)

  const deterministicBaseline = calculateGasEstimatePreview(
    {
      operationType: parsed.operationType,
      payloadSizeBytes: parsed.payloadSizeBytes,
      contractId: parsed.contractId,
      bufferedMultiplier: parsed.bufferedMultiplier,
    },
    { force: true },
  )

  if (!opts.simulator) {
    const minFeeStroops = clampStroops(
      deterministicBaseline.baseFeeStroops + deterministicBaseline.resourceFeeStroops,
    )
    const maxFeeStroops = clampStroops(deterministicBaseline.totalFeeStroops)
    return {
      enabled: true,
      status: "simulated",
      isGuarantee: false,
      inputDigest,
      operationType: parsed.operationType,
      baseFeeStroops: clampStroops(deterministicBaseline.baseFeeStroops),
      resourceFeeStroops: clampStroops(deterministicBaseline.resourceFeeStroops),
      estimatedFeeStroops: maxFeeStroops,
      minFeeStroops,
      maxFeeStroops,
      totalFeeXlm: formatXlm(maxFeeStroops),
      simulatedAt: nowMs,
      ttlMs,
    }
  }

  try {
    const sim = await opts.simulator(parsed)
    const baseFeeStroops = clampStroops(sim.baseFeeStroops ?? deterministicBaseline.baseFeeStroops)

    let resourceFeeStroops: number
    if (typeof sim.minResourceFeeStroops === "number" && Number.isFinite(sim.minResourceFeeStroops)) {
      resourceFeeStroops = Math.max(0, Math.min(MAX_GAS_FEE_STROOPS, Math.ceil(sim.minResourceFeeStroops)))
    } else if (typeof sim.simulatedInstructions === "number" && Number.isFinite(sim.simulatedInstructions)) {
      const derived = calculateGasEstimatePreview(
        {
          operationType: parsed.operationType,
          payloadSizeBytes: parsed.payloadSizeBytes,
          simulatedInstructions: Math.max(0, Math.round(sim.simulatedInstructions)),
          bufferedMultiplier: parsed.bufferedMultiplier,
        },
        { force: true },
      )
      resourceFeeStroops = derived.resourceFeeStroops
    } else {
      resourceFeeStroops = deterministicBaseline.resourceFeeStroops
    }

    const rawTotal = clampStroops(baseFeeStroops + resourceFeeStroops)
    const maxFeeStroops = clampStroops(rawTotal * parsed.bufferedMultiplier)
    return {
      enabled: true,
      status: "simulated",
      isGuarantee: false,
      inputDigest,
      operationType: parsed.operationType,
      baseFeeStroops,
      resourceFeeStroops,
      estimatedFeeStroops: maxFeeStroops,
      minFeeStroops: rawTotal,
      maxFeeStroops,
      totalFeeXlm: formatXlm(maxFeeStroops),
      simulatedAt: nowMs,
      ttlMs,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "simulation_failed"
    const minFeeStroops = clampStroops(
      deterministicBaseline.baseFeeStroops + deterministicBaseline.resourceFeeStroops,
    )
    const maxFeeStroops = clampStroops(deterministicBaseline.totalFeeStroops)
    return {
      enabled: true,
      status: "fallback",
      isGuarantee: false,
      inputDigest,
      operationType: parsed.operationType,
      baseFeeStroops: clampStroops(deterministicBaseline.baseFeeStroops),
      resourceFeeStroops: clampStroops(deterministicBaseline.resourceFeeStroops),
      estimatedFeeStroops: maxFeeStroops,
      minFeeStroops,
      maxFeeStroops,
      totalFeeXlm: formatXlm(maxFeeStroops),
      simulatedAt: nowMs,
      ttlMs,
      fallbackReason: reason,
    }
  }
}
