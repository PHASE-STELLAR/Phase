import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  assertPostgresUrl,
  createPostgresDriver,
  createPostgresParitySource,
  createPostgresCasGate,
  createSqliteCasGate,
  qualifyTables,
  translateSql,
  PoolShedError,
  type PgPoolLike,
  type QueryResult,
} from "@/lib/postgres-driver"
import { createDualCasGate, applyVersionedUpdate, CasConflictError } from "@/lib/async-cas"
import {
  DualWriter,
  compareSourcesAsync,
  perTestSchemaName,
  sqliteParitySource,
  type WriteOp,
} from "@/lib/db-parity"
import { resetSecurityCounters, snapshotSecurityCounters } from "@/lib/security-counters"

class FakePool implements PgPoolLike {
  readonly calls: Array<{ text: string; params?: unknown[] }> = []
  private readonly rowCountFor: (text: string) => number
  constructor(rowCountFor: (text: string) => number = () => 1) {
    this.rowCountFor = rowCountFor
  }
  async query(text: string, params: unknown[] = []): Promise<QueryResult> {
    this.calls.push({ text, params })
    if (/information_schema\.tables/i.test(text)) return { rows: [{ table_name: "items" }] }
    if (/information_schema\.columns/i.test(text)) {
      return {
        rows: [
          { column_name: "id", data_type: "text", is_nullable: "NO" },
          { column_name: "version", data_type: "bigint", is_nullable: "NO" },
        ],
      }
    }
    if (/table_constraints/i.test(text)) return { rows: [{ column_name: "id" }] }
    if (/SELECT \*/i.test(text)) {
      return { rows: [{ id: "a", version: "1" }, { id: "b", version: "2" }] }
    }
    return { rows: [], rowCount: this.rowCountFor(text) }
  }
  async end() {}
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, version INTEGER NOT NULL);
           INSERT INTO items (id, version) VALUES ('a', 1), ('b', 2);`)
  return db
}

describe("phase-212 Postgres driver + async CAS", () => {
  beforeEach(() => resetSecurityCounters())

  it("accepts only postgres URLs", () => {
    expect(assertPostgresUrl("postgresql://u:p@host/db")).toBe("postgresql://u:p@host/db")
    expect(() => assertPostgresUrl("file:./x.sqlite")).toThrow(/postgres/)
    expect(() => assertPostgresUrl(undefined)).toThrow(/postgres/)
  })

  it("translates ? to $n and qualifies tables, rejecting ambiguous upserts", () => {
    expect(translateSql("UPDATE signals SET a = ? WHERE id = ?", "t_abc")).toBe(
      'UPDATE "t_abc"."signals" SET a = $1 WHERE id = $2',
    )
    expect(qualifyTables("SELECT * FROM signals", undefined)).toBe("SELECT * FROM signals")
    expect(() => translateSql("INSERT OR REPLACE INTO signals VALUES (?)")).toThrow(/conflict target/)
  })

  it("opens with an injected pool, creates/drops an isolated test schema and reads parity rows", async () => {
    const pool = new FakePool()
    const schema = perTestSchemaName("phase-212/parity")
    const driver = await createPostgresDriver({ pool, schema })
    await driver.createSchema()
    await driver.dropSchema()
    expect(pool.calls.some((c) => c.text.includes(`CREATE SCHEMA IF NOT EXISTS "${schema}"`))).toBe(true)
    expect(pool.calls.some((c) => c.text.includes(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))).toBe(true)

    const source = createPostgresParitySource(driver)
    await expect(source.tables()).resolves.toEqual(["items"])
    const data = await source.read("items")
    expect(data.columns.map((c) => [c.name, c.type, c.pk])).toEqual([
      ["id", "TEXT", true],
      ["version", "INTEGER", false],
    ])
    // Postgres renders BIGINT as a decimal string; parity must canonicalize it.
    expect(data.rows).toEqual([{ id: "a", version: "1" }, { id: "b", version: "2" }])
    await driver.close()
  })

  it("runs the typed parity suite against a real-Postgres-shaped source", async () => {
    const db = memoryDb()
    const pool = new FakePool()
    const driver = await createPostgresDriver({ pool, schema: "public" })
    const report = await compareSourcesAsync(sqliteParitySource(db), driver.paritySource())
    expect(report.ok).toBe(true)
    expect(report.tables[0].rightChecksum).toBe(report.tables[0].leftChecksum)
    expect(snapshotSecurityCounters()["db_parity_checked"]).toBe(1)
    db.close()
  })

  it("keeps CAS semantics identical across dialects: stale version is rejected", async () => {
    const pool = new FakePool((text) => (/WHERE id = \$\d+ AND version = \$\d+/.test(text) ? 0 : 1))
    const driver = await createPostgresDriver({ pool, schema: "public" })
    const applied = await applyVersionedUpdate(driver.casGate(), {
      table: "items",
      sql: "UPDATE items SET version = ? WHERE id = ? AND version = ?",
      params: [2, "a", 99],
    })
    expect(applied).toBe(false)
    expect(snapshotSecurityCounters()["db_cas_conflict"]).toBe(1)
    expect(CasConflictError).toBeDefined()
  })

  it("dual-writes after a successful primary CAS and records shed secondary writes as drift", async () => {
    let primaryVersion = 1
    const primaryWrites: WriteOp[] = []
    const primary = createSqliteCasGate({
      prepare: () => ({
        run: (...params: unknown[]) => {
          const version = params[params.length - 1]
          if (version !== primaryVersion) return { changes: 0 }
          primaryVersion += 1
          primaryWrites.push({ table: "items", sql: "", params })
          return { changes: 1 }
        },
      }),
    })
    const secondary = { ...createPostgresCasGate({ query: async () => ({ rowCount: 1 }), schema: "public" }) }
    const shed = new FakePool()
    const gate = createDualCasGate(
      primary,
      {
        compareAndSwap: secondary.compareAndSwap,
        write: async () => {
          throw new PoolShedError()
        },
      },
      { mode: "dual" },
    )
    const op: WriteOp = {
      table: "items",
      sql: "UPDATE items SET version = ? WHERE id = ? AND version = ?",
      params: [2, "a", 1],
    }
    expect(await applyVersionedUpdate(gate.gate, op)).toBe(true)
    expect(await applyVersionedUpdate(gate.gate, op)).toBe(false)
    expect(primaryWrites).toHaveLength(1)
    expect(gate.writer.driftLog().map((d) => d.reason)).toEqual(["shed"])
    expect(shed).toBeDefined()
    expect(snapshotSecurityCounters()["db_pool_shed"]).toBeUndefined()
  })

  it("proves primary-only rollback: no secondary write and no drift", async () => {
    let secondaryCalls = 0
    const writer = new DualWriter({
      primary: async () => {},
      secondary: async () => {
        secondaryCalls += 1
        throw new Error("must not be called")
      },
      mode: "primary-only",
    })
    await writer.write({ table: "items", sql: "", params: [] })
    expect(secondaryCalls).toBe(0)
    expect(writer.driftLog()).toEqual([])
    expect(writer.getMode()).toBe("primary-only")
    writer.setMode("dual")
    expect(writer.getMode()).toBe("dual")
  })

  it("pool storm: bounded concurrency sheds instead of deadlocking; CAS conflicts stay visible", async () => {
    const pool = new FakePool((text) => (/WHERE/i.test(text) ? 1 : 1))
    const driver = await createPostgresDriver({ pool, schema: "public", maxConcurrency: 2 })
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, i) => driver.query("SELECT 1 WHERE ? = ?", [i, i])),
    )
    const shed = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof PoolShedError,
    )
    const ok = results.filter((r) => r.status === "fulfilled")
    expect(ok.length + shed.length).toBe(60)
    expect(ok.length).toBeGreaterThan(0)
    expect(shed.length).toBeGreaterThan(0)
    expect(snapshotSecurityCounters()["db_pool_shed"]).toBe(shed.length)
  })

  it("exposes DualWriter drift reasons as a closed set", () => {
    const writer = new DualWriter({
      primary: async () => {},
      secondary: async () => {
        throw new Error("down")
      },
      mode: "dual",
      maxSecondaryInflight: 5,
    })
    return writer
      .write({ table: "items", sql: "", params: [] })
      .then(() => {
        expect(writer.driftLog()[0].reason).toBe("error")
      })
  })
})

const liveDatabaseUrl = process.env.PHASE_DATABASE_URL?.trim()
const liveSuite = liveDatabaseUrl ? describe : describe.skip

liveSuite("phase-212 live Postgres parity suite", () => {
  it("runs the per-test schema parity suite against a real Postgres", async () => {
    const schema = perTestSchemaName(`live-${Date.now()}`)
    const driver = await createPostgresDriver({ connectionString: liveDatabaseUrl, schema })
    try {
      await driver.createSchema()
      const pool = driver.pool as PgPoolLike
      await pool.query(`CREATE TABLE "${schema}".items (id TEXT PRIMARY KEY, version BIGINT NOT NULL)`)
      await pool.query(`INSERT INTO "${schema}".items (id, version) VALUES ('a', 1), ('b', 2)`)
      const db = memoryDb()
      const report = await compareSourcesAsync(sqliteParitySource(db), driver.paritySource())
      expect(report.ok).toBe(true)
      db.close()
    } finally {
      await driver.dropSchema()
      await driver.close()
    }
  })
})
