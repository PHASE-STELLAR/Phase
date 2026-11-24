/**
 * Soroban JSON-RPC batching + shared read cache (phase-209, issue #517
 * follow-up to phase-158).
 *
 * phase-158 coalesced identical reads inside one process but explicitly had no
 * JSON-RPC array batching and no cross-process cache, so separate serverless
 * instances still duplicated reads. This module adds:
 *   - a JSON-RPC array transport with per-call error isolation (one bad
 *     sub-call never rejects its siblings);
 *   - a `SharedRpcCache` interface with TTL and stale-on-error, plus an
 *     in-memory implementation for the single-process fallback and a KV/Redis
 *     adapter for multi-instance deployments;
 *   - a read-through coalescer that shares one in-flight promise locally and
 *     one cached value across instances.
 *
 * Flag phase-209 off → every caller goes straight to its original loader.
 * Rollback: unset the flag; no persisted state is required (the KV namespace,
 * if configured, simply stops being read).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"

export type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export type JsonRpcError = { code: number; message: string; data?: unknown }
export type JsonRpcResponse = {
  jsonrpc?: string
  id: number | string
  result?: unknown
  error?: JsonRpcError
}

export type RpcCallResult<T> = { ok: true; value: T } | { ok: false; error: JsonRpcError }

export function isRpcBatchingEnabled(): boolean {
  return isFeatureEnabled("phase-209")
}

export function rpcBatchingRollbackNote(): string {
  return "Rollback phase-209: unset NEXT_PUBLIC_FEATURE_PHASE_209 / FEATURE_PHASE_209 and restart. Every read uses the original per-call simulateTransaction path; the shared cache namespace is inert."
}

/** Closed counter names this module emits (labels are always absent). */
export const RPC_BATCH_COUNTERS = [
  "rpc_batch_sent",
  "rpc_batch_subcall_failed",
  "rpc_shared_cache_hit",
  "rpc_shared_cache_miss",
  "rpc_shared_cache_stale",
] as const

function asRpcError(error: unknown): JsonRpcError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return error as JsonRpcError
  }
  return { code: -32603, message: error instanceof Error ? error.message : String(error) }
}

/**
 * Correlate a batch response array to the requests. A missing or errored
 * sub-call becomes that call's isolated `ok: false`; siblings are unaffected.
 */
export function resolveBatchResults<T>(
  requests: readonly JsonRpcRequest[],
  responses: readonly JsonRpcResponse[],
): RpcCallResult<T>[] {
  const byId = new Map(responses.map((response) => [response.id, response]))
  return requests.map((request) => {
    const response = byId.get(request.id)
    if (!response) return { ok: false, error: { code: -32603, message: "no response for call" } }
    if (response.error) {
      incSecurityCounter("rpc_batch_subcall_failed")
      return { ok: false, error: response.error }
    }
    return { ok: true, value: response.result as T }
  })
}

export type BatchSend = (requests: readonly JsonRpcRequest[]) => Promise<readonly JsonRpcResponse[]>

export type BatchingRpcTransportOptions = {
  maxBatchSize?: number
}

/**
 * Per-tick JSON-RPC batcher. Calls enqueued in the same microtask tick are sent
 * as one array; each caller receives only its own result/error.
 */
