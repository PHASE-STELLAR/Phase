import { describe, it, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  LogPipeline,
  emitLog,
  isValidLogSinkUrl,
  normalizeRouteLabel,
  redactLogValue,
  resetLogPipelineForTests,
  resolveLogPipelineConfig,
  shouldSampleLog,
  toPipelineRecord,
  type LogPipelineConfig,
  type PipelineLogPayload,
} from "@/lib/log-pipeline"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"
import { validateServerEnv } from "@/lib/env-validation"

const SECRET = "SDQXX5YXNQJ6X4Y3MXBXL4SVGSJPBIEUT3LOEBJTAI7XTMSEFAPKKMEJ"

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_170 = "1"
    process.env.FEATURE_PHASE_170 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_170
    delete process.env.FEATURE_PHASE_170
  }
}

function payload(over: Partial<PipelineLogPayload> = {}): PipelineLogPayload {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "info",
    event: "request_completed",
    route: "/api/faucet",
    method: "POST",
    correlationId: "c-1",
    ...over,
  }
}

function config(over: Partial<LogPipelineConfig> = {}): LogPipelineConfig {
  return {
    sinkUrl: "https://logs.example.com/ingest",
    sinkToken: "sink-token",
    infoSampleRate: 1,
    batchSize: 3,
    maxBuffer: 10,
    flushIntervalMs: 100,
    timeoutMs: 500,
    ...over,
  }
}

