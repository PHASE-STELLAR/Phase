/**
 * phase-214 — Horizon/RPC transport taxonomy + bounded retry policy.
 *
 * phase-161 shipped code-stable contract descriptors 1..39 but no transport
 * classes and no retry policy. This module supplies typed 429/5xx/timeout/
 * network errors, `Retry-After` parsing, and a bounded exponential-backoff
 * helper with jitter. Transport codes are mapped into the same descriptor
 * shape via `lib/phase-error-taxonomy.ts` (disjoint 1000+ range).
 *
 * Every retry loop is bounded two ways: a hard maximum attempt count and a
 * maximum per-attempt delay. `Retry-After` is honoured as a floor (capped), so
 * a server asking for a long cool-down is respected without trusting it
 * unboundedly.
 *
 * Flag: phase-214. Rollback: unset it and callers keep using the legacy
 * string helpers in lib/phase-host-error.ts. No persisted state.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  describeAnyPhaseError,
  isPhase214Enabled,
  TRANSPORT_ERROR_CODES,
  phase214RollbackNote,
  type PhaseErrorDescriptor,
} from "@/lib/phase-error-taxonomy"

export { isPhase214Enabled, phase214RollbackNote }

export type TransportErrorKind = "rate-limit" | "server" | "timeout" | "network"

const MAX_RETRY_AFTER_MS = 60_000

export class PhaseTransportError extends Error {
  readonly kind: TransportErrorKind
  readonly retryable: boolean
  readonly status: number | null
  readonly retryAfterMs: number | null
  readonly code: number

  constructor(opts: {
    kind: TransportErrorKind
    code: number
    message: string
    retryable?: boolean
    status?: number | null
    retryAfterMs?: number | null
    cause?: unknown
  }) {
    super(opts.message)
    this.name = new.target.name
    this.kind = opts.kind
    this.code = opts.code
    this.retryable = opts.retryable ?? true
    this.status = opts.status ?? null
    this.retryAfterMs = opts.retryAfterMs ?? null
    if (opts.cause !== undefined) (this as Error & { cause?: unknown }).cause = opts.cause
  }

  get descriptor(): PhaseErrorDescriptor {
    const found = describeAnyPhaseError(this.code)
    if (!found) throw new Error(`No descriptor for transport code ${this.code}`)
    return found
  }
}

export class RateLimitError extends PhaseTransportError {
  constructor(retryAfterMs: number | null = null, status = 429) {
    super({
      kind: "rate-limit",
      code: TRANSPORT_ERROR_CODES.RATE_LIMITED,
      message: "Upstream rate limit reached (HTTP 429)",
      status,
      retryAfterMs,
    })
  }
}

export class UpstreamServerError extends PhaseTransportError {
  constructor(status: number) {
    super({
      kind: "server",
      code: TRANSPORT_ERROR_CODES.UPSTREAM_5XX,
      message: `Upstream server error (HTTP ${status})`,
      status,
    })
  }
}

export class TransportTimeoutError extends PhaseTransportError {
  constructor(status: number | null = null) {
    super({
      kind: "timeout",
      code: TRANSPORT_ERROR_CODES.TIMEOUT,
      message: status ? `Upstream timed out (HTTP ${status})` : "Upstream request timed out",
      status,
    })
  }
}

export class NetworkUnreachableError extends PhaseTransportError {
  constructor(cause?: unknown) {
    super({
      kind: "network",
      code: TRANSPORT_ERROR_CODES.NETWORK_UNREACHABLE,
      message: "Upstream network unreachable",
      cause,
    })
  }
}

/**
 * Parse a `Retry-After` header. Accepts delta-seconds and HTTP dates, clamps
 * to [0, MAX_RETRY_AFTER_MS], and returns null for anything unparseable.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (typeof header !== "string") return null
  const value = header.trim()
  if (!value) return null
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds < 0) return null
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return Math.min(Math.max(parsed - now, 0), MAX_RETRY_AFTER_MS)
}

type ErrorLike = Error & {
  status?: number
  statusCode?: number
  retryAfterMs?: number
  name?: string
  code?: string | number
  response?: { status?: number; headers?: { get?: (key: string) => string | null } }
  headers?: { get?: (key: string) => string | null }
}

function retryAfterFrom(raw: ErrorLike): number | null {
  if (typeof raw.retryAfterMs === "number" && Number.isFinite(raw.retryAfterMs)) {
    return Math.min(Math.max(raw.retryAfterMs, 0), MAX_RETRY_AFTER_MS)
  }
  const headers = raw.response?.headers ?? raw.headers
  const header = headers?.get?.("retry-after") ?? null
  return parseRetryAfter(header)
}

/**
 * Classify a raw thrown value into a transport error. Returns `null` when the
 * value is not a recognisable transport failure (e.g. a contract HostError).
 */
