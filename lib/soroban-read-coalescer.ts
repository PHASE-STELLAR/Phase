/**
 * Soroban read coalescing — partial slice of spike 655 (issue #517).
 *
 * `lib/phase-protocol.ts` builds a fresh `simulateTransaction` per logical
 * read, so a page that asks for the same `get_config` / `balance` / `owner_of`
 * (or the same value twice within one request) produces duplicate JSON-RPC
 * round-trips and multiplies retry storms on 429/502/503/504. This module adds
 * a process-local coalescer that (a) shares one in-flight promise for identical
 * reads and (b) memoizes the result for a short TTL.
 *
 * Scope: read-shape de-duplication only. It does not batch distinct reads into
 * one JSON-RPC array (Soroban has no server-side multi-simulate) and does not
 * touch write preparation, whose footprint must stay ledger-fresh.
 *
 * Feature flag: phase-158. Rollback: unset → callers fall back to uncoalesced
 * reads; only in-memory entries are dropped (no persisted state).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

export type SorobanReadArgs = readonly unknown[]

export type ReadCoalescerMetrics = {
  hits: number
  misses: number
  coalesced: number
  stale_served: number
}

const DEFAULT_TTL_MS = 5_000
const MAX_ENTRIES = 500

type Entry = { value: unknown; expiresAt: number }

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()
const metrics: ReadCoalescerMetrics = { hits: 0, misses: 0, coalesced: 0, stale_served: 0 }

export function isReadCoalescingEnabled(): boolean {
  return isFeatureEnabled("phase-158")
}

/** Stable key for a read, sharing one entry across identical (method, args). */
export function buildReadKey(contractId: string, method: string, args: SorobanReadArgs): string {
  return `${contractId}::${method}::${JSON.stringify(args)}`
}

function getFresh(key: string, now: number): Entry | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now) return null
  return entry
}

function getStale(key: string): unknown | undefined {
  const entry = cache.get(key)
  return entry ? entry.value : undefined
}

function put(key: string, value: unknown, ttlMs: number, now: number): void {
  cache.delete(key)
  cache.set(key, { value, expiresAt: now + ttlMs })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function getReadCoalescerMetrics(): ReadCoalescerMetrics {
  return { ...metrics }
}

export function resetReadCoalescer(): void {
  cache.clear()
  inflight.clear()
  metrics.hits = 0
  metrics.misses = 0
  metrics.coalesced = 0
  metrics.stale_served = 0
}

export type CoalesceOptions = {
  ttlMs?: number
  /** Serve the last cached value if `loader` rejects (stale-on-error). */
  staleOnError?: boolean
}

/**
 * Resolve a Soroban read through the coalescer. Concurrent callers with the
 * same key await a single `loader` invocation; a fresh cached value short-
 * circuits the loader entirely. When disabled, every call hits `loader`.
 */
export async function coalesceSorobanRead<T>(
  contractId: string,
  method: string,
  args: SorobanReadArgs,
  loader: () => Promise<T>,
  options: CoalesceOptions = {},
): Promise<T> {
  if (!isReadCoalescingEnabled()) {
    return loader()
  }

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const key = buildReadKey(contractId, method, args)
  const now = Date.now()

  const fresh = getFresh(key, now)
  if (fresh) {
    metrics.hits += 1
    return fresh.value as T
  }

  const pending = inflight.get(key)
  if (pending) {
    metrics.coalesced += 1
    return pending as Promise<T>
  }

  metrics.misses += 1
  const promise = (async () => {
    try {
      const value = await loader()
      put(key, value, ttlMs, Date.now())
      return value
    } catch (error) {
      if (options.staleOnError) {
        const stale = getStale(key)
        if (stale !== undefined) {
          metrics.stale_served += 1
          return stale as T
        }
      }
      throw error
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}

export function readCoalescerRollbackNote(): string {
  return "Rollback phase-158: unset NEXT_PUBLIC_FEATURE_PHASE_158 / FEATURE_PHASE_158 or set 0/false and restart. No persisted state."
}
