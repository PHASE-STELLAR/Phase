/**
 * Structured log pipeline — partial slice of spike 606 (issue #470).
 *
 * `lib/api-observability.ts` was the single sink and its only transport was
 * `console.*`. This module adds the pieces a hosted log store needs without
 * changing what the console sees on the happy path: secret redaction, a
 * deterministic sampler, a closed set of indexable labels, and a bounded,
 * non-blocking batcher that ships records to an HTTPS sink.
 *
 * Design constraints (see docs/spikes/606-log-pipeline-findings.md):
 * - `emit` never awaits the network and never throws, so a slow or dead sink
 *   cannot extend request P50 or surface an unhandled rejection.
 * - The buffer is bounded and drops oldest first; drops are counted, never
 *   silent. Delivery is at-most-once: a failed batch is dropped, not retried.
 * - Redaction runs before sampling and before the console line is written, so
 *   a secret that reaches `metadata` is masked for both transports.
 * - Only `LOG_LABEL_FIELDS` are safe to index. Wallets, CIDs, token ids, hashes
 *   and free text stay in the unindexed `fields` bag.
 *
 * Scope: redaction, sampling, labels, batching, env validation. Wiring every
 * ad-hoc `console.*` caller, counter export, and `waitUntil` flush on freeze
 * are spike 606 follow-ups.
 *
 * Feature flag: phase-170. Rollback: unset → `emitLog` is a no-op and the
 * console line is written exactly as before; buffered records are dropped.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { redactSecretKeys } from "@/lib/redaction"
import { incSecurityCounter } from "@/lib/security-counters"

export type PipelineLogLevel = "info" | "warn" | "error"

export type PipelineLogPayload = {
  timestamp: string
  level: PipelineLogLevel
  event: string
  route: string
  method: string
  correlationId: string
  [key: string]: unknown
}

export type PipelineRecord = {
  labels: {
    level: PipelineLogLevel
    event: string
    route: string
    method: string
    status_class: string
  }
  timestamp: string
  correlationId: string
  fields: Record<string, unknown>
}

/** Fields that may become index labels. Everything else is stored unindexed. */
export const LOG_LABEL_FIELDS = ["level", "event", "route", "method", "status_class"] as const

const REDACTED = "[REDACTED]"
const MAX_STRING = 1000
const MAX_DEPTH = 6

/** Keys whose values are never shipped, whatever they contain. */
const SENSITIVE_KEY_RE =
  /secret|seed|private|passphrase|password|authorization|api[_-]?key|token(?!_?id)|rawpayload|errorresult|signature(?!_?verified)/i

export function isLogPipelineEnabled(): boolean {
  return isFeatureEnabled("phase-170")
}

export function logPipelineRollbackNote(): string {
  return "Rollback phase-170: unset NEXT_PUBLIC_FEATURE_PHASE_170 / FEATURE_PHASE_170 or set to 0/false and restart. Console logging is unchanged; in-memory buffer is dropped."
}

