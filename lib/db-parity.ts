/**
 * SQLite → Postgres migration rehearsal — partial slice of spike 604 (issue #468).
 *
 * There is no Postgres dialect, no checksum and no down-migration; the only
 * precedent compares row counts, which cannot see silent type coercion (REAL vs
 * NUMERIC, INTEGER vs BOOLEAN, BIGINT returned as a string). This module is the
 * driver-agnostic half of a rehearsal: dialect translation, a typed per-table
 * parity comparison, and a dual-writer whose ordering and failure semantics are
 * explicit. No Postgres driver is added; a follow-up implements `ParitySource`
 * and `DualWriteSink` for `pg`.
 *
 * - Ordering: the primary (SQLite) is written first and is the crash winner. A
 *   primary failure never reaches the secondary.
 * - The secondary is best-effort and bounded: failures, timeouts, and pool
 *   exhaustion (in-flight cap) are recorded as drift and shed, never thrown, so
 *   a slow Postgres degrades to SQLite-only instead of failing requests.
 * - Rollback is `setMode("primary-only")`; SQLite stays authoritative.
 * - Parity is by declared column type, so a TEXT column that comes back numeric
 *   is reported as `type_coercion` rather than passing on count alone.
 *
 * Scope: dialect helpers, parity, dual-writer, per-test schema naming. Async
 * re-plumbing of the CAS retry loops, advisory-lock replacement of `fileQueues`,
 * and pool storm testing are spike 604 follow-ups.
 *
 * Feature flag: phase-172. Rollback: unset → `resolveDualWriteMode` returns
 * `primary-only`; nothing here is called by production paths.
 */

import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"

type Env = Record<string, string | undefined>
export type Row = Record<string, unknown>

export function isDbParityEnabled(): boolean {
  return isFeatureEnabled("phase-172")
}

export function dbParityRollbackNote(): string {
  return "Rollback phase-172: unset NEXT_PUBLIC_FEATURE_PHASE_172 / FEATURE_PHASE_172 or set to 0/false and restart. SQLite remains authoritative; no data migration to revert."
}

export type DualWriteMode = "primary-only" | "dual"

/** Dual-write needs both the flag and an explicit Postgres URL. */
export function resolveDualWriteMode(env: Env = process.env): DualWriteMode {
  return isDbParityEnabled() && env.PHASE_DATABASE_URL?.trim() ? "dual" : "primary-only"
}

// ── Dialect ────────────────────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

export function assertSafeIdentifier(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`)
  return name
}

const quote = (name: string) => `"${assertSafeIdentifier(name)}"`

/** `?` → `$1..$n`. Strings are not scanned; the stores never inline `?` in literals. */
export function toPositionalParams(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

/**
 * Integer flag columns stay BIGINT rather than becoming BOOLEAN so a parity run
 * compares like with like; a BOOLEAN conversion is its own migration.
 */
export function sqliteTypeToPostgres(declared: string): string {
  const t = declared.trim().toUpperCase()
  if (t.startsWith("INT")) return "BIGINT"
  if (t === "REAL" || t.startsWith("FLOAT") || t.startsWith("DOUBLE")) return "DOUBLE PRECISION"
  if (t === "BLOB") return "BYTEA"
  return "TEXT"
}

export type ColumnInfo = { name: string; type: string; pk: boolean; notNull: boolean }

export function buildPostgresCreateTable(table: string, columns: ColumnInfo[], schema?: string): string {
  const target = schema ? `${quote(schema)}.${quote(table)}` : quote(table)
  const defs = columns.map(
    (c) => `${quote(c.name)} ${sqliteTypeToPostgres(c.type)}${c.notNull || c.pk ? " NOT NULL" : ""}`,
  )
  const pk = columns.filter((c) => c.pk).map((c) => quote(c.name))
  if (pk.length > 0) defs.push(`PRIMARY KEY (${pk.join(", ")})`)
  return `CREATE TABLE IF NOT EXISTS ${target} (${defs.join(", ")})`
}

/** Replacement for `INSERT OR REPLACE`: explicit conflict target, all non-key columns updated. */
export function buildPostgresUpsert(table: string, columns: string[], pk: string[]): string {
  if (pk.length === 0) throw new Error(`Table ${table} has no primary key; upsert is undefined`)
  const cols = columns.map(quote).join(", ")
  const params = columns.map((_, i) => `$${i + 1}`).join(", ")
  const updates = columns.filter((c) => !pk.includes(c)).map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`)
  const conflict = pk.map(quote).join(", ")
  const action = updates.length > 0 ? `DO UPDATE SET ${updates.join(", ")}` : "DO NOTHING"
  return `INSERT INTO ${quote(table)} (${cols}) VALUES (${params}) ON CONFLICT (${conflict}) ${action}`
}

