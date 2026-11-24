import { describe, it, beforeEach, afterEach, vi } from "vitest"
import * as assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parquetMetadata, parquetReadObjects } from "hyparquet"
import {
  WAREHOUSE_SCHEMA,
  WAREHOUSE_SCHEMA_VERSION,
  buildWarehouseManifest,
  collectCounterRows,
  collectVolumeRows,
  collectWarehouseRows,
  formatWarehouseNdjson,
  isWarehouseExportEnabled,
  redactWarehouseRow,
  redactWarehouseRows,
  redactWarehouseText,
  rowsToParquetBuffer,
  warehouseRowsChecksum,
  type WarehouseRow,
} from "@/lib/analytics-warehouse"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"
import { fingerprintWallet } from "@/lib/redaction"
import { resetSecurityCounters, incSecurityCounter } from "@/lib/security-counters"

const WALLET = `G${"A".repeat(55)}`
const SECRET = "SDQXX5YXNQJ6X4Y3MXBXL4SVGSJPBIEUT3LOEBJTAI7XTMSEFAPKKMEJ"
const NOW = Date.parse("2026-06-01T00:00:00.000Z")

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_180 = "1"
    process.env.FEATURE_PHASE_180 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_180
    delete process.env.FEATURE_PHASE_180
  }
}

function row(over: Partial<WarehouseRow> = {}): WarehouseRow {
  return {
    table: "counter",
    ts: NOW,
    metric: "wash_trades_flagged",
    value: 3,
    status: null,
    wallet_fingerprint: null,
    ...over,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-warehouse-"))
  vi.stubEnv("PHASE_SERVER_DATA_DIR", dir)
  resetDbForTests()
  resetSecurityCounters()
  enable(true)
})

