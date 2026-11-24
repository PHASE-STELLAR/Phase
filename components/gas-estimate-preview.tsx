"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { pickCopy, fillCopy, type AppLang } from "@/lib/phase-copy"
import {
  computeGasInputDigest,
  gasEstimateAgeSeconds,
  isGasEstimatePreviewEnabled,
  isGasEstimateStale,
  simulateGasEstimate,
  type GasSimulationInput,
  type GasSimulatorFn,
  type WalletGasEstimatePreview,
} from "@/lib/gas-estimate-preview"

export interface GasEstimatePreviewProps {
  input: GasSimulationInput
  wallet?: string
  lang?: AppLang
  simulator?: GasSimulatorFn
  onEstimateChange?: (estimate: WalletGasEstimatePreview | null) => void
}

export function GasEstimatePreview({
  input,
  wallet,
  lang = "en",
  simulator,
  onEstimateChange,
}: GasEstimatePreviewProps) {
  const enabled = isGasEstimatePreviewEnabled(wallet)
  const copy = pickCopy(lang).gasEstimatePreview
  const inputDigest = useMemo(() => computeGasInputDigest(input), [input])

  const [estimate, setEstimate] = useState<WalletGasEstimatePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const runSimulation = useCallback(async () => {
    if (!enabled) {
      setEstimate(null)
      onEstimateChange?.(null)
      return
    }
    setLoading(true)
    try {
      const next = await simulateGasEstimate(input, { wallet, simulator })
      setEstimate(next)
      setNowMs(Date.now())
      onEstimateChange?.(next)
    } finally {
      setLoading(false)
    }
  }, [enabled, input, wallet, simulator, onEstimateChange])

  // Re-simulate automatically whenever transaction inputs change
  useEffect(() => {
    void runSimulation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, inputDigest, wallet])

  // Tick every 5s to keep staleness timestamp accurate
  useEffect(() => {
    if (!enabled || !estimate) return
    const id = setInterval(() => setNowMs(Date.now()), 5000)
    return () => clearInterval(id)
  }, [enabled, estimate])

  if (!enabled) return null

  const stale = estimate ? isGasEstimateStale(estimate, nowMs) : false
  const ageSeconds = estimate ? gasEstimateAgeSeconds(estimate, nowMs) : 0

  return (
    <div
      data-testid="gas-estimate-preview"
      className="rounded-lg border border-zinc-800 bg-zinc-950/90 p-3 text-xs text-zinc-200 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold tracking-wide text-zinc-100">{copy.title}</span>
        <button
          type="button"
          onClick={() => void runSimulation()}
          disabled={loading}
          className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? copy.simulatingLabel : copy.refreshAction}
        </button>
      </div>

      {estimate && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">{copy.estimatedFeeLabel}</span>
            <span className="font-mono font-medium text-violet-300">
              {estimate.totalFeeXlm} XLM ({estimate.estimatedFeeStroops} stroops)
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <span>{copy.maxBoundLabel}</span>
            <span className="font-mono">{estimate.maxFeeStroops} stroops</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {copy.baseFeeLabel}: {estimate.baseFeeStroops} · {copy.resourceFeeLabel}:{" "}
              {estimate.resourceFeeStroops}
            </span>
            <span>{fillCopy(copy.updatedAtLabel, { seconds: ageSeconds })}</span>
          </div>
        </div>
      )}

      {stale && (
        <div
          data-testid="gas-estimate-stale"
          className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300"
        >
          {copy.staleBadge}
        </div>
      )}

      {estimate?.status === "fallback" && (
        <div
          data-testid="gas-estimate-fallback"
          className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200"
        >
          {fillCopy(copy.fallbackNotice, { reason: estimate.fallbackReason ?? "unavailable" })}
        </div>
      )}

      <p className="text-[11px] text-zinc-500">{copy.disclaimer}</p>
    </div>
  )
}
