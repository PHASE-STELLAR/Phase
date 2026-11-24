/**
 * Batched key loader — partial slice of spike 656 (issue #518).
 *
 * Explore/world/profile reads issue one `owner_of(id)` simulation per token
 * (N+1). This is a minimal DataLoader-style primitive: callers enqueue keys
 * during a tick and the loader coalesces them into a single `batchFn` call,
 * deduplicates repeated keys, caches resolved values, and chunks by
 * `maxBatchSize`. Wiring a route's existing per-token loop through this loader
 * replaces N round-trips with ceil(N / maxBatchSize).
 *
 * Scope: the coalescing primitive + one batch owner loader. It does not yet
 * push collection filters into an index or add sidecar-level `mget` APIs; those
 * remain spike 656 follow-ups.
 *
 * Feature flag: phase-159. Rollback: unset → callers use their unbatched path;
 * only in-memory caches are dropped (no persisted state).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

export function isOwnerBatchLoaderEnabled(): boolean {
  return isFeatureEnabled("phase-159")
}

type Pending<V> = {
  promise: Promise<V>
  resolve: (value: V) => void
  reject: (error: unknown) => void
}

export type BatchLoader<K, V> = {
  load: (key: K) => Promise<V>
  loadMany: (keys: readonly K[]) => Promise<Array<V | Error>>
  clear: (key: K) => void
  clearAll: () => void
}

export type BatchLoaderOptions = {
  /** Maximum keys per `batchFn` invocation. Default: 100. */
  maxBatchSize?: number
  /** Memoize resolved values across ticks. Default: true. */
  cache?: boolean
}

/**
 * Create a per-tick coalescing loader over `batchFn`, which receives a batch of
 * keys and must return a result array aligned to the input order (an `Error`
 * at a position rejects that key's promise).
 */
export function createBatchLoader<K, V>(
  batchFn: (keys: readonly K[]) => Promise<Array<V | Error>>,
  options: BatchLoaderOptions = {},
): BatchLoader<K, V> {
  const maxBatchSize = Math.max(1, options.maxBatchSize ?? 100)
  const useCache = options.cache ?? true

  const cache = new Map<K, V>()
  const pending = new Map<K, Pending<V>>()
  let queue: K[] = []
  let scheduled = false

  function enqueueDispatch(): void {
    if (scheduled) return
    scheduled = true
    void Promise.resolve().then(dispatch)
  }

  async function runBatch(chunk: K[]): Promise<void> {
    try {
      const results = await batchFn(chunk)
      chunk.forEach((key, index) => {
        const entry = pending.get(key)
        pending.delete(key)
        if (!entry) return
        const result = results[index]
        if (result instanceof Error) {
          entry.reject(result)
        } else {
          if (useCache) cache.set(key, result as V)
          entry.resolve(result as V)
        }
      })
    } catch (error) {
      for (const key of chunk) {
        const entry = pending.get(key)
        pending.delete(key)
        entry?.reject(error)
      }
    }
  }

  async function dispatch(): Promise<void> {
    scheduled = false
    const keys = queue
    queue = []
    for (let i = 0; i < keys.length; i += maxBatchSize) {
      await runBatch(keys.slice(i, i + maxBatchSize))
    }
  }

  function load(key: K): Promise<V> {
    if (useCache && cache.has(key)) {
      return Promise.resolve(cache.get(key) as V)
    }
    const existing = pending.get(key)
    if (existing) return existing.promise

    let resolve!: (value: V) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<V>((res, rej) => {
      resolve = res
      reject = rej
    })
    pending.set(key, { promise, resolve, reject })
    queue.push(key)
    enqueueDispatch()
    return promise
  }

  async function loadMany(keys: readonly K[]): Promise<Array<V | Error>> {
    const settled = await Promise.allSettled(keys.map((key) => load(key)))
    return settled.map((result) =>
      result.status === "fulfilled" ? result.value : (result.reason as Error),
    )
  }

  return {
    load,
    loadMany,
    clear: (key: K) => {
      cache.delete(key)
    },
    clearAll: () => {
      cache.clear()
    },
  }
}

export function ownerBatchLoaderRollbackNote(): string {
  return "Rollback phase-159: unset NEXT_PUBLIC_FEATURE_PHASE_159 / FEATURE_PHASE_159 or set 0/false and restart. No persisted state."
}