describe("phase-170 log pipeline", () => {
  beforeEach(() => {
    enable(true)
    resetSecurityCounters()
    resetLogPipelineForTests()
    delete process.env.LOG_SINK_URL
  })

  it("redacts secret keys, sensitive key names, cycles and bigint", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const out = redactLogValue({
      note: `failed with ${SECRET}`,
      rawPayload: { xdr: "AAAA" },
      errorResult: "tx_failed",
      authorization: "Bearer abc",
      signature_verified: true,
      token_id: 7,
      nested: { adminSecret: "x", ok: "fine" },
      cyclic,
      big: 5n,
    }) as Record<string, any>
    assert.equal(out.note, "failed with [REDACTED_SECRET_KEY]")
    assert.equal(out.rawPayload, "[REDACTED]")
    assert.equal(out.errorResult, "[REDACTED]")
    assert.equal(out.authorization, "[REDACTED]")
    assert.equal(out.signature_verified, true)
    assert.equal(out.token_id, 7)
    assert.equal(out.nested.adminSecret, "[REDACTED]")
    assert.equal(out.nested.ok, "fine")
    assert.equal(out.cyclic.self, "[CIRCULAR]")
    assert.equal(out.big, "5")
    assert.ok(!JSON.stringify(out).includes(SECRET))
  })

  it("keeps wallets out of labels and collapses id segments", () => {
    const record = toPipelineRecord(
      payload({ route: "/api/world/123/export", status: 404, wallet: "GABC", hash: "deadbeef" }),
    )
    assert.deepEqual(Object.keys(record.labels).sort(), ["event", "level", "method", "route", "status_class"])
    assert.equal(record.labels.route, "/api/world/:id/export")
    assert.equal(record.labels.status_class, "4xx")
    assert.equal(record.fields.wallet, "GABC")
    assert.equal(normalizeRouteLabel("/api/ipfs/" + "a".repeat(32)), "/api/ipfs/:id")
  })

  it("always keeps warn/error and samples info deterministically per correlation id", () => {
    assert.equal(shouldSampleLog("error", "x", 0), true)
    assert.equal(shouldSampleLog("warn", "x", 0), true)
    assert.equal(shouldSampleLog("info", "x", 1), true)
    assert.equal(shouldSampleLog("info", "x", 0), false)
    const first = shouldSampleLog("info", "req-42", 0.5)
    for (let i = 0; i < 5; i += 1) assert.equal(shouldSampleLog("info", "req-42", 0.5), first)
    const kept = Array.from({ length: 1000 }, (_, i) => shouldSampleLog("info", `r-${i}`, 0.1)).filter(Boolean).length
    assert.ok(kept > 40 && kept < 200, `kept=${kept}`)
  })

  it("batches to the sink with bearer auth and flushes at batch size", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const pipeline = new LogPipeline(config(), async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200 }
    })
    pipeline.emit(payload({ correlationId: "a" }))
    pipeline.emit(payload({ correlationId: "b" }))
    assert.equal(calls.length, 0)
    pipeline.emit(payload({ correlationId: "c" }))
    await pipeline.drain()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://logs.example.com/ingest")
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer sink-token")
    assert.equal(JSON.parse(calls[0].init.body as string).records.length, 3)
    assert.equal(getSecurityCounter("log_pipeline_flush_ok"), 1)
  })

  it("never throws or blocks when the sink fails, and counts the loss", async () => {
    const pipeline = new LogPipeline(config({ batchSize: 2 }), async () => {
      throw new Error("sink down")
    })
    assert.doesNotThrow(() => {
      pipeline.emit(payload({ correlationId: "a" }))
      pipeline.emit(payload({ correlationId: "b" }))
    })
    await pipeline.drain()
    assert.equal(getSecurityCounter("log_pipeline_flush_failed"), 1)
    assert.equal(getSecurityCounter("log_pipeline_dropped"), 2)
    assert.equal(pipeline.pending, 0)
  })

  it("treats a non-2xx sink response as a failed flush", async () => {
    const pipeline = new LogPipeline(config({ batchSize: 1 }), async () => ({ ok: false, status: 503 }))
    pipeline.emit(payload())
    await pipeline.drain()
    assert.equal(getSecurityCounter("log_pipeline_flush_failed"), 1)
  })

  it("bounds the buffer and drops oldest first", async () => {
    const sent: string[] = []
    const pipeline = new LogPipeline(config({ batchSize: 500, maxBuffer: 10, flushIntervalMs: 30_000 }), async (_u, init) => {
      for (const r of JSON.parse(init.body as string).records) sent.push(r.correlationId)
      return { ok: true, status: 200 }
    })
    for (let i = 0; i < 15; i += 1) pipeline.emit(payload({ correlationId: `r-${i}` }))
    assert.equal(pipeline.pending, 10)
    assert.equal(getSecurityCounter("log_pipeline_dropped"), 5)
    await pipeline.drain()
    assert.equal(sent[0], "r-5")
  })

  it("is a no-op without a sink URL and counts sampled-out info", () => {
    const noSink = new LogPipeline(config({ sinkUrl: null }))
    assert.equal(noSink.emit(payload()), false)
    const sampled = new LogPipeline(config({ infoSampleRate: 0 }))
    assert.equal(sampled.emit(payload()), false)
    assert.equal(sampled.emit(payload({ level: "error" })), true)
    assert.equal(getSecurityCounter("log_pipeline_sampled_out"), 1)
  })

  it("emitLog is the identity when the flag is off", () => {
    enable(false)
    const input = payload({ note: SECRET })
    assert.equal(emitLog(input), input)
    assert.equal(getSecurityCounter("log_pipeline_enqueued"), 0)
  })

  it("emitLog masks the console payload when the flag is on", () => {
    const out = emitLog(payload({ note: SECRET, rawPayload: "x" }))
    assert.equal(out.note, "[REDACTED_SECRET_KEY]")
    assert.equal(out.rawPayload, "[REDACTED]")
    assert.equal(out.event, "request_completed")
    assert.equal(getSecurityCounter("log_pipeline_redacted"), 1)
  })

  it("resolves bounded config and validates the sink URL", () => {
    const cfg = resolveLogPipelineConfig({
      LOG_SINK_URL: " https://x.test/in ",
      LOG_SAMPLE_RATE_INFO: "7",
      LOG_SINK_BATCH_SIZE: "99999",
    })
    assert.equal(cfg.sinkUrl, "https://x.test/in")
    assert.equal(cfg.infoSampleRate, 1)
    assert.equal(cfg.batchSize, 500)
    assert.equal(resolveLogPipelineConfig({}).infoSampleRate, 0.1)
    assert.equal(isValidLogSinkUrl("http://x.test"), false)
    assert.equal(isValidLogSinkUrl("not a url"), false)
    assert.equal(validateServerEnv({ LOG_SINK_URL: "http://x.test" }).valid, false)
    assert.equal(validateServerEnv({ LOG_SINK_URL: "https://x.test" }).valid, true)
  })
})
