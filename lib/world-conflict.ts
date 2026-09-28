/**
 * Narrative branch divergence — conflict detection for co-authored worlds — phase-105
 *
 * `POST /api/world` currently overwrites blindly: if two collaborators edit
 * the same world concurrently, the last write silently wins and the other
 * author's changes are lost ("co-authored worlds overwrite each other
 * blindly"). This module implements the scoped mechanism the issue
 * describes: optimistic concurrency control keyed on a monotonically
 * increasing `version` field on `WorldCollectionData`, plus a per-author
 * `vector_clock` that distinguishes stale writes from truly concurrent ones.
 *
 * Vector clocks reach this module in more than one shape: a plain JSON
 * object (`{ "G...A": 2 }`), a `Map`, or an entries array
 * (`[["G...A", 2]]`, which is what `JSON.stringify([...map])` produces).
 * Comparing those shapes directly always reports divergence, so every clock
 * is normalized to a canonical `Record<string, number>` before comparison.
 *
 * This is intentionally narrow — a "detect divergence, surface it to the
 * client" strategy for a single shared resource (a world's name/prompt/tone)
 * — not a general-purpose branch/merge framework.
 *
 * Feature flag: phase-105 (NEXT_PUBLIC_FEATURE_PHASE_105 / FEATURE_PHASE_105)
 * Rollback: disable flag → POST /api/world reverts to unconditional overwrite
 *           (previous behavior). No data migration to revert.
 */
import { isFeatureEnabled } from "@/lib/feature-flags"
import type { WorldCollectionData } from "@/lib/narrative-world-store"

export type VectorClock = Record<string, number>

export type VectorClockOrder = "equal" | "before" | "after" | "concurrent"

export type WorldConflictResult =
  | { conflict: false }
  | {
      conflict: true
      serverVersion: number
      clientVersion: number | undefined
      serverVectorClock: VectorClock
      order: VectorClockOrder
      current: Pick<WorldCollectionData, "world_name" | "world_prompt" | "narrator_tone">
    }

export function isWorldConflictCheckEnabled(): boolean {
  return isFeatureEnabled("phase-105")
}

function isCounter(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
}

/**
 * Canonicalizes a vector clock received as a `Map`, a plain object, or an
 * array of `[node, counter]` entries. Zero counters are dropped so `{}` and
 * `{ a: 0 }` compare equal; duplicate entries keep the highest counter.
 * Returns `null` for anything malformed.
 */
export function normalizeVectorClock(input: unknown): VectorClock | null {
  let entries: unknown[]
  if (input instanceof Map) {
    entries = [...input.entries()]
  } else if (Array.isArray(input)) {
    entries = input
  } else if (input !== null && typeof input === "object") {
    entries = Object.entries(input)
  } else {
    return null
  }

  const clock: VectorClock = {}
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const [node, counter] = entry
    if (typeof node !== "string" || node.length === 0 || !isCounter(counter)) return null
    if (counter === 0) continue
    clock[node] = Math.max(clock[node] ?? 0, counter)
  }
  return clock
}

export function compareVectorClocks(a: VectorClock, b: VectorClock): VectorClockOrder {
  let aAhead = false
  let bAhead = false
  for (const node of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[node] ?? 0
    const bv = b[node] ?? 0
    if (av > bv) aAhead = true
    else if (bv > av) bAhead = true
  }
  if (aAhead && bAhead) return "concurrent"
  if (aAhead) return "after"
  if (bAhead) return "before"
  return "equal"
}

export function incrementVectorClock(clock: unknown, node: string): VectorClock {
  const next = normalizeVectorClock(clock) ?? {}
  next[node] = (next[node] ?? 0) + 1
  return next
}

/**
 * Detects a concurrent-edit conflict between what the client last saw and
 * the currently stored world.
 *
 * - Flag off → never reports a conflict (legacy overwrite behavior).
 * - World doesn't exist yet → nothing to diverge from.
 * - Client sent `expectedVectorClock` → conflict unless it equals the
 *   server's clock after normalization; `order` tells the client whether it
 *   is merely stale (`before`) or diverged (`concurrent`).
 * - `expectedVersion` is still checked when the clocks agree (worlds saved
 *   before vector clocks existed); omitting both opts out of the check
 *   (keeps backward compatibility for older callers).
 */
export function checkWorldConflict(
  existing: WorldCollectionData | null,
  expectedVersion: number | undefined,
  expectedVectorClock?: VectorClock,
): WorldConflictResult {
  if (!isWorldConflictCheckEnabled()) return { conflict: false }
  if (!existing) return { conflict: false }
  if (expectedVersion === undefined && expectedVectorClock === undefined) return { conflict: false }

  const serverVersion = existing.version ?? 0
  const serverVectorClock = normalizeVectorClock(existing.vector_clock) ?? {}

  let order: VectorClockOrder =
    expectedVectorClock !== undefined
      ? compareVectorClocks(expectedVectorClock, serverVectorClock)
      : "equal"
  // Worlds saved before vector clocks existed only carry `version`.
  if (order === "equal" && expectedVersion !== undefined && expectedVersion !== serverVersion) {
    order = expectedVersion < serverVersion ? "before" : "after"
  }
  if (order === "equal") return { conflict: false }

  return {
    conflict: true,
    serverVersion,
    clientVersion: expectedVersion,
    serverVectorClock,
    order,
    current: {
      world_name: existing.world_name,
      world_prompt: existing.world_prompt,
      narrator_tone: existing.narrator_tone,
    },
  }
}
