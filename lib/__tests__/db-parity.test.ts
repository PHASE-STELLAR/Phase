import { describe, it, beforeEach, expect } from "vitest"
import { DatabaseSync } from "node:sqlite"
import {
  DualWriter,
  assertSafeIdentifier,
  buildPostgresCreateTable,
  buildPostgresUpsert,
  canonicalize,
  compareSources,
  perTestSchemaName,
  resolveDualWriteMode,
  sqliteParitySource,
  sqliteTypeToPostgres,
  toPositionalParams,
  type ParitySource,
  type WriteOp,
} from "@/lib/db-parity"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const DDL = `CREATE TABLE listings (id TEXT PRIMARY KEY, price REAL NOT NULL, accepts_offers INTEGER NOT NULL DEFAULT 0, name TEXT);`

function seeded(rows: Array<[string, number, number, string | null]>): DatabaseSync {
  const db = new DatabaseSync(":memory:")
  db.exec(DDL)
  const stmt = db.prepare("INSERT INTO listings VALUES (?, ?, ?, ?)")
  for (const r of rows) stmt.run(...r)
  return db
}

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_172 = "1"
    process.env.FEATURE_PHASE_172 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_172
    delete process.env.FEATURE_PHASE_172
  }
}

const op = (table = "listings"): WriteOp => ({ table, sql: "x", params: [] })

