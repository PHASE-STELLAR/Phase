/**
 * Postgres driver for the SQLite → Postgres migration rehearsal (phase-212,
 * issue #468 follow-up to phase-172 / spike 604).
 *
 * The dialect helpers, typed parity comparison and DualWriter already live in
 * `lib/db-parity.ts`. This module supplies the missing concrete half:
 *   - a `pg` pool opened lazily from `PHASE_DATABASE_URL` (the dependency is
 *     optional: nothing imports it when the flag is off or the URL is unset),
 *   - a `ParitySource` reading schema/columns/rows through `information_schema`,
 *   - a `DualWriteSink` and a CAS gate translating SQLite `?` placeholders to
 *     Postgres `$1..$n` and qualifying table names into an isolated schema,
 *   - bounded-concurrency pool access that *sheds* rather than deadlocks.
 *
 * Flag: phase-212 plus a non-empty `PHASE_DATABASE_URL`. Rollback: unset either;
 * SQLite stays authoritative and no production caller touches Postgres.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"
import {
  assertSafeIdentifier,
  toPositionalParams,
  type AsyncParitySource,
  type ColumnInfo,
  type DualWriteSink,
  type Row,
  type TableData,
  type WriteOp,
} from "@/lib/db-parity"

export type QueryResult = {
  rows?: Array<Record<string, unknown>>
  rowCount?: number | null
}

/** Minimal surface we need from a `pg` Pool/Client, so tests can inject a fake. */
export type PgQueryable = {
  query(text: string, params?: unknown[]): Promise<QueryResult>
}

export type PgPoolLike = PgQueryable & {
  connect?(): Promise<PgQueryable & { release?: () => void }>
  end?(): Promise<void>
}

export type PostgresDriverOptions = {
  /** Defaults to `process.env.PHASE_DATABASE_URL`. */
  connectionString?: string
  /** Isolated schema for this driver/test. Defaults to `public`. */
  schema?: string
  /** Inject a pool (tests, or an app-managed pool). Otherwise `pg` is loaded lazily. */
  pool?: PgPoolLike
  /** Max concurrent secondary writes. Beyond this we shed instead of queueing. */
  maxConcurrency?: number
}

export type PostgresDriver = {
  readonly pool: PgPoolLike
  readonly schema: string
  query(text: string, params?: unknown[]): Promise<QueryResult>
  createSchema(): Promise<void>
  dropSchema(): Promise<void>
  paritySource(): AsyncParitySource
  sink(): DualWriteSink
  casGate(): CasGate
  /** Run `fn` with a pool slot, or shed immediately with `PoolShedError`. */
  withSlot<T>(fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
}

export class PoolShedError extends Error {
  readonly shed = true
  constructor(message = "Postgres pool at capacity; secondary write shed") {
    super(message)
    this.name = "PoolShedError"
  }
}

export function isPostgresDriverEnabled(): boolean {
  return isFeatureEnabled("phase-212")
}

export function postgresDriverRollbackNote(): string {
  return "Rollback phase-212: unset NEXT_PUBLIC_FEATURE_PHASE_212 / FEATURE_PHASE_212 or PHASE_DATABASE_URL and restart. SQLite remains authoritative; no data migration to revert."
}

/** Postgres URLs only; never allow a SQLite/other DSN through this path. */
export function assertPostgresUrl(url: string | undefined): string {
  const value = url?.trim() ?? ""
  if (!/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new Error("PHASE_DATABASE_URL must be a postgres:// or postgresql:// URL")
  }
  return value
}

/** Load `pg` only when a real driver is actually needed. */
async function loadPgPool(connectionString: string, max: number): Promise<PgPoolLike> {
  const moduleName = "pg"
  const mod = (await import(moduleName)) as {
    Pool: new (opts: { connectionString: string; max: number }) => PgPoolLike
  }
  return new mod.Pool({ connectionString, max })
}

const TABLE_REF_RE = /\b(UPDATE|INTO|FROM|TABLE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi

/** Qualify unqualified table references with an isolated schema. */
export function qualifyTables(sql: string, schema: string | undefined): string {
  if (!schema || schema === "public") return sql
  const quoted = `"${assertSafeIdentifier(schema)}"`
  return sql.replace(TABLE_REF_RE, (_match, keyword: string, table: string) => {
    // "information_schema" and other already-qualified refs never match the
    // bare-identifier pattern followed by a keyword, but guard explicitly.
    if (table.toLowerCase() === "information_schema") return `${keyword} ${table}`
    return `${keyword} ${quoted}."${assertSafeIdentifier(table)}"`
  })
}

/**
 * Translate a SQLite-shaped write to Postgres: schema qualification plus
 * `?` → `$n`. Upserts are produced dialect-specifically by `async-cas`; this
 * sink never guesses a conflict target.
 */
export function translateSql(sql: string, schema?: string): string {
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(sql)) {
    throw new Error("INSERT OR REPLACE has no Postgres conflict target; use buildPostgresUpsert")
  }
  return qualifyTables(toPositionalParams(sql), schema)
}

const sqliteTypeFromPg = (dataType: string): string => {
  const t = dataType.toUpperCase()
  if (t.includes("INT")) return "INTEGER"
  if (t.includes("DOUBLE") || t.includes("FLOAT") || t.includes("NUMERIC") || t.includes("REAL")) return "REAL"
  if (t.includes("BYTEA")) return "BLOB"
  return "TEXT"
}

/** A CAS-capable gate — the portable primitive `async-cas` drives. */
export type CasGate = {
  /** Execute an atomic conditional update; returns rows affected (0/1). */
  compareAndSwap(op: WriteOp): Promise<number>
  /** Plain write (no version guard) used for the dual-write shadow copy. */
  write(op: WriteOp): Promise<void>
}

export function createPostgresCasGate(driver: Pick<PostgresDriver, "query" | "schema">): CasGate {
  return {
    async compareAndSwap(op) {
      const result = await driver.query(translateSql(op.sql, driver.schema), op.params)
      return result.rowCount ?? 0
    },
    async write(op) {
      await driver.query(translateSql(op.sql, driver.schema), op.params)
    },
  }
}

/** A CAS gate over the process-wide SQLite connection (authoritative primary). */
export function createSqliteCasGate(db: {
  prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint } }
}): CasGate {
  return {
    async compareAndSwap(op) {
      const result = db.prepare(op.sql).run(...op.params)
      return Number(result.changes)
    },
    async write(op) {
      db.prepare(op.sql).run(...op.params)
    },
  }
}