/** Deep-masks secret-bearing keys and Stellar `S...` seeds; cycle- and depth-safe. */
export function redactLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    const masked = redactSecretKeys(value)
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…[truncated]` : masked
  }
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]"
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)

  if (value instanceof Error) {
    return { name: value.name, message: redactLogValue(value.message, depth + 1, seen) }
  }
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, depth + 1, seen))

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactLogValue(inner, depth + 1, seen)
  }
  return out
}

/** Collapses ids so a route label cannot grow with traffic (`/api/x/123` → `/api/x/:id`). */
export function normalizeRouteLabel(route: string): string {
  return route
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) || /^[0-9a-f]{16,}$/i.test(segment) ? ":id" : segment))
    .join("/")
}

function statusClass(status: unknown): string {
  if (typeof status !== "number" || !Number.isFinite(status)) return "none"
  return `${Math.floor(status / 100)}xx`
}

/** FNV-1a, so one correlation id is always kept or dropped together. */
function hashUnit(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x100000000
}

/** Warn and error are always kept; info is sampled per correlation id. */
export function shouldSampleLog(level: PipelineLogLevel, correlationId: string, infoRate: number): boolean {
  if (level !== "info") return true
  if (infoRate >= 1) return true
  if (infoRate <= 0) return false
  return hashUnit(correlationId) < infoRate
}

export function toPipelineRecord(payload: PipelineLogPayload): PipelineRecord {
  const { timestamp, level, event, route, method, correlationId, ...rest } = payload
  const redacted = redactLogValue(rest) as Record<string, unknown>
  return {
    labels: {
      level,
      event,
      route: normalizeRouteLabel(route),
      method,
      status_class: statusClass(rest.status),
    },
    timestamp,
    correlationId,
    fields: redacted,
  }
}

export type LogPipelineConfig = {
  sinkUrl: string | null
  sinkToken: string | null
  infoSampleRate: number
  batchSize: number
  maxBuffer: number
  flushIntervalMs: number
  timeoutMs: number
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

export function resolveLogPipelineConfig(env: Record<string, string | undefined> = process.env): LogPipelineConfig {
  const rate = Number.parseFloat(env.LOG_SAMPLE_RATE_INFO ?? "")
  return {
    sinkUrl: env.LOG_SINK_URL?.trim() || null,
    sinkToken: env.LOG_SINK_TOKEN?.trim() || null,
    infoSampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 0.1,
    batchSize: boundedInt(env.LOG_SINK_BATCH_SIZE, 50, 1, 500),
    maxBuffer: boundedInt(env.LOG_SINK_MAX_BUFFER, 500, 10, 5000),
    flushIntervalMs: boundedInt(env.LOG_SINK_FLUSH_MS, 2000, 100, 30_000),
    timeoutMs: boundedInt(env.LOG_SINK_TIMEOUT_MS, 2000, 200, 10_000),
  }
}

export { isValidLogSinkUrl } from "@/lib/env-validation"

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>

export class LogPipeline {
  private buffer: PipelineRecord[] = []
  private inflight: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly config: LogPipelineConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  get pending(): number {
    return this.buffer.length
  }

  /** Non-blocking and non-throwing. Returns whether the record was queued. */
  emit(payload: PipelineLogPayload): boolean {
    try {
      if (!this.config.sinkUrl) return false
      if (!shouldSampleLog(payload.level, payload.correlationId, this.config.infoSampleRate)) {
        incSecurityCounter("log_pipeline_sampled_out")
        return false
      }
      this.buffer.push(toPipelineRecord(payload))
      incSecurityCounter("log_pipeline_enqueued")
      while (this.buffer.length > this.config.maxBuffer) {
        this.buffer.shift()
        incSecurityCounter("log_pipeline_dropped")
      }
      if (this.buffer.length >= this.config.batchSize) void this.flush()
      else this.scheduleFlush()
      return true
    } catch {
      return false
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.config.flushIntervalMs)
    // A pending flush must never keep a process alive.
    this.timer.unref?.()
  }

  /** Single-flight; resolves once the in-flight batch settles. Never rejects. */
  flush(): Promise<void> {
    if (this.inflight) return this.inflight
    if (!this.config.sinkUrl || this.buffer.length === 0) return Promise.resolve()
    const batch = this.buffer.splice(0, this.config.batchSize)
    this.inflight = this.send(batch).finally(() => {
      this.inflight = null
      if (this.buffer.length > 0) this.scheduleFlush()
    })
    return this.inflight
  }

  private async send(batch: PipelineRecord[]): Promise<void> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (this.config.sinkToken) headers.authorization = `Bearer ${this.config.sinkToken}`
      const response = await this.fetchImpl(this.config.sinkUrl as string, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: batch }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
      if (response.ok) incSecurityCounter("log_pipeline_flush_ok")
      else throw new Error(`sink status ${response.status}`)
    } catch {
      // At-most-once: the batch is gone. Count it so the loss is visible.
      incSecurityCounter("log_pipeline_flush_failed")
      incSecurityCounter("log_pipeline_dropped", batch.length)
    }
  }

  /** Test and shutdown hook. */
  async drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.buffer.length > 0 || this.inflight) await this.flush()
  }
}

let singleton: LogPipeline | null = null

function getPipeline(): LogPipeline {
  if (!singleton) singleton = new LogPipeline(resolveLogPipelineConfig())
  return singleton
}

export function resetLogPipelineForTests(): void {
  singleton = null
}

/**
 * Entry point used by `api-observability`. Returns the redacted payload that the
 * console line should carry, or the original payload when the flag is off.
 */
export function emitLog(payload: PipelineLogPayload): PipelineLogPayload {
  if (!isLogPipelineEnabled()) return payload
  const { timestamp, level, event, route, method, correlationId, ...rest } = payload
  const safe = redactLogValue(rest) as Record<string, unknown>
  if (JSON.stringify(safe) !== JSON.stringify(rest)) incSecurityCounter("log_pipeline_redacted")
  getPipeline().emit(payload)
  return { timestamp, level, event, route, method, correlationId, ...safe }
}

/** Awaitable flush for cron/route handlers that can afford it. */
export function flushLogPipeline(): Promise<void> {
  return isLogPipelineEnabled() ? getPipeline().flush() : Promise.resolve()
}