export function createBatchingRpcTransport(
  send: BatchSend,
  options: BatchingRpcTransportOptions = {},
): {
  call<T>(method: string, params?: unknown): Promise<T>
  dispatch(): Promise<void>
} {
  const maxBatchSize = Math.max(1, options.maxBatchSize ?? 20)
  let nextId = 1
  type Pending = {
    request: JsonRpcRequest
    resolve: (value: RpcCallResult<unknown>) => void
  }
  let queue: Pending[] = []
  let scheduled = false

  async function dispatch(): Promise<void> {
    scheduled = false
    const batch = queue
    queue = []
    if (batch.length === 0) return
    let results: RpcCallResult<unknown>[]
    try {
      incSecurityCounter("rpc_batch_sent")
      results = resolveBatchResults(
        batch.map((p) => p.request),
        await send(batch.map((p) => p.request)),
      )
    } catch (error) {
      const failure = asRpcError(error)
      results = batch.map(() => ({ ok: false, error: failure }))
    }
    batch.forEach((pending, i) => pending.resolve(results[i]))
  }

  function call<T>(method: string, params?: unknown): Promise<T> {
    if (!isRpcBatchingEnabled()) {
      const request: JsonRpcRequest = { jsonrpc: "2.0", id: nextId++, method, params }
      return send([request]).then((responses) => {
        const result = resolveBatchResults<T>([request], responses)[0]
        if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
        return result.value
      })
    }
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: nextId++, method, params }
    return new Promise<T>((resolve, reject) => {
      queue.push({
        request,
        resolve: (result) => {
          if (result.ok) resolve(result.value as T)
          else reject(Object.assign(new Error(result.error.message), result.error))
        },
      })
      if (!scheduled) {
        scheduled = true
        void Promise.resolve().then(dispatch)
      }
    })
  }

  return { call, dispatch }
}

// ── Shared cache ────────────────────────────────────────────────────────────

export type CachedRpcValue = { value: unknown; expiresAt: number }

export interface SharedRpcCache {
  read(key: string): Promise<CachedRpcValue | null>
  write(key: string, value: unknown, ttlMs: number): Promise<void>
}

/** Process-local fallback. Identical semantics to the KV adapter, no I/O. */
export function createMemorySharedCache(): SharedRpcCache {
  const entries = new Map<string, CachedRpcValue>()
  return {
    async read(key) {
      return entries.get(key) ?? null
    },
    async write(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    },
  }
}

/** Minimal Redis/Upstash-shaped client; the module takes no KV dependency. */
export interface KvLikeClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  pexpire(key: string, ms: number): Promise<unknown>
}

export function createKvSharedCache(client: KvLikeClient, prefix = "phase:rpc:"): SharedRpcCache {
  return {
    async read(key) {
      const raw = await client.get(`${prefix}${key}`)
      if (!raw) return null
      try {
        return JSON.parse(raw) as CachedRpcValue
      } catch {
        return null
      }
    },
    async write(key, value, ttlMs) {
      const encoded = JSON.stringify({ value, expiresAt: Date.now() + ttlMs })
      await client.set(`${prefix}${key}`, encoded)
      await client.pexpire(`${prefix}${key}`, ttlMs)
    },
  }
}

export type SharedReadOptions = {
  ttlMs?: number
  staleOnError?: boolean
  shared?: SharedRpcCache
}

const DEFAULT_TTL_MS = 5_000
const localInflight = new Map<string, Promise<unknown>>()

/**
 * Read through the shared cache. Concurrent callers in one instance await a
 * single loader; callers in another instance hit the same shared value.
 */
export async function readThroughSharedCache<T>(
  key: string,
  loader: () => Promise<T>,
  options: SharedReadOptions = {},
): Promise<T> {
  if (!isRpcBatchingEnabled()) return loader()

  const shared = options.shared ?? createMemorySharedCache()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = Date.now()

  let cached: CachedRpcValue | null = null
  try {
    cached = await shared.read(key)
  } catch {
    cached = null
  }
  if (cached && cached.expiresAt > now) {
    incSecurityCounter("rpc_shared_cache_hit")
    return cached.value as T
  }
  incSecurityCounter("rpc_shared_cache_miss")

  const pending = localInflight.get(key)
  if (pending) return pending as Promise<T>

  const promise = (async () => {
    try {
      const value = await loader()
      await shared.write(key, value, ttlMs)
      return value
    } catch (error) {
      if (options.staleOnError) {
        let stale: CachedRpcValue | null = null
        try {
          stale = await shared.read(key)
        } catch {
          stale = null
        }
        if (stale && stale.value !== undefined) {
          incSecurityCounter("rpc_shared_cache_stale")
          return stale.value as T
        }
      }
      throw error
    } finally {
      localInflight.delete(key)
    }
  })()
  localInflight.set(key, promise)
  return promise
}

export function resetRpcBatchStateForTests(): void {
  localInflight.clear()
}
