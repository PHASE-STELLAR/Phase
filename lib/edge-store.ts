/**
 * phase-268 (issue #726): read and update the JSON sidecar stores from code
 * that may run on the edge runtime.
 *
 * On Node this delegates to `lib/json-store.ts`. The edge runtime has no
 * filesystem, so the Node import sits behind `process.env.NEXT_RUNTIME`, which
 * Next.js replaces at build time; edge bundles never contain `node:fs`.
 *
 * On edge with phase-268 on, the store degrades to a per-isolate in-memory
 * copy: reads return the caller's fallback or earlier writes from the same
 * isolate, writes are not durable, every result says `degraded: true`, and
 * `edge_store_degraded` counts each use. Callers must treat degraded data as
 * advisory. With the flag off, edge access throws EdgeStoreUnavailableError,
 * the legacy outcome of reaching a file store from edge code.
 */

import { isEdgeHardeningEnabled, isEdgeRuntime } from "@/lib/edge-runtime"
import { incSecurityCounter } from "@/lib/security-counters"
import type { ServerDataFile } from "@/lib/server-data-paths"

export class EdgeStoreUnavailableError extends Error {
  readonly code = "EDGE_STORE_UNAVAILABLE"
  constructor(file: string) {
    super(`File-backed store "${file}" is unavailable on the edge runtime`)
    this.name = "EdgeStoreUnavailableError"
  }
}

export type StoreResult<T> = { value: T; degraded: boolean }

const memory = new Map<ServerDataFile, unknown>()

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

async function nodeStore() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { readStore, updateStore } = await import("@/lib/json-store")
    return { readStore, updateStore }
  }
  return null
}

function degradedStore(file: ServerDataFile): Map<ServerDataFile, unknown> {
  if (!isEdgeHardeningEnabled()) throw new EdgeStoreUnavailableError(file)
  incSecurityCounter("edge_store_degraded")
  return memory
}

export async function readServerStore<T extends object>(
  file: ServerDataFile,
  fallback: () => T,
): Promise<StoreResult<T>> {
  const node = isEdgeRuntime() ? null : await nodeStore()
  if (node) return { value: await node.readStore<T>(file, fallback), degraded: false }
  const store = degradedStore(file)
  return { value: clone((store.get(file) as T | undefined) ?? fallback()), degraded: true }
}

export async function updateServerStore<T extends object, R = void>(
  file: ServerDataFile,
  fallback: () => T,
  mutate: (store: T) => R | Promise<R>,
): Promise<StoreResult<R>> {
  const node = isEdgeRuntime() ? null : await nodeStore()
  if (node) return { value: await node.updateStore<T, R>(file, mutate), degraded: false }
  const store = degradedStore(file)
  const draft = clone((store.get(file) as T | undefined) ?? fallback())
  const value = await mutate(draft)
  store.set(file, draft)
  return { value, degraded: true }
}

/** Test hook: drops the per-isolate degraded copies. */
export function resetEdgeStoreMemory(): void {
  memory.clear()
}
