/**
 * IPFS timeout fallback chain — phase-123
 *
 * One slow gateway stalls the whole read. This module provides a timeout-aware
 * fallback chain across providers with structured errors and per-gateway latency
 * tracking (consumed by gateway-health when phase-121 is enabled).
 *
 * Feature flag: phase-123 (NEXT_PUBLIC_FEATURE_PHASE_123 / FEATURE_PHASE_123)
 * Rollback: unset flag → falls back to legacy single-timeout sequential loop.
 *
 * Providers default to PHASE IPFS gateways; override via NEXT_PUBLIC_PHASE_IPFS_GATEWAYS (comma-separated).
 */

import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const DEFAULT_IPFS_GATEWAYS = [
  "https://w3s.link/ipfs",
  "https://dweb.link/ipfs",
  "https://ipfs.io/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
] as const

export const IpfsFallbackConfigSchema = z.object({
  gateways: z.array(z.string().url()).min(1).max(8),
  timeoutMs: z.number().int().min(500).max(30000),
  retriesPerGateway: z.number().int().min(0).max(2).default(0),
  concurrency: z.number().int().min(1).max(4).default(1),
})

export type IpfsFallbackConfig = z.infer<typeof IpfsFallbackConfigSchema>

export type IpfsFetchResult =
  | { ok: true; gateway: string; bytes: ArrayBuffer; contentType: string; latencyMs: number; attempts: number }
  | { ok: false; error: string; attempts: number; perGateway: Array<{ gateway: string; error: string; latencyMs: number }> }

export type IpfsFetchOptions = {
  config?: Partial<IpfsFallbackConfig>
  signal?: AbortSignal
  headers?: Record<string, string>
}

function parseEnvGateways(): string[] | null {
  const raw = (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_PHASE_IPFS_GATEWAYS?.trim() : "") ?? ""
  if (!raw) return null
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\//i.test(s))
    .map((s) => (s.endsWith("/ipfs") ? s : `${s}/ipfs`))
  return parts.length > 0 ? parts : null
}

export function resolveIpfsFallbackConfig(overrides: Partial<IpfsFallbackConfig> = {}): IpfsFallbackConfig {
  const envGateways = parseEnvGateways()
  const gateways = overrides.gateways ?? envGateways ?? [...DEFAULT_IPFS_GATEWAYS]
  const timeoutMs = overrides.timeoutMs ?? (isFeatureEnabled("phase-123") ? 4000 : 8000)
  const retriesPerGateway = overrides.retriesPerGateway ?? 0
  const concurrency = overrides.concurrency ?? 1

  const parsed = IpfsFallbackConfigSchema.safeParse({ gateways, timeoutMs, retriesPerGateway, concurrency })
  if (!parsed.success) {
    // Fallback to safe defaults on validation failure
    return { gateways: [...DEFAULT_IPFS_GATEWAYS], timeoutMs: 4000, retriesPerGateway: 0, concurrency: 1 }
  }
  return parsed.data
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException(`Timeout after ${ms}ms`, "TimeoutError")), ms)
  const cancel = () => clearTimeout(timer)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return { signal: controller.signal, cancel }
}

