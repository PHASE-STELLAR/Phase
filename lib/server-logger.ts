/**
 * Server-runtime logging facade (phase-211, issue #470 follow-up).
 *
 * phase-170 built the structured pipeline but left ad-hoc `console.*` callers
 * all over server routes and libs. This module is the single sanctioned sink:
 * every server log line goes through `emitLog` (redaction, closed labels,
 * sampling, bounded HTTPS batching) before a *single* console write.
 *
 * - Flag off → `serverLog` is a passthrough to the original console method, so
 *   output is byte-for-byte the pre-refactor shape ("identity emitter").
 * - Flag on → one structured JSON line per call, with identifiers masked, and
 *   `flushLogsOnFreeze()` hands the pending batch to the platform's waitUntil
 *   so a serverless freeze cannot drop it.
 *
 * Rollback: unset phase-211; console output is unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  emitLog,
  flushLogPipeline,
  isLogPipelineEnabled,
  toPipelineRecord,
  type PipelineLogLevel,
} from "@/lib/log-pipeline"
import { incSecurityCounter } from "@/lib/security-counters"

/** Closed set of indexable server log events (no wallet/CID/token ids). */
export const SERVER_LOG_EVENTS = [
  "server.log",
  "request.completed",
  "request.failed",
  "rpc.upstream_failed",
  "owner.batch_fallback",
  "webhook.signature_invalid",
  "db.parity",
  "log.flush_on_freeze",
] as const
export type ServerLogEvent = (typeof SERVER_LOG_EVENTS)[number]

export const SERVER_LOG_COUNTERS = [
  "log_server_emitted",
  "log_server_flushed_on_freeze",
  "log_pipeline_enqueued",
  "log_pipeline_sampled_out",
  "log_pipeline_dropped",
  "log_pipeline_redacted",
  "log_pipeline_flush_ok",
  "log_pipeline_flush_failed",
] as const

/** Counters the log pipeline may emit, exported with their closed label set. */
export const LOG_PIPELINE_COUNTERS = SERVER_LOG_COUNTERS

export type ServerLogContext = {
  route?: string
  method?: string
  correlationId?: string
  event?: ServerLogEvent
}

const contextStorage = new AsyncLocalStorage<ServerLogContext>()

export function currentServerLogContext(): ServerLogContext {
  return contextStorage.getStore() ?? {}
}

export function runWithServerLogContext<T>(context: ServerLogContext, fn: () => T): T {
  return contextStorage.run(context, fn)
}

export function isServerLogRoutingEnabled(): boolean {
  return isFeatureEnabled("phase-211")
}

export function serverLogRollbackNote(): string {
  return "Rollback phase-211: unset NEXT_PUBLIC_FEATURE_PHASE_211 / FEATURE_PHASE_211 and restart. serverLog writes straight to console again; no persisted state."
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The only console call sites in the server runtime. */
export function writeConsoleLine(level: ServerLogLevel, line: string): void {
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.info(line)
}

export type ServerLogLevel = "info" | "warn" | "error" | "debug"

/**
 * Route one ad-hoc log call through the pipeline. `event` is optional so the
 * mechanical `console.warn(` → `serverLog.warn(` migration stays readable;
 * unknown strings fall back to the closed `server.log` label.
 */
export function emitServerLog(level: ServerLogLevel, args: unknown[], event?: ServerLogEvent): void {
  if (!isServerLogRoutingEnabled() || !isLogPipelineEnabled()) {
    if (level === "error") console.error(...args)
    else if (level === "warn") console.warn(...args)
    else if (level === "debug") console.debug(...args)
    else console.log(...args)
    return
  }

  const ctx = currentServerLogContext()
  const requestedEvent = event ?? ctx.event ?? "server.log"
  const safeEvent: ServerLogEvent = (SERVER_LOG_EVENTS as readonly string[]).includes(requestedEvent)
    ? requestedEvent
    : "server.log"
  const payload = emitLog({
    timestamp: new Date().toISOString(),
    level: (level === "debug" ? "info" : level) as PipelineLogLevel,
    event: safeEvent,
    route: ctx.route ?? "server",
    method: ctx.method ?? "-",
    correlationId: ctx.correlationId ?? "server",
    message: args.map(formatArg).join(" "),
  })
  const record = toPipelineRecord(payload)
  writeConsoleLine(level, JSON.stringify(record))
  incSecurityCounter("log_server_emitted")
}

export const serverLog = {
  info: (...args: unknown[]) => emitServerLog("info", args),
  warn: (...args: unknown[]) => emitServerLog("warn", args),
  error: (...args: unknown[]) => emitServerLog("error", args),
  debug: (...args: unknown[]) => emitServerLog("debug", args),
  /** Alias for the many `console.log` call sites migrated from server routes. */
  log: (...args: unknown[]) => emitServerLog("info", args),
}

export type WaitUntil = (promise: Promise<unknown>) => void

/**
 * Serverless-freeze flush. Pass `event.waitUntil.bind(event)` from a
 * `NextFetchEvent` in middleware. A no-op when either flag is off.
 */
export function flushLogsOnFreeze(waitUntil: WaitUntil): void {
  if (!isServerLogRoutingEnabled() || !isLogPipelineEnabled()) return
  waitUntil(
    flushLogPipeline().then(() => {
      incSecurityCounter("log_server_flushed_on_freeze")
    }),
  )
}