describe("phase-172 sqlite→postgres rehearsal", () => {
  beforeEach(() => {
    enable(true)
    resetSecurityCounters()
  })

  it("translates placeholders, types and upserts", () => {
    expect(toPositionalParams("SELECT * FROM t WHERE a = ? AND b = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2")
    expect(sqliteTypeToPostgres("INTEGER")).toBe("BIGINT")
    expect(sqliteTypeToPostgres("REAL")).toBe("DOUBLE PRECISION")
    expect(sqliteTypeToPostgres("TEXT")).toBe("TEXT")
    expect(buildPostgresUpsert("listings", ["id", "price", "name"], ["id"])).toBe(
      'INSERT INTO "listings" ("id", "price", "name") VALUES ($1, $2, $3) ON CONFLICT ("id") DO UPDATE SET "price" = EXCLUDED."price", "name" = EXCLUDED."name"',
    )
    expect(buildPostgresUpsert("k", ["a"], ["a"])).toContain("DO NOTHING")
    expect(() => buildPostgresUpsert("t", ["a"], [])).toThrow(/no primary key/)
    const source = sqliteParitySource(seeded([]))
    expect(buildPostgresCreateTable("listings", source.read("listings").columns, perTestSchemaName("a"))).toContain('PRIMARY KEY ("id")')
  })

  it("rejects unsafe identifiers and isolates per-test schemas", () => {
    expect(() => assertSafeIdentifier('x"; DROP TABLE t;--')).toThrow()
    expect(perTestSchemaName("a")).toMatch(/^t_[0-9a-f]{12}$/)
    expect(perTestSchemaName("a")).not.toBe(perTestSchemaName("b"))
    expect(perTestSchemaName("a")).toBe(perTestSchemaName("a"))
  })

  it("accepts Postgres-style string numerics and booleans but flags text coercion", () => {
    expect(canonicalize("10.50", "REAL")).toEqual({ ok: true, value: 10.5 })
    expect(canonicalize("7", "INTEGER")).toEqual({ ok: true, value: 7 })
    expect(canonicalize(true, "INTEGER")).toEqual({ ok: true, value: 1 })
    expect(canonicalize(7n, "INTEGER")).toEqual({ ok: true, value: 7 })
    expect(canonicalize(7, "TEXT")).toEqual({ ok: false })
    expect(canonicalize("abc", "INTEGER")).toEqual({ ok: false })
  })

  it("reports parity for identical databases regardless of row order", () => {
    const a = seeded([["1", 1.5, 1, "x"], ["2", 2, 0, null]])
    const b = seeded([["2", 2, 0, null], ["1", 1.5, 1, "x"]])
    const report = compareSources(sqliteParitySource(a), sqliteParitySource(b))
    expect(report.ok).toBe(true)
    expect(getSecurityCounter("db_parity_mismatch")).toBe(0)
  })

  it("catches missing, extra, drifted rows that a count check passes", () => {
    const a = seeded([["1", 1.5, 1, "x"], ["2", 2, 0, "y"]])
    const b = seeded([["1", 1.5, 1, "CHANGED"], ["3", 2, 0, "y"]])
    const report = compareSources(sqliteParitySource(a), sqliteParitySource(b))
    expect(report.ok).toBe(false)
    const t = report.tables[0]
    expect(t.leftCount).toBe(t.rightCount)
    expect(t.missingInRight).toEqual(['["2"]'])
    expect(t.extraInRight).toEqual(['["3"]'])
    expect(t.diffs).toEqual([{ pk: '["1"]', column: "name", kind: "value" }])
    expect(getSecurityCounter("db_parity_mismatch")).toBe(1)
  })

  it("detects silent type coercion and tolerates NUMERIC string rendering", () => {
    const left = sqliteParitySource(seeded([["1", 10.5, 1, "42"]]))
    const base = left.read("listings")
    const coerced: ParitySource = {
      tables: () => ["listings"],
      read: () => ({ columns: base.columns, rows: [{ id: "1", price: "10.50", accepts_offers: "1", name: 42 }] }),
    }
    const report = compareSources(left, coerced)
    expect(report.tables[0].diffs).toEqual([{ pk: '["1"]', column: "name", kind: "type_coercion" }])
    expect(report.ok).toBe(false)
  })

  it("flags tables missing on the target", () => {
    const empty: ParitySource = { tables: () => [], read: () => ({ columns: [], rows: [] }) }
    const report = compareSources(sqliteParitySource(seeded([])), empty)
    expect(report.missingTables).toEqual(["listings"])
    expect(report.ok).toBe(false)
  })

  it("resolves dual mode only with flag and URL", () => {
    expect(resolveDualWriteMode({ PHASE_DATABASE_URL: "postgres://x" })).toBe("dual")
    expect(resolveDualWriteMode({})).toBe("primary-only")
    enable(false)
    expect(resolveDualWriteMode({ PHASE_DATABASE_URL: "postgres://x" })).toBe("primary-only")
  })

  it("writes primary first and records secondary failure as drift without throwing", async () => {
    const order: string[] = []
    const writer = new DualWriter({
      mode: "dual",
      primary: async () => void order.push("primary"),
      secondary: async () => {
        order.push("secondary")
        throw new Error("pg down")
      },
    })
    await expect(writer.write(op())).resolves.toBeUndefined()
    expect(order).toEqual(["primary", "secondary"])
    expect(writer.driftLog().map((d) => d.reason)).toEqual(["error"])
    expect(getSecurityCounter("db_dual_write_drift")).toBe(1)
  })

  it("never attempts the secondary when the primary fails", async () => {
    let secondary = 0
    const writer = new DualWriter({
      mode: "dual",
      primary: async () => {
        throw new Error("sqlite busy")
      },
      secondary: async () => void (secondary += 1),
    })
    await expect(writer.write(op())).rejects.toThrow("sqlite busy")
    expect(secondary).toBe(0)
  })

  it("times out and sheds under pool exhaustion instead of blocking", async () => {
    const writer = new DualWriter({
      mode: "dual",
      maxSecondaryInflight: 1,
      secondaryTimeoutMs: 20,
      primary: async () => {},
      secondary: () => new Promise(() => {}),
    })
    const first = writer.write(op("a"))
    await writer.write(op("b"))
    await first
    expect(writer.driftLog().map((d) => [d.table, d.reason])).toEqual([["b", "shed"], ["a", "timeout"]])
    expect(getSecurityCounter("db_dual_write_shed")).toBe(1)
  })

  it("rolls back to primary-only", async () => {
    let secondary = 0
    const writer = new DualWriter({ mode: "dual", primary: async () => {}, secondary: async () => void (secondary += 1) })
    await writer.write(op())
    writer.setMode("primary-only")
    await writer.write(op())
    expect(secondary).toBe(1)
    expect(getSecurityCounter("db_dual_write_ok")).toBe(1)
  })
})
