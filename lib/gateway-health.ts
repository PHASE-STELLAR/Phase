/**
 * Gateway health dashboard with latency scoring — phase-121
 *
 * Operators cannot see which gateway is slow. This module provides
 * per-gateway latency tracking, scoring, and a dashboard payload.
 *
 * Feature flag: phase-121 (NEXT_PUBLIC_FEATURE_PHASE_121 / FEATURE_PHASE_121)
 * Rollback: unset flag → dashboard route returns 404/disabled, protocol falls back
 *           to static gateway list. No persistent state to revert.
 */

import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const GatewayHealthEntrySchema = z.object({
  gateway: z.string().url(),
  totalRequests: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failCount: z.number().int().min(0),
  avgLatencyMs: z.number().min(0),
  p95LatencyMs: z.number().min(0),
  lastLatencyMs: z.number().min(0),
  lastStatus: z.enum(["ok", "fail", "unknown"]),
  lastCheckedAt: z.string().datetime().nullable(),
  score: z.number().min(0).max(100),
  uptime: z.number().min(0).max(1),
})

export type GatewayHealthEntry = z.infer<typeof GatewayHealthEntrySchema>

export type GatewayHealthSnapshot = {
  enabled: boolean
  updatedAt: string
  gateways: GatewayHealthEntry[]
  bestGateway: string | null
  worstGateway: string | null
}

type InternalSample = { latencyMs: number; ok: boolean; at: number }

const MAX_SAMPLES_PER_GATEWAY = 50
const SCORE_LATENCY_WEIGHT = 0.6
const SCORE_UPTIME_WEIGHT = 0.4

// In-memory store (per-process). For multi-instance, this is best-effort; durable
// persistence can be added via PHASE_SERVER_DATA_DIR if needed.
const samples = new Map<string, InternalSample[]>()
const lastStatus = new Map<string, { ok: boolean; latencyMs: number; at: number }>()

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0
}

function scoreFor(latencies: number[], uptime: number): number {
  if (latencies.length === 0) return 50
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
  // Map avg latency to 0-100: 0ms=100, 500ms=80, 2000ms=40, 5000ms=10, 8000ms=0
  let latencyScore: number
  if (avg <= 200) latencyScore = 100 - (avg / 200) * 10 // 90-100
  else if (avg <= 1000) latencyScore = 90 - ((avg - 200) / 800) * 30 // 60-90
  else if (avg <= 4000) latencyScore = 60 - ((avg - 1000) / 3000) * 40 // 20-60
  else latencyScore = Math.max(0, 20 - ((avg - 4000) / 4000) * 20) // 0-20

  const uptimeScore = uptime * 100
  const raw = latencyScore * SCORE_LATENCY_WEIGHT + uptimeScore * SCORE_UPTIME_WEIGHT
  return Math.max(0, Math.min(100, Math.round(raw)))
}

function normalizeGateway(gateway: string): string {
  return gateway.trim().replace(/\/+$/, "")
}

export function recordGatewayLatency(gateway: string, latencyMs: number, ok: boolean): void {
  if (!isFeatureEnabled("phase-121") && process.env.NODE_ENV !== "test") {
    // Still record in test; otherwise no-op when flag off to avoid overhead
    return
  }
  const key = normalizeGateway(gateway)
  const list = samples.get(key) ?? []
  list.push({ latencyMs: Math.max(0, latencyMs), ok, at: Date.now() })
  if (list.length > MAX_SAMPLES_PER_GATEWAY) list.shift()
  samples.set(key, list)
  lastStatus.set(key, { ok, latencyMs, at: Date.now() })
}

export function getGatewayHealthSnapshot(): GatewayHealthSnapshot {
  const enabled = isFeatureEnabled("phase-121")
  const entries: GatewayHealthEntry[] = []

  for (const [gateway, list] of samples.entries()) {
    const totalRequests = list.length
    const successCount = list.filter((s) => s.ok).length
    const failCount = totalRequests - successCount
    const uptime = totalRequests > 0 ? successCount / totalRequests : 0
    const latencies = list.filter((s) => s.ok).map((s) => s.latencyMs).sort((a, b) => a - b)
    const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0
    const p95LatencyMs = Math.round(percentile(latencies, 95))
    const last = lastStatus.get(gateway)
    const score = scoreFor(latencies, uptime)

    entries.push({
      gateway,
      totalRequests,
      successCount,
      failCount,
      avgLatencyMs,
      p95LatencyMs,
      lastLatencyMs: last?.latencyMs ?? 0,
      lastStatus: last ? (last.ok ? "ok" : "fail") : "unknown",
      lastCheckedAt: last ? new Date(last.at).toISOString() : null,
      score,
      uptime: Math.round(uptime * 1000) / 1000,
    })
  }

  // Also include known default gateways even if no samples yet (score 50, unknown)
  const { DEFAULT_IPFS_GATEWAYS } = (() => {
    try {
      // Avoid circular import; hardcode fallback
      return { DEFAULT_IPFS_GATEWAYS: ["https://w3s.link/ipfs", "https://dweb.link/ipfs", "https://ipfs.io/ipfs", "https://cloudflare-ipfs.com/ipfs"] as const }
    } catch {
      return { DEFAULT_IPFS_GATEWAYS: [] as const }
    }
  })()
  for (const g of DEFAULT_IPFS_GATEWAYS as readonly string[]) {
    if (!samples.has(g)) {
      entries.push({
        gateway: g,
        totalRequests: 0,
        successCount: 0,
        failCount: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        lastLatencyMs: 0,
        lastStatus: "unknown",
        lastCheckedAt: null,
        score: 50,
        uptime: 0,
      })
    }
  }

  entries.sort((a, b) => b.score - a.score)

  return {
    enabled,
    updatedAt: new Date().toISOString(),
    gateways: entries,
    bestGateway: entries[0]?.gateway ?? null,
    worstGateway: entries.length > 0 ? entries[entries.length - 1]!.gateway : null,
  }
}

export function getGatewayRanking(): string[] {
  return getGatewayHealthSnapshot().gateways
    .filter((g) => g.lastStatus !== "unknown" || g.totalRequests > 0)
    .sort((a, b) => b.score - a.score)
    .map((g) => g.gateway)
}

export function resetGatewayHealth(): void {
  samples.clear()
  lastStatus.clear()
}

// Validation for API query
export const GatewayHealthQuerySchema = z.object({
  sort: z.enum(["score", "latency", "uptime"]).optional().default("score"),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
})

export type GatewayHealthQuery = z.infer<typeof GatewayHealthQuerySchema>
