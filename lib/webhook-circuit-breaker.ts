/**
 * phase-215 — per-endpoint circuit breaker for outbound webhook delivery.
 *
 * Distinct from the persisted `consecutiveFailures` counter in
 * `webhook-subscriptions.ts` (which permanently deactivates a subscriber):
 * this is an in-memory, time-based breaker keyed by endpoint. It opens after
 * repeated failures, allows a single probe after a cooldown (HALF_OPEN), and
 * closes again on success. It is process-local by design; the persisted
 * counter remains the durable backstop across restarts.
 *
 * Flag: phase-215. No persisted state; clearing the process resets it.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export interface WebhookCircuit {
  state: CircuitState
  failures: number
  openedAt: number | null
  probesInFlight: number
}

export const WEBHOOK_FAILURE_THRESHOLD = 3
export const WEBHOOK_CIRCUIT_COOLDOWN_MS = 15_000
const MAX_CIRCUITS = 500

const circuits = new Map<string, WebhookCircuit>()

function keyFor(endpoint: string): string {
  // Use the safe log label (no query/userinfo) as the breaker key.
  try {
    const url = new URL(endpoint)
    return `${url.protocol}//${url.hostname}${url.pathname}`
  } catch {
    return endpoint.slice(0, 200)
  }
}

function fresh(): WebhookCircuit {
  return { state: "CLOSED", failures: 0, openedAt: null, probesInFlight: 0 }
}

/** Returns the effective state, transitioning OPEN → HALF_OPEN once cooldown elapses. */
export function getWebhookCircuitState(endpoint: string, now = Date.now()): CircuitState {
  const circuit = circuits.get(keyFor(endpoint)) ?? fresh()
  if (
    circuit.state === "OPEN" &&
    circuit.openedAt !== null &&
    now - circuit.openedAt >= WEBHOOK_CIRCUIT_COOLDOWN_MS
  ) {
    circuit.state = "HALF_OPEN"
    circuit.probesInFlight = 0
  }
  return circuit.state
}

/** True when a delivery attempt may proceed. At most one HALF_OPEN probe at a time. */
export function allowWebhookRequest(endpoint: string, now = Date.now()): boolean {
  const key = keyFor(endpoint)
  const state = getWebhookCircuitState(endpoint, now)
  if (state === "OPEN") return false
  const circuit = circuits.get(key) ?? fresh()
  if (state === "HALF_OPEN") {
    if (circuit.probesInFlight > 0) return false
    circuit.probesInFlight = 1
  }
  circuits.set(key, circuit)
  return true
}

export function recordWebhookSuccess(endpoint: string): void {
  const key = keyFor(endpoint)
  circuits.set(key, fresh())
  if (circuits.size > MAX_CIRCUITS) {
    const oldest = circuits.keys().next().value
    if (oldest !== undefined) circuits.delete(oldest)
  }
}

export function recordWebhookFailure(endpoint: string, now = Date.now()): WebhookCircuit {
  const key = keyFor(endpoint)
  const circuit = circuits.get(key) ?? fresh()
  // A failed HALF_OPEN probe re-opens immediately, as do ordinary failures.
  circuit.failures += 1
  circuit.probesInFlight = 0
  if (circuit.failures >= WEBHOOK_FAILURE_THRESHOLD || circuit.state === "HALF_OPEN") {
    circuit.state = "OPEN"
    circuit.openedAt = now
  }
  circuits.set(key, circuit)
  return { ...circuit }
}

/** Test helper: clear all breaker state. */
export function resetWebhookCircuits(): void {
  circuits.clear()
}