/** One isolated schema per test run, so a shared Postgres has no cross-test pollution. */
export function perTestSchemaName(testId: string): string {
  return `t_${createHash("sha256").update(testId).digest("hex").slice(0, 12)}`
}

// ── Parity ─────────────────────────────────────────────────────────────────

export type TableData = { columns: ColumnInfo[]; rows: Row[] }
export type ParitySource = { tables(): string[]; read(table: string): TableData }

export function sqliteParitySource(db: DatabaseSync): ParitySource {
  return {
    tables: () =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    read: (table) => {
      const info = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{
        name: string
        type: string
        pk: number
        notnull: number
      }>
      return {
        columns: info.map((c) => ({ name: c.name, type: c.type, pk: c.pk > 0, notNull: c.notnull === 1 })),
        rows: db.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[],
      }
    },
  }
}

type Kind = "numeric" | "text" | "other"
const kindOf = (declared: string): Kind => {
  const t = sqliteTypeToPostgres(declared)
  return t === "BIGINT" || t === "DOUBLE PRECISION" ? "numeric" : t === "TEXT" ? "text" : "other"
}

export type Canonical = { ok: true; value: string | number | null } | { ok: false }

/** Canonical form by declared type; `ok: false` means the value is the wrong JS type for the column. */
export function canonicalize(value: unknown, declared: string): Canonical {
  if (value === null || value === undefined) return { ok: true, value: null }
  const kind = kindOf(declared)
  if (kind === "numeric") {
    if (typeof value === "boolean") return { ok: true, value: value ? 1 : 0 }
    if (typeof value === "bigint") return { ok: true, value: Number(value) }
    if (typeof value === "number") return { ok: true, value }
    // Postgres drivers return BIGINT and NUMERIC as decimal strings.
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return { ok: true, value: Number(value) }
    return { ok: false }
  }
  if (kind === "text") return typeof value === "string" ? { ok: true, value } : { ok: false }
  return { ok: true, value: String(value) }
}

const approxEqual = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

const pkKey = (row: Row, pk: string[]) => JSON.stringify(pk.map((c) => row[c] ?? null))

export type ParityDiff = { pk: string; column: string; kind: "value" | "type_coercion" }
export type TableParity = {
  table: string
  leftCount: number
  rightCount: number
  missingInRight: string[]
  extraInRight: string[]
  diffs: ParityDiff[]
  diffsTruncated: boolean
  leftChecksum: string
  rightChecksum: string
  match: boolean
}

const MAX_REPORTED = 50

