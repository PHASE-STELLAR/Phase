/**
 * Wired owner-read batching (phase-210, issue #518 follow-up to phase-159).
 *
 * The phase-159 `createBatchLoader` primitive was never called by a production
 * route, so the N+1 `owner_of` scan remained. This module connects it to the
 * three real read paths, in cheapest-first order:
 *
 *   1. index pushdown — a cached explore scan answers known ids without RPC;
 *   2. sidecar `mget` — one `owner-index.json` read answers a batch of ids;
 *   3. a single chunked `owner_of` batch for whatever is still missing.
 *
 * Flag off → every id goes through the original per-token loader. Rollback:
 * unset phase-210; callers revert to the unbatched path (no persisted state).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { mgetStoreRecords } from "@/lib/json-store"
import { createBatchLoader, type BatchLoader } from "@/lib/owner-batch-loader"
import { lookupCachedOwners } from "@/lib/explore-owners-cache"
import { incSecurityCounter } from "@/lib/security-counters"

export type OwnerBatchResult = string | null | Error

export type OwnerReadBatcherOptions = {
  /** Original per-token path. Receives one id, returns one owner. */
  loadOne: (tokenId: number) => Promise<string | null>
  /** Batched RPC path; must return results aligned to the input ids. */
  loadOwnerBatch: (tokenIds: readonly number[]) => Promise<OwnerBatchResult[]>
  /** Chunk size handed to the batched RPC path. Default 50. */
  maxBatchSize?: number
  /** Use the in-memory explore scan as an index. Default true. */
  useIndex?: boolean
  /** Use the owner-index sidecar mget. Default true. */
  useSidecar?: boolean
  /** Called once per batched RPC call, so a benchmark can count round-trips. */
  onRpcBatch?: (size: number) => void
}

export type OwnerReadBatcher = {
  load: (tokenId: number) => Promise<string | null>
  loadMany: (tokenIds: readonly number[]) => Promise<OwnerBatchResult[]>
  clearAll: () => void
}

export function isOwnerReadBatchingEnabled(): boolean {
  return isFeatureEnabled("phase-210")
}

export function ownerReadBatchingRollbackNote(): string {
  return "Rollback phase-210: unset NEXT_PUBLIC_FEATURE_PHASE_210 / FEATURE_PHASE_210 and restart. Callers use the original per-token owner_of path; owner-index.json is inert and can be deleted."
}

export function createOwnerReadBatcher(options: OwnerReadBatcherOptions): OwnerReadBatcher {
  const maxBatchSize = Math.max(1, options.maxBatchSize ?? 50)
  const useIndex = options.useIndex ?? true
  const useSidecar = options.useSidecar ?? true

  const loader: BatchLoader<number, string | null> = createBatchLoader<number, string | null>(
    async (keys) => {
      const results: OwnerBatchResult[] = new Array(keys.length).fill(null)
      const pending: number[] = []

      // (1) index pushdown: known ids never reach the sidecar or RPC.
      const indexed = useIndex ? lookupCachedOwners(keys) : new Map<number, string>()
      keys.forEach((id, i) => {
        const owner = indexed.get(id)
        if (owner) {
          results[i] = owner
          incSecurityCounter("owner_batch_index_hit")
        } else {
          pending.push(i)
        }
      })

      // (2) sidecar mget: one file read for the whole remaining batch.
      let missing: number[] = pending
      if (useSidecar && pending.length > 0) {
        const ids = pending.map((i) => String(keys[i]))
        const cached = await mgetStoreRecords<string>("ownerIndex", ids, () => ({}))
        missing = []
        pending.forEach((i) => {
          const owner = cached[String(keys[i])]
          if (owner) {
            results[i] = owner
            incSecurityCounter("owner_batch_sidecar_mget")
          } else {
            missing.push(i)
          }
        })
      }

      // (3) one chunked RPC batch for the genuinely unknown ids.
      if (missing.length > 0) {
        options.onRpcBatch?.(missing.length)
        let batch: OwnerBatchResult[]
        try {
          batch = await options.loadOwnerBatch(missing.map((i) => keys[i]))
        } catch (error) {
          batch = missing.map(() => (error instanceof Error ? error : new Error(String(error))))
        }
        missing.forEach((i, j) => {
          results[i] = batch[j] ?? new Error("owner batch returned no result for id")
        })
      }

      incSecurityCounter("owner_batch_loaded")
      return results
    },
    { maxBatchSize },
  )

  return {
    load(tokenId) {
      if (!isOwnerReadBatchingEnabled()) return options.loadOne(tokenId)
      return loader.load(tokenId)
    },
    async loadMany(tokenIds) {
      if (!isOwnerReadBatchingEnabled()) {
        return Promise.all(
          tokenIds.map(async (id) => {
            try {
              return await options.loadOne(id)
            } catch (error) {
              return error instanceof Error ? error : new Error(String(error))
            }
          }),
        )
      }
      return loader.loadMany(tokenIds)
    },
    clearAll() {
      loader.clearAll()
    },
  }
}

/**
 * Regression benchmark: N ids through the unbatched path vs the batcher.
 * `rpcCalls` is the number of `loadOwnerBatch` invocations, i.e. round-trips.
 */
export async function benchmarkOwnerReads(options: OwnerReadBatcherOptions & { tokenIds: readonly number[] }) {
  const unbatchedStart = Date.now()
  const before = await Promise.all(options.tokenIds.map((id) => options.loadOne(id)))
  const unbatchedMs = Date.now() - unbatchedStart

  let rpcCalls = 0
  const batcher = createOwnerReadBatcher({
    ...options,
    onRpcBatch: (size) => {
      rpcCalls += 1
      options.onRpcBatch?.(size)
    },
  })
  const batchedStart = Date.now()
  const after = await batcher.loadMany(options.tokenIds)
  const batchedMs = Date.now() - batchedStart

  return {
    tokenCount: options.tokenIds.length,
    unbatchedRpcCalls: options.tokenIds.length,
    batchedRpcCalls: rpcCalls,
    unbatchedMs,
    batchedMs,
    identicalResults: JSON.stringify(before) === JSON.stringify(after),
  }
}