afterEach(() => {
  enable(false)
  resetDbForTests()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe("phase-180 warehouse redaction", () => {
  it("gates on the feature flag and ships a rollback note", () => {
    assert.equal(isWarehouseExportEnabled(), true)
    enable(false)
    assert.equal(isWarehouseExportEnabled(), false)
  })

  it("fingerprints wallets and strips secrets from text", () => {
    const text = redactWarehouseText(`payout ${WALLET} signed with ${SECRET}`)
    assert.ok(!text.includes(WALLET))
    assert.ok(!text.includes(SECRET))
    assert.ok(text.includes(fingerprintWallet(WALLET)))
    assert.ok(text.includes("[REDACTED_SECRET_KEY]"))
  })

  it("fingerprints raw wallet fields and is idempotent across runs", () => {
    const raw = row({ table: "health", metric: `health for ${WALLET}`, wallet_fingerprint: WALLET })
    const once = redactWarehouseRow(raw)
    const twice = redactWarehouseRow(once)
    assert.equal(once.wallet_fingerprint, fingerprintWallet(WALLET))
    assert.ok(!once.metric.includes(WALLET))
    assert.equal(twice.wallet_fingerprint, once.wallet_fingerprint)
    assert.equal(twice.metric, once.metric)

    const rows = redactWarehouseRows([raw, row({ value: null })])
    assert.equal(rows.length, 2)
    assert.equal(rows[1].wallet_fingerprint, null)
  })
})

describe("phase-180 warehouse formats", () => {
  it("builds a schema-versioned manifest with a stable rows-only checksum", () => {
    const rows = [row(), row({ table: "volume", metric: "market_volume_phaselq_24h", value: 100 })]
    const manifest = buildWarehouseManifest(rows, { generatedAt: NOW })
    assert.equal(manifest.schema, WAREHOUSE_SCHEMA)
    assert.equal(manifest.version, WAREHOUSE_SCHEMA_VERSION)
    assert.equal(manifest.row_count, 2)
    assert.deepEqual(manifest.tables, ["counter", "volume"])
    assert.equal(manifest.redacted, true)
    assert.equal(manifest.checksum, warehouseRowsChecksum(rows))
    assert.equal(manifest.checksum, buildWarehouseManifest(rows, { generatedAt: NOW + 1 }).checksum)
    assert.notEqual(manifest.checksum, warehouseRowsChecksum([row()]))
  })

  it("emits NDJSON with a manifest header line and one row per line", () => {
    const rows = redactWarehouseRows([row(), row({ metric: "distributor_health", status: "healthy", wallet_fingerprint: WALLET })])
    const { manifest, body } = formatWarehouseNdjson(rows, { generatedAt: NOW })
    const lines = body.split("\n").filter((line) => line.length > 0)
    assert.equal(lines.length, 3)
    const header = JSON.parse(lines[0])
    assert.equal(header.schema, WAREHOUSE_SCHEMA)
    assert.equal(header.checksum, manifest.checksum)
    assert.equal(header.row_count, 2)
    const parsed = lines.slice(1).map((line) => JSON.parse(line))
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0].table, "counter")
    assert.ok(!lines.join("\n").includes(WALLET))
  })

  it("emits empty-safe NDJSON for a zero-row export", () => {
    const { manifest, body } = formatWarehouseNdjson([], { generatedAt: NOW })
    assert.equal(manifest.row_count, 0)
    assert.equal(body.trim().split("\n").length, 1)
  })

  it("round-trips rows through Parquet with schema metadata", async () => {
    const rows = redactWarehouseRows([
      row(),
      row({ table: "health", metric: "distributor_health", value: null, status: "healthy", wallet_fingerprint: WALLET, ts: NOW + 5 }),
      row({ table: "volume", metric: "market_offers_accepted_24h", value: 12, ts: NOW + 9 }),
    ])
    const { manifest, buffer } = rowsToParquetBuffer(rows, { generatedAt: NOW })

    const bytes = new Uint8Array(buffer)
    assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), "PAR1")
    assert.equal(
      String.fromCharCode(
        bytes[bytes.length - 4],
        bytes[bytes.length - 3],
        bytes[bytes.length - 2],
        bytes[bytes.length - 1],
      ),
      "PAR1",
    )

    const meta = parquetMetadata(buffer)
    const kv = Object.fromEntries((meta.key_value_metadata ?? []).map((entry) => [entry.key, entry.value]))
    assert.equal(kv["phase.schema"], WAREHOUSE_SCHEMA)
    assert.equal(kv["phase.schema_version"], WAREHOUSE_SCHEMA_VERSION)
    assert.equal(kv["phase.checksum"], manifest.checksum)
    assert.equal(kv["phase.redacted"], "true")

    const parsed = await parquetReadObjects({ file: buffer })
    assert.equal(parsed.length, 3)
    assert.equal(parsed[0].table, "counter")
    assert.equal(Number(parsed[1].ts), NOW + 5)
    assert.equal(parsed[1].value, null)
    assert.equal(parsed[1].status, "healthy")
    assert.equal(parsed[2].metric, "market_offers_accepted_24h")
    assert.equal(parsed[2].value, 12)
    const serialized = JSON.stringify(parsed, (key, value) =>
      typeof value === "bigint" ? String(value) : value,
    )
    assert.ok(!serialized.includes(WALLET))
  })
})

describe("phase-180 warehouse collectors", () => {
  it("collects counter rows from the security counter snapshot", () => {
    incSecurityCounter("wash_trades_flagged", 4)
    const rows = collectCounterRows(NOW)
    const flagged = rows.find((r) => r.metric === "wash_trades_flagged")
    assert.ok(flagged)
    assert.equal(flagged.table, "counter")
    assert.equal(flagged.value, 4)
    assert.equal(flagged.ts, NOW)
    assert.equal(flagged.wallet_fingerprint, null)
  })

  it("collects zero volume from an empty database and skips a broken one", async () => {
    const rows = await collectVolumeRows({ now: NOW })
    assert.equal(rows.length, 2)
    assert.equal(rows.find((r) => r.metric === "market_volume_phaselq_24h")?.value, 0)
    assert.equal(rows.find((r) => r.metric === "market_offers_accepted_24h")?.value, 0)

    const db = getDb()
    db.exec("DROP TABLE offers")
    const afterDrop = await collectVolumeRows({ now: NOW })
    assert.deepEqual(afterDrop, [])
  })

  it("collects counter, health and volume tables in one pass", async () => {
    incSecurityCounter("preview_verify_total")
    const rows = await collectWarehouseRows({ now: NOW })
    const tables = [...new Set(rows.map((r) => r.table))].sort()
    assert.deepEqual(tables, ["counter", "volume"])
    assert.ok(rows.some((r) => r.table === "counter" && r.metric === "preview_verify_total"))
    const redacted = redactWarehouseRows(rows)
    assert.equal(redacted.length, rows.length)
  })
})
