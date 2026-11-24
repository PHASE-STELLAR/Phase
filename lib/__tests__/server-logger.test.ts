import { describe, it, beforeEach, afterEach, vi } from "vitest"
import * as assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {
  isServerLogRoutingEnabled,
  LOG_PIPELINE_COUNTERS,
  runWithServerLogContext,
  serverLog,
  serverLogRollbackNote,
  flushLogsOnFreeze,
  writeConsoleLine,
} from "@/lib/server-logger"
import { redactLogIdentifiers, resetLogPipelineForTests } from "@/lib/log-pipeline"
import { resetSecurityCounters, getSecurityCounter, SECURITY_COUNTER_REGISTRY } from "@/lib/security-counters"

const SECRET = "SDQXX5YXNQJ6X4Y3MXBXL4SVGSJPBIEUT3LOEBJTAI7XTMSEFAPKKMEJ"
const WALLET = "G" + "A".repeat(55)
const CID = "bafy" + "a".repeat(44)

function enableFlags(on: boolean) {
  for (const n of ["170", "211"]) {
    const key = `NEXT_PUBLIC_FEATURE_PHASE_${n}`
    if (on) process.env[key] = "1"
    else delete process.env[key]
  }
}

describe("phase-211 server-runtime logging", () => {
  beforeEach(() => {
    resetSecurityCounters()
    resetLogPipelineForTests()
    vi.restoreAllMocks()
  })
  afterEach(() => {
    enableFlags(false)
    delete process.env.LOG_SINK_URL
    vi.restoreAllMocks()
  })

  it("flag off is an identity emitter: console receives the original arguments", () => {
    enableFlags(false)
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    serverLog.warn("[legacy] raw line", { wallet: WALLET })
    assert.equal(isServerLogRoutingEnabled(), false)
    assert.equal(spy.mock.calls[0][0], "[legacy] raw line")
    assert.equal(spy.mock.calls[0][1].wallet, WALLET)
  })

  it("masks secrets, wallets and CIDs in every emitted line", () => {
    enableFlags(true)
    const lines: string[] = []
    vi.spyOn(console, "info").mockImplementation((line: unknown) => lines.push(String(line)))
    runWithServerLogContext(
      { route: "/api/market", method: "POST", correlationId: "req-1" },
      () => serverLog.info("settlement", { seed: SECRET, owner: WALLET, cid: CID, note: `${WALLET} owns ${CID}` }),
    )
    const line = lines[0]
    assert.ok(line)
    for (const identifier of [SECRET, WALLET, CID]) assert.ok(!line.includes(identifier))
    const parsed = JSON.parse(line)
    assert.deepEqual(Object.keys(parsed.labels).sort(), ["event", "level", "method", "route", "status_class"])
    assert.equal(parsed.labels.route, "/api/market")
    assert.ok(getSecurityCounter("log_server_emitted") >= 1)
  })

  it("redactLogIdentifiers is deterministic and keeps short ids alone", () => {
    assert.equal(redactLogIdentifiers(WALLET), "[REDACTED_WALLET]")
    assert.equal(redactLogIdentifiers(CID), "[REDACTED_CID]")
    assert.equal(redactLogIdentifiers("token 7"), "token 7")
  })

  it("flushes on freeze through waitUntil, with a no-op when disabled", () => {
    enableFlags(true)
    process.env.LOG_SINK_URL = "https://logs.example.com/ingest"
    let captured: Promise<unknown> | null = null
    flushLogsOnFreeze((p) => {
      captured = p
    })
    assert.ok(captured)
    enableFlags(false)
    captured = null
    flushLogsOnFreeze(() => {
      throw new Error("waitUntil must not be called when disabled")
    })
    assert.equal(captured, null)
  })

  it("exports only counters that exist in the closed registry", () => {
    for (const name of LOG_PIPELINE_COUNTERS) {
      assert.ok(Object.prototype.hasOwnProperty.call(SECURITY_COUNTER_REGISTRY, name), name)
    }
    assert.ok(serverLogRollbackNote().includes("phase-211"))
  })

  it("the single console sink still emits the original level", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    writeConsoleLine("error", "line")
    assert.equal(error.mock.calls[0][0], "line")
  })

  it("no raw console.* remains in server API routes", () => {
    const root = path.resolve(process.cwd(), "app/api")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.name.endsWith(".ts")) files.push(p)
      }
    }
    walk(root)
    const offenders = files.filter((f) => /console\.(log|info|warn|error|debug)\s*\(/.test(fs.readFileSync(f, "utf8")))
    assert.deepEqual(offenders.map((f) => path.relative(root, f)), [])
  })
})
