"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

type HealthEntry = {
  gateway: string
  avgLatencyMs: number
  p95LatencyMs: number
  score: number
  uptime: number
  lastStatus: string
  totalRequests: number
  successCount: number
  failCount: number
}

type Snapshot = {
  enabled: boolean
  updatedAt: string
  bestGateway: string | null
  worstGateway: string | null
  gateways: HealthEntry[]
}

function isPhase121Enabled(): boolean {
  const v = (typeof process !== "undefined" ? (process.env.NEXT_PUBLIC_FEATURE_PHASE_121 ?? "") : "")?.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

function scoreColor(score: number): string {
  if (score >= 80) return "text-emerald-400 border-emerald-500/50 bg-emerald-950/30"
  if (score >= 50) return "text-amber-400 border-amber-500/50 bg-amber-950/30"
  return "text-red-400 border-red-500/50 bg-red-950/30"
}

export function GatewayHealthDashboard({ className }: { className?: string }) {
  const [data, setData] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enabled = isPhase121Enabled()

  async function fetchHealth() {
    if (!enabled) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/phase-nft/custodian-release", { headers: { Accept: "application/json" }, cache: "no-store" })
      if (res.status === 404) {
        setError("Dashboard disabled (flag off)")
        setData(null)
        return
      }
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`)
      }
      const json = (await res.json()) as Snapshot & { ok?: boolean }
      if (json && "gateways" in json) setData(json as Snapshot)
      else setError("Invalid response")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!enabled) return
    void fetchHealth()
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchHealth()
    }, 15000)
    return () => window.clearInterval(id)
  }, [enabled])

  if (!enabled) return null

  return (
    <div className={cn("rounded-sm border border-zinc-800 bg-zinc-900/40 p-3", className)}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-300">Gateway Health · phase-121</h3>
        <button
          type="button"
          onClick={() => void fetchHealth()}
          disabled={loading}
          className="rounded-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-300 hover:border-violet-500/50 disabled:opacity-50"
        >
          {loading ? "Sync…" : "Refresh"}
        </button>
      </div>
      {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
      {!data && !error ? <p className="text-[11px] text-zinc-500">{loading ? "Loading…" : "No data yet"}</p> : null}
      {data ? (
        <>
          <p className="mb-2 text-[10px] text-zinc-500">Updated {new Date(data.updatedAt).toLocaleTimeString()} · best: {data.bestGateway ? new URL(data.bestGateway).host : "—"} · worst: {data.worstGateway ? new URL(data.worstGateway).host : "—"}</p>
          <div className="space-y-1.5">
            {data.gateways.map((g) => (
              <div key={g.gateway} className={cn("flex items-center justify-between rounded-sm border px-2 py-1.5", scoreColor(g.score))}>
                <span className="truncate pr-2 text-[10px] font-mono">{g.gateway.replace("https://", "").replace("/ipfs", "")}</span>
                <span className="shrink-0 text-[10px] font-bold">{g.score} · {g.avgLatencyMs}ms · {Math.round(g.uptime * 100)}% · {g.lastStatus}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_121 and restart. No ledger change.</p>
        </>
      ) : null}
    </div>
  )
}
