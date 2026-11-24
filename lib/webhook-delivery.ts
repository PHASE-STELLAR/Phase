/**
 * Outbound webhook delivery — phase-154 slice extended by phase-215.
 *
 * Adds to the original HMAC-signed, retried delivery:
 *   - SSRF fence (https-only, private-range denial, DNS pinning, no redirects)
 *   - per-endpoint circuit breaker
 *   - append-only delivery log consumed by the admin redelivery UI
 *   - on-demand replay of a recorded event
 *   - phase-215 flag gate (off = no emission at all)
 *
 * The signing secret is used only to compute the HMAC. It is never logged or
 * persisted in the delivery log (see `sanitizeForLog`).
 *
 * Rollback: unset phase-215 — `dispatchWebhookEvent` is a no-op and every
 * admin route returns 404; subscription rows remain inert on disk.
 */

import { createHmac, randomUUID } from "node:crypto"
import {
  listActiveSubscriptionsForEvent,
  getSubscription,
  isPhase215Enabled,
  webhook215RollbackNote,
  type WebhookEventType,
  type WebhookSubscription,
} from "@/lib/webhook-subscriptions"
import {
  postToPinnedEndpoint,
  resolveSafeEndpoint,
  SsrfFenceError,
} from "@/lib/webhook-ssrf"
import {
  allowWebhookRequest,
  recordWebhookFailure,
  recordWebhookSuccess,
} from "@/lib/webhook-circuit-breaker"
import {
  appendDelivery,
  claimEventId,
  getDelivery,
} from "@/lib/webhook-delivery-log"
import { backoffDelayMs } from "@/lib/phase-transport-error"

export { isPhase215Enabled, webhook215RollbackNote }

const DELIVERY_TIMEOUT_MS = 5_000
/** Three bounded attempts. Retry-After is capped by the backoff policy. */
const MAX_ATTEMPTS = 3

export function signWebhookDelivery(
  secret: string,
  timestamp: number,
  nonce: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${rawBody}`, "utf8")
    .digest("hex")
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Deliver one signed event to one subscription; never throws. */
async function deliverToSubscription(
  subscription: WebhookSubscription,
  eventType: WebhookEventType,
  eventId: string,
  payload: unknown,
): Promise<boolean> {
  if (!isPhase215Enabled()) return false

  const rawBody = JSON.stringify({
    event: eventType,
    eventId,
    deliveredAt: Date.now(),
    data: payload,
  })
  const nonce = randomUUID()

  // The safe label (no query/userinfo) is used for the circuit key and the log.
  let endpointLabel = subscription.url
  try {
    endpointLabel = new URL(subscription.url).origin + new URL(subscription.url).pathname
  } catch {
    // Invalid rows are skipped by the fence below; keep a bounded label.
    endpointLabel = "invalid-endpoint"
  }

  if (!allowWebhookRequest(endpointLabel)) {
    await appendDelivery({
      eventId, event: eventType, subscriptionId: subscription.id,
      endpoint: endpointLabel, status: "skipped", attempt: 0,
      httpStatus: null, reason: "circuit_open", payload,
    }).catch(() => undefined)
    return false
  }

  let delivered = false
  let lastStatus: number | null = null
  let lastReason: string | undefined
  let usedAttempts = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    usedAttempts = attempt
    try {
      // Re-verify DNS on every attempt to defeat DNS rebinding between retries.
      const endpoint = await resolveSafeEndpoint(subscription.url)
      endpointLabel = endpoint.logLabel
      const timestamp = Date.now()
      const signature = signWebhookDelivery(subscription.secret, timestamp, nonce, rawBody)
      const result = await postToPinnedEndpoint(
        endpoint,
        {
          "content-type": "application/json",
          "x-phase-signature": `sha256=${signature}`,
          "x-phase-timestamp": String(timestamp),
          "x-phase-nonce": nonce,
          "x-phase-event": eventType,
        },
        rawBody,
        DELIVERY_TIMEOUT_MS,
      )
      lastStatus = result.status
      if (result.ok) {
        delivered = true
        break
      }
      lastReason = `http_${result.status ?? "unknown"}`
    } catch (error) {
      lastReason =
        error instanceof SsrfFenceError
          ? `ssrf_${error.reason}`
          : "transport_error"
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(backoffDelayMs(attempt - 1, null, {
        baseDelayMs: 500, maxDelayMs: 4_000, jitterRatio: 0.2,
      }))
    }
  }

  if (delivered) recordWebhookSuccess(endpointLabel)
  else recordWebhookFailure(endpointLabel)

  await appendDelivery({
    eventId,
    event: eventType,
    subscriptionId: subscription.id,
    endpoint: endpointLabel,
    status: delivered ? "delivered" : "failed",
    attempt: usedAttempts,
    httpStatus: lastStatus,
    reason: delivered ? undefined : lastReason,
    payload,
  }).catch(() => undefined)

  return delivered
}

/**
 * Emit a domain event to every active subscriber. The event id is claimed
 * exactly once, so a repeated call for the same real transition does nothing.
 */
export async function dispatchWebhookEvent(
  eventType: WebhookEventType,
  payload: unknown,
  eventId: string,
): Promise<{ attempted: number; delivered: number }> {
  if (!isPhase215Enabled()) return { attempted: 0, delivered: 0 }
  if (!(await claimEventId(eventId))) return { attempted: 0, delivered: 0 }

  const subscriptions = await listActiveSubscriptionsForEvent(eventType)
  if (subscriptions.length === 0) return { attempted: 0, delivered: 0 }

  const results = await Promise.allSettled(
    subscriptions.map((s) => deliverToSubscription(s, eventType, eventId, payload)),
  )
  const delivered = results.filter(
    (r) => r.status === "fulfilled" && r.value === true,
  ).length
  return { attempted: subscriptions.length, delivered }
}

/**
 * Re-deliver a recorded event to its original subscriber. The signing secret
 * is read from the live subscription row, never from the log.
 */
export async function redeliverWebhookEvent(
  deliveryId: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!isPhase215Enabled()) return { ok: false, reason: "flag_disabled" }
  const record = await getDelivery(deliveryId)
  if (!record) return { ok: false, reason: "not_found" }
  const subscription = await getSubscription(record.subscriptionId)
  if (!subscription) return { ok: false, reason: "subscription_missing" }

  const eventType = record.event as WebhookEventType
  const delivered = await deliverToSubscription(
    subscription,
    eventType,
    record.eventId,
    record.payload,
  )
  if (delivered) {
    await appendDelivery({
      eventId: record.eventId,
      event: record.event,
      subscriptionId: subscription.id,
      endpoint: record.endpoint,
      status: "redelivered",
      attempt: 1,
      httpStatus: 200,
      payload: record.payload,
    }).catch(() => undefined)
  }
  return delivered ? { ok: true } : { ok: false, reason: "delivery_failed" }
}