export async function createPostgresDriver(options: PostgresDriverOptions = {}): Promise<PostgresDriver> {
  const schema = options.schema ? assertSafeIdentifier(options.schema) : "public"
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 5)
  const pool =
    options.pool ??
    (await loadPgPool(assertPostgresUrl(options.connectionString ?? process.env.PHASE_DATABASE_URL), maxConcurrency))
  incSecurityCounter("db_postgres_driver_opened")

  let slots = 0
  const withSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (slots >= maxConcurrency) {
      incSecurityCounter("db_pool_shed")
      throw new PoolShedError()
    }
    slots += 1
    try {
      return await fn()
    } finally {
      slots -= 1
    }
  }

  const query = (text: string, params: unknown[] = []) => withSlot(() => pool.query(text, params))

  const driver: PostgresDriver = {
    pool,
    schema,
    query,
    async createSchema() {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      incSecurityCounter("db_postgres_schema_created")
    },
    async dropSchema() {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      incSecurityCounter("db_postgres_schema_dropped")
    },
    paritySource() {
      return createPostgresParitySource(driver)
    },
    sink() {
      const gate = createPostgresCasGate(driver)
      return async (op) => {
        await gate.write(op)
      }
    },
    casGate() {
      return createPostgresCasGate(driver)
    },
    withSlot,
    async close() {
      await pool.end?.()
    },
  }
  return driver
}

/**
 * `ParitySource` over a real Postgres schema. BIGINT/NUMERIC come back as
 * decimal strings; `canonicalize` in db-parity handles that comparison.
 */
export function createPostgresParitySource(
  driver: Pick<PostgresDriver, "query" | "schema">,
): AsyncParitySource {
  const schema = driver.schema
  return {
    async tables() {
      const result = await driver.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
        [schema],
      )
      return (result.rows ?? []).map((row) => String(row.table_name))
    },
    async read(table) {
      const safe = assertSafeIdentifier(table)
      const colsResult = await driver.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, safe],
      )
      const pkResult = await driver.query(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
        [schema, safe],
      )
      const pkColumns = new Set((pkResult.rows ?? []).map((r) => String(r.column_name)))
      const columns: ColumnInfo[] = (colsResult.rows ?? []).map((row) => ({
        name: String(row.column_name),
        type: sqliteTypeFromPg(String(row.data_type)),
        pk: pkColumns.has(String(row.column_name)),
        notNull: String(row.is_nullable).toUpperCase() === "NO",
      }))
      const rowsResult = await driver.query(
        `SELECT * FROM "${schema}"."${safe}"`,
      )
      const data: TableData = { columns, rows: (rowsResult.rows ?? []) as Row[] }
      return data
    },
  }
}