export function classifyTransportError(raw: unknown): PhaseTransportError | null {
  if (raw instanceof PhaseTransportError) return raw
  if (!raw || (typeof raw !== "object" && typeof raw !== "string")) return null

  const error: ErrorLike =
    raw instanceof Error
      ? (raw as ErrorLike)
      : typeof raw === "string"
        ? ({ message: raw, name: "Error" } as unknown as ErrorLike)
        : (raw as ErrorLike)
  const message = typeof error.message === "string" ? error.message : String(raw)
  const status = error.status ?? error.statusCode ?? error.response?.status ?? null

  if (status === 429 || /\b(429|rate.?limit(?:ed)?)\b/i.test(message)) {
    return new RateLimitError(retryAfterFrom(error), status ?? 429)
  }
  if (status === 408 || status === 504 || error.name === "AbortError" || /\b(timeout|timed out|ETIMEDOUT)\b/i.test(message)) {
    return new TransportTimeoutError(status)
  }
  if (status !== null && status >= 500 && status < 600) {
    return new UpstreamServerError(status)
  }
  if (/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|network (?:error|unreachable))\b/i.test(message)) {
    return new NetworkUnreachableError(raw)
  }
  return null
}

/** Unified descriptor lookup: contract code 1..39 or transport code 1000+. */
export function mapPhaseError(raw: unknown): PhaseErrorDescriptor | null {
  if (!isPhase214Enabled()) return null
  const transport = classifyTransportError(raw)
  if (transport) return transport.descriptor
  return null
}

export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitterRatio: 0.2,
  maxRetryAfterMs: MAX_RETRY_AFTER_MS,
} as const

export type RetryPolicy = {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  maxRetryAfterMs?: number
}

function resolvePolicy(policy: RetryPolicy) {
  const maxAttempts = Math.min(Math.max(Math.floor(policy.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts), 1), 10)
  return {
    maxAttempts,
    baseDelayMs: policy.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: policy.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    jitterRatio: policy.jitterRatio ?? DEFAULT_RETRY_POLICY.jitterRatio,
    maxRetryAfterMs: policy.maxRetryAfterMs ?? DEFAULT_RETRY_POLICY.maxRetryAfterMs,
  }
}

/**
 * Bounded exponential backoff with jitter. `attempt` is zero-based.
 * A `Retry-After` value is used as a floor, capped at `maxRetryAfterMs`.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs: number | null = null,
  policy: RetryPolicy = {},
  rng: () => number = Math.random,
): number {
  const resolved = resolvePolicy(policy)
  const index = Math.max(0, Math.floor(attempt))
  const exponential = Math.min(
    resolved.maxDelayMs,
    resolved.baseDelayMs * Math.pow(2, index),
  )
  const jitter = exponential * resolved.jitterRatio * (rng() * 2 - 1)
  const backoff = Math.max(0, Math.min(exponential + jitter, resolved.maxDelayMs))
  if (retryAfterMs === null) return backoff
  const floor = Math.min(Math.max(retryAfterMs, 0), resolved.maxRetryAfterMs)
  return Math.max(backoff, floor)
}

export type RetryRunnerOptions = RetryPolicy & {
  retryAfterMs?: number | null
  sleep?: (ms: number) => Promise<void>
  shouldRetry?: (error: unknown) => boolean
}

/**
 * Run `fn` with bounded retries of retryable transport failures. Never loops
 * more than `maxAttempts` times and never sleeps longer than the policy caps.
 */
export async function withTransportRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryRunnerOptions = {},
): Promise<T> {
  const policy = resolvePolicy(options)
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => {
    const transport = classifyTransportError(error)
    return transport ? transport.retryable : false
  })

  let lastError: unknown
  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (attempt === policy.maxAttempts - 1 || !shouldRetry(error)) break
      const transport = classifyTransportError(error)
      const delay = backoffDelayMs(attempt, transport?.retryAfterMs ?? null, policy)
      await sleep(delay)
    }
  }
  throw lastError
}

/** Flag stub kept for symmetry with other phase modules. */
export function isTransportRetryEnabled(): boolean {
  return isFeatureEnabled("phase-214")
}