export async function fetchIpfsWithFallback(
  ipfsPath: string,
  opts: IpfsFetchOptions = {},
): Promise<IpfsFetchResult> {
  const cleanPath = ipfsPath.replace(/^\/+/, "").trim()
  if (!cleanPath) {
    return { ok: false, error: "Empty IPFS path", attempts: 0, perGateway: [] }
  }

  const config = resolveIpfsFallbackConfig(opts.config)
  const perGateway: Array<{ gateway: string; error: string; latencyMs: number }> = []
  let attempts = 0

  // Sequential fallback (concurrency=1) ensures one slow gateway doesn't block parallel burst.
  // When concurrency>1 is configured, we race a window of gateways.
  if (config.concurrency === 1) {
    for (const base of config.gateways) {
      const url = `${base.replace(/\/+$/, "")}/${cleanPath}`
      let gatewayAttempts = 0
      while (gatewayAttempts <= config.retriesPerGateway) {
        gatewayAttempts++
        attempts++
        const start = Date.now()
        const { signal, cancel } = withTimeout(opts.signal, config.timeoutMs)
        try {
          const res = await fetch(url, { signal, headers: { Accept: "*/*", ...(opts.headers ?? {}) }, cache: "no-store" as RequestCache })
          cancel()
          const latencyMs = Date.now() - start
          if (!res.ok) {
            perGateway.push({ gateway: base, error: `HTTP ${res.status}`, latencyMs })
            break // try next gateway
          }
          const contentType = res.headers.get("content-type") ?? "application/octet-stream"
          const bytes = await res.arrayBuffer()
          // Optional hook for gateway-health (best-effort dynamic import to avoid circular dep)
          try {
            const mod = await import("@/lib/gateway-health").catch(() => null)
            if (mod && typeof mod.recordGatewayLatency === "function") {
              mod.recordGatewayLatency(base, latencyMs, true)
            }
          } catch { /* ignore */ }
          return { ok: true, gateway: base, bytes, contentType, latencyMs, attempts }
        } catch (e) {
          cancel()
          const latencyMs = Date.now() - start
          const msg = e instanceof Error ? e.message : String(e)
          const isTimeout = msg.toLowerCase().includes("timeout") || (e as DOMException)?.name === "TimeoutError"
          perGateway.push({ gateway: base, error: isTimeout ? `timeout@${config.timeoutMs}ms` : msg.slice(0, 200), latencyMs })
          try {
            const mod = await import("@/lib/gateway-health").catch(() => null)
            if (mod && typeof mod.recordGatewayLatency === "function") {
              mod.recordGatewayLatency(base, latencyMs, false)
            }
          } catch { /* ignore */ }
          if (opts.signal?.aborted) {
            return { ok: false, error: `Aborted: ${msg}`, attempts, perGateway }
          }
          // retry same gateway if retries left, else move to next
          if (gatewayAttempts <= config.retriesPerGateway) continue
          break
        }
      }
    }
    return { ok: false, error: "All IPFS gateways failed or timed out", attempts, perGateway }
  }

  // Concurrent window fallback (phase-123 enabled advanced path)
  // Race N gateways at a time; as soon as one succeeds, abort others.
  for (let i = 0; i < config.gateways.length; i += config.concurrency) {
    const window = config.gateways.slice(i, i + config.concurrency)
    const ac = new AbortController()
    if (opts.signal) {
      const sig = opts.signal
      if (sig.aborted) ac.abort((sig as AbortSignal & { reason?: unknown }).reason)
      else sig.addEventListener("abort", () => ac.abort((sig as AbortSignal & { reason?: unknown }).reason), { once: true })
    }

    const results = await Promise.all(
      window.map(async (base) => {
        const url = `${base.replace(/\/+$/, "")}/${cleanPath}`
        const start = Date.now()
        attempts++
        const { signal, cancel } = withTimeout(ac.signal, config.timeoutMs)
        try {
          const res = await fetch(url, { signal, headers: { Accept: "*/*", ...(opts.headers ?? {}) }, cache: "no-store" as RequestCache })
          cancel()
          const latencyMs = Date.now() - start
          if (!res.ok) {
            perGateway.push({ gateway: base, error: `HTTP ${res.status}`, latencyMs })
            return null
          }
          const contentType = res.headers.get("content-type") ?? "application/octet-stream"
          const bytes = await res.arrayBuffer()
          return { gateway: base, bytes, contentType, latencyMs } as const
        } catch (e) {
          cancel()
          const latencyMs = Date.now() - start
          const msg = e instanceof Error ? e.message : String(e)
          perGateway.push({ gateway: base, error: msg.slice(0, 200), latencyMs })
          return null
        }
      }),
    )
    const winner = results.find((r): r is NonNullable<typeof r> => r != null)
    if (winner) {
      ac.abort(new DOMException("Winner found", "AbortError"))
      return { ok: true, ...winner, attempts }
    }
  }

  return { ok: false, error: "All IPFS gateways failed or timed out (concurrent)", attempts, perGateway }
}

// Convenience: validate ipfsPath
export const IpfsPathSchema = z.string().min(4).max(512).regex(/^[A-Za-z0-9._\/-]+$/, "Invalid IPFS path characters")

export function isIpfsFallbackEnabled(): boolean {
  return isFeatureEnabled("phase-123")
}