export function tableChecksum(data: TableData): string {
  const pk = data.columns.filter((c) => c.pk).map((c) => c.name)
  const keyed = data.rows
    .map((row) => ({
      key: pk.length > 0 ? pkKey(row, pk) : JSON.stringify(row),
      cells: data.columns.map((c) => {
        const canon = canonicalize(row[c.name], c.type)
        return canon.ok ? canon.value : `__type_error__:${typeof row[c.name]}`
      }),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return createHash("sha256").update(JSON.stringify(keyed)).digest("hex")
}

export function compareTable(table: string, left: TableData, right: TableData): TableParity {
  const columns = left.columns
  const pk = columns.filter((c) => c.pk).map((c) => c.name)
  const rightByKey = new Map(right.rows.map((row) => [pkKey(row, pk), row]))
  const leftKeys = new Set<string>()
  const diffs: ParityDiff[] = []
  const missingInRight: string[] = []

  for (const lrow of left.rows) {
    const key = pkKey(lrow, pk)
    leftKeys.add(key)
    const rrow = rightByKey.get(key)
    if (!rrow) {
      missingInRight.push(key)
      continue
    }
    for (const col of columns) {
      const l = canonicalize(lrow[col.name], col.type)
      const r = canonicalize(rrow[col.name], col.type)
      if (!l.ok || !r.ok) {
        if (l.ok !== r.ok) diffs.push({ pk: key, column: col.name, kind: "type_coercion" })
        else if (!l.ok && lrow[col.name] !== rrow[col.name]) diffs.push({ pk: key, column: col.name, kind: "value" })
        continue
      }
      const same =
        typeof l.value === "number" && typeof r.value === "number" ? approxEqual(l.value, r.value) : l.value === r.value
      if (!same) diffs.push({ pk: key, column: col.name, kind: "value" })
    }
  }
  const extraInRight = [...rightByKey.keys()].filter((k) => !leftKeys.has(k))
  const leftChecksum = tableChecksum(left)
  const rightChecksum = tableChecksum({ columns, rows: right.rows })
  return {
    table,
    leftCount: left.rows.length,
    rightCount: right.rows.length,
    missingInRight: missingInRight.slice(0, MAX_REPORTED),
    extraInRight: extraInRight.slice(0, MAX_REPORTED),
    diffs: diffs.slice(0, MAX_REPORTED),
    diffsTruncated: diffs.length > MAX_REPORTED || missingInRight.length > MAX_REPORTED || extraInRight.length > MAX_REPORTED,
    leftChecksum,
    rightChecksum,
    match: missingInRight.length === 0 && extraInRight.length === 0 && diffs.length === 0 && leftChecksum === rightChecksum,
  }
}

export type ParityReport = { ok: boolean; tables: TableParity[]; missingTables: string[] }

export function compareSources(left: ParitySource, right: ParitySource): ParityReport {
  const rightTables = new Set(right.tables())
  const tables: TableParity[] = []
  const missingTables: string[] = []
  for (const table of left.tables()) {
    if (!rightTables.has(table)) {
      missingTables.push(table)
      continue
    }
    tables.push(compareTable(table, left.read(table), right.read(table)))
  }
  const ok = missingTables.length === 0 && tables.every((t) => t.match)
  incSecurityCounter("db_parity_checked")
  if (!ok) incSecurityCounter("db_parity_mismatch")
  return { ok, tables, missingTables }
}

// ── Dual-write ─────────────────────────────────────────────────────────────

export type WriteOp = { table: string; sql: string; params: unknown[] }
export type DualWriteSink = (op: WriteOp) => Promise<void>
export type DriftEntry = { table: string; reason: "error" | "timeout" | "shed"; at: number }

export type DualWriterOptions = {
  primary: DualWriteSink
  secondary: DualWriteSink
  mode?: DualWriteMode
  /** Pool-exhaustion guard: beyond this many in-flight secondary writes, shed. */
  maxSecondaryInflight?: number
  secondaryTimeoutMs?: number
  maxDriftEntries?: number
}

export class DualWriter {
  private mode: DualWriteMode
  private inflight = 0
  private readonly drift: DriftEntry[] = []
  private readonly maxInflight: number
  private readonly timeoutMs: number
  private readonly maxDrift: number

  constructor(private readonly options: DualWriterOptions) {
    this.mode = options.mode ?? resolveDualWriteMode()
    this.maxInflight = options.maxSecondaryInflight ?? 5
    this.timeoutMs = options.secondaryTimeoutMs ?? 1500
    this.maxDrift = options.maxDriftEntries ?? 1000
  }

  setMode(mode: DualWriteMode): void {
    this.mode = mode
  }

  getMode(): DualWriteMode {
    return this.mode
  }

  /** Tables that diverged since start; the input to a re-sync before cutover. */
  driftLog(): readonly DriftEntry[] {
    return this.drift
  }

  private recordDrift(table: string, reason: DriftEntry["reason"]): void {
    incSecurityCounter(reason === "shed" ? "db_dual_write_shed" : "db_dual_write_drift")
    this.drift.push({ table, reason, at: Date.now() })
    if (this.drift.length > this.maxDrift) this.drift.shift()
  }

  /** Throws only if the primary fails — and then the secondary is never attempted. */
  async write(op: WriteOp): Promise<void> {
    await this.options.primary(op)
    if (this.mode !== "dual") return
    if (this.inflight >= this.maxInflight) {
      this.recordDrift(op.table, "shed")
      return
    }
    this.inflight += 1
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.options.secondary(op),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs)
        }),
      ])
      incSecurityCounter("db_dual_write_ok")
    } catch (error) {
      this.recordDrift(op.table, error instanceof Error && error.message === "timeout" ? "timeout" : "error")
    } finally {
      if (timer) clearTimeout(timer)
      this.inflight -= 1
    }
  }
}
