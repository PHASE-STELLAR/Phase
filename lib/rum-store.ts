/**
 * phase-213 — closed-label RUM ingest store.
 *
 * Persists only the strict `RumEvent` wire shape produced by
 * `lib/web-vitals-budgets.ts`: a normalized route template, a metric name, a
 * numeric value and a SHA-256 session hash. No wallet address, URL, IP,
 * user-agent or Referer is read or stored.
 *
 * Rollback: unset the feature flag. The ingest route returns 404 and this
 * sidecar is never read; `rum-events.json` can be deleted.
 */

import { readStore, updateStoreWithReader } from "@/lib/json-store"
import {
  isRumCollectorEnabled,
  parseFieldData,
  rumRollbackNote,
  type RumEvent,
} from "@/lib/web-vitals-budgets"

export { isRumCollectorEnabled, rumRollbackNote }

const MAX_STORED_EVENTS = 10_000

type RumStore = { events: RumEvent[] }

async function readAll(): Promise<RumEvent[]> {
  try {
    const store = await readStore<RumStore>("rumEvents", () => ({ events: [] }))
    // Re-parse so a tampered sidecar can never leak unexpected fields into CI.
    return parseFieldData(store.events)
  } catch {
    return []
  }
}

/** Append validated events, keeping the sidecar bounded. */
export async function appendRumEvents(events: readonly RumEvent[]): Promise<number> {
  const accepted = parseFieldData(events)
  if (accepted.length === 0) return 0
  const stored = await updateStoreWithReader<RumStore, number>(
    "rumEvents",
    (raw) => {
      const store = (raw ?? {}) as Partial<RumStore>
      return { events: Array.isArray(store.events) ? store.events : [] }
    },
    (store) => {
      const current = parseFieldData(store.events)
      const merged = [...current, ...accepted].slice(-MAX_STORED_EVENTS)
      store.events = merged
      return accepted.length
    },
  )
  return stored
}

/** Field-data snapshot consumed by the CI evaluator / admin export. */
export async function readRumFieldData(): Promise<RumEvent[]> {
  return readAll()
}
