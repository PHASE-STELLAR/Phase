/**
 * Outbound webhook delivery — partial slice of Spike 664 (issue #527).
 *
 * Mirrors `app/api/webhooks/nanobanana/route.ts`'s inbound HMAC verifier in
 * reverse: that route takes `x-nanobanana-signature: sha256=<hex>` and
 * recomputes `HMAC-SHA256(secret, rawBody)` to verify a request PHASE
 * receives. Here PHASE is the sender, so the same primitive is used to
 * *produce* a signature a subscriber can verify: `HMAC-SHA256(secret,
 * "<timestamp>.<nonce>.<rawBody>")`, sent as `x-phase-signature: sha256=<hex>`
 * alongside `x-phase-timestamp` and `x-phase-nonce` so the receiver can
 * reject replayed deliveries (the inbound route has no timestamp/nonce
 * because NanoBanana does not send one — subscribers here get the stronger
 * check since PHASE controls both ends of this contract).
 *
 * Flag: phase-154. Rollback: unset the flag; see lib/webhook-subscriptions.ts.
 *
 * SCOPE NOTE: delivery here is at-least-once, best-effort, fire-and-forget
 * per subscriber with a small fixed retry/backoff schedule. It is NOT the
 * durable, cross-instance-ordered, circuit-broken-with-redelivery-UI system
 * the full issue asks for — see PR description "Scope and residual risk".
 */

import { createHmac, randomUUID } from "node:crypto"
import {
  listActiveSubscriptionsForEvent,
  recordDeliveryOutcome,
  type WebhookEventType,
  type WebhookSubscription,
} from "@/lib/webhook-subscriptions"

const DELIVERY_TIMEOUT_MS = 5_000
/** Fixed backoff schedule: first attempt immediate, then two retries. */
const RETRY_DELAYS_MS = [0, 1_000, 4_000]

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

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Delivers one event payload to one subscription with retry/backoff.
 * Always resolves (never throws) so callers can fan out with
 * `Promise.allSettled` semantics without a rejection derailing siblings.
 */
export async function deliverToSubscription(
  subscription: WebhookSubscription,
  eventType: WebhookEventType,
  payload: unknown,
): Promise<boolean> {
  const rawBody = JSON.stringify({
    event: eventType,
    deliveredAt: Date.now(),
    data: payload,
  })
  const nonce = randomUUID()

  let delivered = false
  for (const delay of RETRY_DELAYS_MS) {
    await sleep(delay)
    const timestamp = Date.now()
    const signature = signWebhookDelivery(subscription.secret, timestamp, nonce, rawBody)
    delivered = await postOnce(
      subscription.url,
      {
        "content-type": "application/json",
        "x-phase-signature": `sha256=${signature}`,
        "x-phase-timestamp": String(timestamp),
        "x-phase-nonce": nonce,
        "x-phase-event": eventType,
      },
      rawBody,
    )
    if (delivered) break
  }

  await recordDeliveryOutcome(subscription.id, delivered).catch(() => {})
  return delivered
}

/**
 * Fans an event out to every active subscription registered for it.
 * Fire-and-forget per subscriber; one subscriber's failure never blocks or
 * fails another's delivery.
 */
export async function dispatchWebhookEvent(
  eventType: WebhookEventType,
  payload: unknown,
): Promise<{ attempted: number; delivered: number }> {
  const subscriptions = await listActiveSubscriptionsForEvent(eventType)
  if (subscriptions.length === 0) return { attempted: 0, delivered: 0 }

  const results = await Promise.allSettled(
    subscriptions.map((s) => deliverToSubscription(s, eventType, payload)),
  )

  const delivered = results.filter(
    (r) => r.status === "fulfilled" && r.value === true,
  ).length

  return { attempted: subscriptions.length, delivered }
}
