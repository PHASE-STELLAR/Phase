/**
 * Outbound webhook subscriptions — partial slice of Spike 664 (issue #527).
 *
 * Stores third-party subscriber endpoints and their per-endpoint signing
 * secrets, keyed by id. CRUD goes through `lib/json-store.ts`'s
 * `updateStore` / `readStore`, the same per-process file-lock + atomic
 * tmp+rename pattern every other JSON sidecar in this repo uses — see
 * `lib/json-store.ts` for the single-instance-safety scope limit.
 *
 * Flag: phase-154 (NEXT_PUBLIC_FEATURE_PHASE_154 / FEATURE_PHASE_154).
 * Rollback: unset the flag and restart. Subscription rows stay on disk,
 * inert — no migration to undo.
 *
 * SCOPE NOTE (see PR description "Scope and residual risk"): this is a
 * partial slice of issue #527. Endpoint verification handshake, SSRF
 * fencing, durable cross-instance delivery ordering, and a redelivery UI
 * are explicitly NOT implemented here.
 */

import { randomBytes, randomUUID } from "node:crypto"
import { readStore, updateStore } from "@/lib/json-store"

export type WebhookEventType =
  | "settle.verified"
  | "market.offer_accepted"
  | "faucet.claim_completed"

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  "settle.verified",
  "market.offer_accepted",
  "faucet.claim_completed",
]

export type WebhookSubscription = {
  id: string
  url: string
  /** Hex-encoded signing secret, shown once on creation; never returned by GET. */
  secret: string
  events: WebhookEventType[]
  active: boolean
  /** Circuit breaker: disabled after too many consecutive delivery failures. */
  consecutiveFailures: number
  lastDeliveryAt?: number
  lastDeliveryStatus?: "ok" | "failed"
  createdAt: number
  updatedAt: number
}

export type WebhookSubscriptionStore = Record<string, WebhookSubscription>

/** Disable a subscription after this many consecutive delivery failures. */
export const MAX_CONSECUTIVE_FAILURES = 10

function generateSecret(): string {
  return randomBytes(32).toString("hex")
}

export type CreateSubscriptionInput = {
  url: string
  events: WebhookEventType[]
}

function assertValidUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("Invalid subscription url")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Subscription url must be http(s)")
  }
}

/**
 * Creates a subscription with a freshly generated secret. The secret is
 * returned only on this call — callers must store it client-side.
 */
export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<WebhookSubscription> {
  assertValidUrl(input.url)
  const events = input.events.filter((e) => WEBHOOK_EVENT_TYPES.includes(e))
  if (events.length === 0) {
    throw new Error("At least one valid event type is required")
  }

  const now = Date.now()
  const subscription: WebhookSubscription = {
    id: randomUUID(),
    url: input.url,
    secret: generateSecret(),
    events,
    active: true,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  }

  await updateStore<WebhookSubscriptionStore>("webhookSubscriptions", (store) => {
    store[subscription.id] = subscription
  })

  return subscription
}

export async function listSubscriptions(): Promise<WebhookSubscription[]> {
  const store = await readStore<WebhookSubscriptionStore>("webhookSubscriptions", () => ({}))
  return Object.values(store).sort((a, b) => b.createdAt - a.createdAt)
}

export async function getSubscription(id: string): Promise<WebhookSubscription | null> {
  const store = await readStore<WebhookSubscriptionStore>("webhookSubscriptions", () => ({}))
  return store[id] ?? null
}

/** Subscriptions still eligible for delivery of a given event type. */
export async function listActiveSubscriptionsForEvent(
  eventType: WebhookEventType,
): Promise<WebhookSubscription[]> {
  const all = await listSubscriptions()
  return all.filter((s) => s.active && s.events.includes(eventType))
}

export async function deleteSubscription(id: string): Promise<boolean> {
  return updateStore<WebhookSubscriptionStore, boolean>("webhookSubscriptions", (store) => {
    if (!store[id]) return false
    delete store[id]
    return true
  })
}

/**
 * Rotates the signing secret for a subscription. Returns the new secret, or
 * null if the subscription does not exist.
 */
export async function rotateSubscriptionSecret(id: string): Promise<string | null> {
  return updateStore<WebhookSubscriptionStore, string | null>(
    "webhookSubscriptions",
    (store) => {
      const existing = store[id]
      if (!existing) return null
      const secret = generateSecret()
      store[id] = { ...existing, secret, updatedAt: Date.now() }
      return secret
    },
  )
}

/**
 * Records the outcome of a delivery attempt and applies the circuit
 * breaker: a subscription is deactivated once it has failed
 * `MAX_CONSECUTIVE_FAILURES` deliveries in a row. A success resets the
 * counter.
 */
export async function recordDeliveryOutcome(
  id: string,
  ok: boolean,
): Promise<WebhookSubscription | null> {
  return updateStore<WebhookSubscriptionStore, WebhookSubscription | null>(
    "webhookSubscriptions",
    (store) => {
      const existing = store[id]
      if (!existing) return null
      const consecutiveFailures = ok ? 0 : existing.consecutiveFailures + 1
      const updated: WebhookSubscription = {
        ...existing,
        consecutiveFailures,
        lastDeliveryAt: Date.now(),
        lastDeliveryStatus: ok ? "ok" : "failed",
        active: existing.active && consecutiveFailures < MAX_CONSECUTIVE_FAILURES,
        updatedAt: Date.now(),
      }
      store[id] = updated
      return updated
    },
  )
}

/** Returns a subscription with its secret masked, for API responses. */
export function maskSubscription(
  subscription: WebhookSubscription,
): Omit<WebhookSubscription, "secret"> & { secretPreview: string } {
  const { secret, ...rest } = subscription
  return {
    ...rest,
    secretPreview: `${secret.slice(0, 4)}…${secret.slice(-4)}`,
  }
}
