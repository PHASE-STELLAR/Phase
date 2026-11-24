/**
 * Portable compare-and-swap writes (phase-212, issue #468 follow-up).
 *
 * The CAS loops in `lib/signal-store.ts` used to call `db.prepare(...).run(...)`
 * inline: a synchronous, SQLite-only operation. That cannot dual-write to a
 * second dialect and cannot be awaited behind a pool guard. This module makes
 * the write primitive a `Promise<number>` over a `CasGate`, so the same loop
 * works against SQLite (authoritative primary) and Postgres (best-effort
 * secondary) with identical semantics:
 *
 *   - `WHERE version = ?` remains the guard; 0 rows changed means a lost race.
 *   - the secondary is attempted only after a successful primary CAS;
 *   - a secondary failure/timeout/pool-shed is recorded as drift and never
 *     turns a committed primary write into a failed request.
 *
 * Rollback: `setMode("primary-only")` (or unset phase-212) — SQLite is the only
 * writer and the gate is the original synchronous `run()` wrapped in a Promise.
 */

import {
  DualWriter,
  type DualWriterOptions,
  type WriteOp,
} from "@/lib/db-parity"
import {
  createPostgresDriver,
  createPostgresCasGate,
  createSqliteCasGate,
  isPostgresDriverEnabled,
  type CasGate,
  type PostgresDriver,
} from "@/lib/postgres-driver"
import { getDb } from "@/lib/sqlite-db"
import { incSecurityCounter } from "@/lib/security-counters"

export type VersionedUpdate = WriteOp

/** The authoritative primary gate stays synchronous so read+write is atomic in
 * one event-loop turn — exactly the property the CAS retry loops depend on. */
export type SyncCasGate = {
  compareAndSwap(op: WriteOp): number
  write(op: WriteOp): void
}

export function getPrimaryCasGate(): SyncCasGate {
  // `getDb()` caches the connection itself; do not cache the gate, because
  // tests (and a rotated data root) may close and reopen the underlying db.
  const db = getDb()
  return {
    compareAndSwap(op) {
      return Number(db.prepare(op.sql).run(...(op.params as Array<string | number | bigint | null | Uint8Array>)).changes)
    },
    write(op) {
      db.prepare(op.sql).run(...(op.params as Array<string | number | bigint | null | Uint8Array>))
    },
  }
}

export function resetPrimaryCasGateForTests(): void {
  // Kept as a no-op hook for callers that reset all DB-backed caches in tests.
}

/** Apply one version-guarded update synchronously; `false` means a lost race. */
export function applySyncCas(gate: SyncCasGate, update: VersionedUpdate): boolean {
  const changes = gate.compareAndSwap(update)
  if (changes > 0) incSecurityCounter("db_cas_applied")
  else incSecurityCounter("db_cas_conflict")
  return changes > 0
}

export class CasConflictError extends Error {
  readonly currentVersion: number
  constructor(currentVersion: number) {
    super(`Version conflict: current version is ${currentVersion}`)
    this.name = "CasConflictError"
    this.currentVersion = currentVersion
  }
}

/** Result of one CAS attempt: applied on the primary, shadowed when in dual mode. */
export type CasAttempt = { applied: boolean; currentVersion: number }

/**
 * Apply one version-guarded update through a gate. Returns the row count as a
 * boolean; the caller keeps its existing re-read/recompute loop on `false`.
 */
export async function applyVersionedUpdate(
  gate: CasGate,
  update: VersionedUpdate,
): Promise<boolean> {
  const changes = await gate.compareAndSwap(update)
  if (changes > 0) incSecurityCounter("db_cas_applied")
  else incSecurityCounter("db_cas_conflict")
  return changes > 0
}

export type DualCasGateHandle = {
  gate: CasGate
  writer: DualWriter
  close(): Promise<void>
}

/**
 * Compose a primary gate and a secondary gate behind a `DualWriter`. The
 * secondary receives the *same* SQL op; the Postgres sink translates it.
 */
export function createDualCasGate(
  primary: CasGate,
  secondary: CasGate,
  options: Omit<DualWriterOptions, "primary" | "secondary"> = {},
): DualCasGateHandle {
  const writer = new DualWriter({
    primary: (op) => primary.write(op),
    secondary: (op) => secondary.write(op),
    ...options,
  })
  return {
    writer,
    gate: {
      async compareAndSwap(op) {
        const changes = await primary.compareAndSwap(op)
        if (changes === 0) return 0
        // The primary row already changed. Shadow that change to Postgres via
        // the already-translated write path (idempotent by primary key).
        await writer.write(op)
        return changes
      },
      async write(op) {
        await writer.write(op)
      },
    },
    close: async () => {},
  }
}

let shadowWriter: DualWriter | null = null

/**
 * Best-effort async shadow of an already-committed primary CAS write. Never
 * blocks the request: a slow/dead Postgres degrades to SQLite-only, and every
 * failure/timeout/shed lands in the DualWriter drift log.
 */
export function shadowCasWrite(op: WriteOp): void {
  if (!isPostgresDriverEnabled() || !process.env.PHASE_DATABASE_URL?.trim()) return
  if (!shadowWriter) {
    shadowWriter = new DualWriter({
      primary: async () => {},
      secondary: async (shadow) => {
        const driver = await createPostgresDriver({
          connectionString: process.env.PHASE_DATABASE_URL,
        })
        await driver.casGate().write(shadow)
      },
      mode: "dual",
    })
  }
  void shadowWriter.write(op)
}

export function resetShadowCasWriterForTests(): void {
  shadowWriter = null
}

let cachedGate: Promise<DualCasGateHandle> | null = null

/**
 * Gate for production CAS callers. Primary-only by default; dual mode requires
 * the phase-212 flag *and* a Postgres URL, so a rollback is a single env unset.
 */
export async function getWriteCasGate(env: Record<string, string | undefined> = process.env): Promise<CasGate> {
  const primary = createSqliteCasGate(getDb())
  if (!isPostgresDriverEnabled() || !env.PHASE_DATABASE_URL?.trim()) return primary
  if (!cachedGate) {
    cachedGate = (async () => {
      const driver: PostgresDriver = await createPostgresDriver({
        connectionString: env.PHASE_DATABASE_URL,
      })
      const handle = createDualCasGate(primary, driver.casGate())
      return {
        ...handle,
        close: async () => {
          await handle.close()
          await driver.close()
        },
      }
    })()
  }
  return (await cachedGate).gate
}

export async function closeWriteCasGate(): Promise<void> {
  if (!cachedGate) return
  const handle = await cachedGate
  cachedGate = null
  await handle.close()
}

export function resetWriteCasGateForTests(): void {
  cachedGate = null
}
