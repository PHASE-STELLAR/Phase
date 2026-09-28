/**
 * Centralized retry logic for the quadruple pipeline: nanobanana, IPFS (Pinata),
 * Soroban contract minting, and market offer-book operations.
 *
 * All four services can return 429 (rate limit) under load. This module
 * coordinates exponential backoff + jitter across the pipeline to prevent
 * thundering herd.
 */

export interface RetryStrategy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitterFactor: number
  isRetryable: (status: number, error: unknown) => boolean
}

export const DEFAULT_RETRY_STRATEGY: RetryStrategy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  jitterFactor: 0.2,
  isRetryable: (status, error) => {
    if (status === 429 || status === 503 || status === 504) return true
    const msg = error instanceof Error ? error.message.toLowerCase() : ""
    return /timeout|econnrefused|enotfound|temporary/i.test(msg)
  },
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function computeBackoffDelay(
  attempt: number,
  strategy: RetryStrategy,
): number {
  const exponential = Math.pow(2, attempt) * strategy.baseDelayMs
  const capped = Math.min(exponential, strategy.maxDelayMs)
  const jitter = capped * strategy.jitterFactor * Math.random()
  return capped + jitter
}

/**
 * Wraps a fetch call with exponential backoff + jitter retry logic.
 * Re-throws the error after maxRetries attempts.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  strategy = DEFAULT_RETRY_STRATEGY,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= strategy.maxRetries; attempt++) {
    try {
      const res = await fetch(input, init)
      if (strategy.isRetryable(res.status, null)) {
        if (attempt < strategy.maxRetries) {
          const delayMs = computeBackoffDelay(attempt, strategy)
          await sleep(delayMs)
          continue
        }
      }
      return res
    } catch (e) {
      lastError = e
      if (strategy.isRetryable(0, e) && attempt < strategy.maxRetries) {
        const delayMs = computeBackoffDelay(attempt, strategy)
        await sleep(delayMs)
        continue
      }
      throw e
    }
  }
  throw lastError ?? new Error("Fetch retry exhausted")
}

/**
 * Async function that returns a response-like object with status and text/json methods.
 */
export async function callWithRetry<T>(
  label: string,
  fn: () => Promise<Response>,
  strategy = DEFAULT_RETRY_STRATEGY,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= strategy.maxRetries; attempt++) {
    try {
      const res = await fn()
      if (!strategy.isRetryable(res.status, null)) return res.json() as Promise<T>
      if (attempt < strategy.maxRetries) {
        const delayMs = computeBackoffDelay(attempt, strategy)
        await sleep(delayMs)
        continue
      }
      return res.json() as Promise<T>
    } catch (e) {
      lastError = e
      if (strategy.isRetryable(0, e) && attempt < strategy.maxRetries) {
        const delayMs = computeBackoffDelay(attempt, strategy)
        await sleep(delayMs)
        continue
      }
      throw e
    }
  }
  throw lastError ?? new Error(`${label}: retry exhausted`)
}

/**
 * Predicate: should we retry given a response code and error?
 */
export function shouldRetry(status: number, error: unknown, strategy = DEFAULT_RETRY_STRATEGY): boolean {
  return strategy.isRetryable(status, error)
}
