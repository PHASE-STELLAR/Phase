import { redactSecrets } from "@/lib/x402-dead-letter"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { emitLog } from "@/lib/log-pipeline"
import { isAnalyticsWarehouseEnabled, recordWarehouseEvent } from "@/lib/analytics-warehouse"

type ApiLogLevel = "info" | "warn" | "error"
type ApiMetadata = Record<string, unknown>

type ApiJsonInit = ResponseInit & {
  event?: string
  metadata?: ApiMetadata
}

/** Bound metadata so an event cannot grow unbounded labels or leak long text. */
function sanitizeAnalyticsMetadata(metadata: ApiMetadata | undefined): ApiMetadata {
  const out: ApiMetadata = {}
  if (!metadata || typeof metadata !== "object") return out
  let count = 0
  for (const [key, value] of Object.entries(metadata)) {
    if (count >= 24) break
    if (typeof key !== "string" || key.length > 64) continue
    if (typeof value === "string") {
      out[key] = value.slice(0, 200)
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === "boolean") {
      out[key] = value
    } else {
      continue
    }
    count++
  }
  return out
}

const CORRELATION_HEADER = "x-correlation-id"
const REQUEST_ID_HEADER = "x-request-id"

function getIncomingCorrelationId(request: NextRequest): string {
  const headerValue =
    request.headers.get(CORRELATION_HEADER) ?? request.headers.get(REQUEST_ID_HEADER)
  const trimmed = headerValue?.trim()

  return trimmed ? trimmed.slice(0, 128) : randomUUID()
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}

export function createApiRequestContext(request: NextRequest, route: string) {
  const startedAt = Date.now()
  const correlationId = getIncomingCorrelationId(request)

  function log(level: ApiLogLevel, event: string, metadata: ApiMetadata = {}) {
    const payload = emitLog({
      timestamp: new Date().toISOString(),
      level,
      event,
      route,
      method: request.method,
      correlationId,
      ...metadata,
    })
    const line = JSON.stringify(payload)

    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else console.info(line)
  }

  function json<T>(body: T, init: ApiJsonInit = {}) {
    const { event = "request_completed", metadata = {}, headers, ...responseInit } = init
    const status = responseInit.status ?? 200
    const response = NextResponse.json(body, { ...responseInit, status, headers })
    response.headers.set(CORRELATION_HEADER, correlationId)
    response.headers.set(REQUEST_ID_HEADER, correlationId)
    const durationMs = Date.now() - startedAt
    const boundedMetadata = sanitizeAnalyticsMetadata(metadata)
    log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", event, {
      status,
      durationMs,
      ...boundedMetadata,
    })

    if (isAnalyticsWarehouseEnabled()) {
      void recordWarehouseEvent({
        surface: "observability",
        stage: event,
        correlation_id: correlationId,
        metadata: {
          route,
          method: request.method,
          status,
          durationMs,
          ...boundedMetadata,
        },
      }).catch(() => {})
    }

    return response
  }

  function errorJson(error: unknown, status = 500, event = "request_failed") {
    const message = getErrorMessage(error)
    log("error", event, { status, durationMs: Date.now() - startedAt, error: message })
    return json({ error: "Internal server error" }, { status, event })
  }

  return { correlationId, log, json, errorJson }
}

// ── Spikes 672-675: closed event names for new flows (no PII in events) ──
export const SPIKE_OBSERVABILITY_EVENTS = [
  "edition.minted",
  "edition.supply_exhausted",
  "collab.split_recorded",
  "drop.ticket_issued",
  "drop.claim_rejected",
  "dutch.price_computed",
  "dutch.quote_stale_rejected",
] as const;
export type SpikeObservabilityEvent = (typeof SPIKE_OBSERVABILITY_EVENTS)[number];