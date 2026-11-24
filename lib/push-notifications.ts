/**
 * Push notifications for replies and mentions — phase-92 + phase-252 (#703)
 *
 * Users previously missed engagement (signal replies, @mentions) without
 * actively polling `/api/notifications`. This module lets a wallet register
 * a browser Push subscription and provides a best-effort dispatch queue that
 * fans an in-app notification out to that wallet's registered push endpoints.
 *
 * phase-252 (#703) adds:
 * - Crash-safe serialized subscription persistence with per-wallet dedupe keys
 * - Event-level burst deduplication so concurrent bursts emit 1 notification
 * - Bounded-concurrency batch delivery
 * - Per-subscription failure circuit breakers + stale subscription pruning
 * - Closed security counters (no wallet in labels)
 *
 * Feature flags:
 * - phase-92 (NEXT_PUBLIC_FEATURE_PHASE_92 / FEATURE_PHASE_92)
 * - phase-252 (NEXT_PUBLIC_FEATURE_PHASE_252 / FEATURE_PHASE_252)
 * Rollback: unset phase-252 -> legacy notification path; subscriptions inert for
 *           phase-252 circuit-breaker/dedupe; unset phase-92 -> FLAG_DISABLED.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { readStore, updateStoreWithReader } from "@/lib/json-store"
import { isAnalyticsWarehouseEnabled, recordWarehouseEvent } from "@/lib/analytics-warehouse"
import { incSecurityCounter } from "@/lib/security-counters"

export function isPhase92Enabled(): boolean {
  return isFeatureEnabled("phase-92")
}

export function isPhase252Enabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-252", wallet ? { wallet } : undefined)
}

export function flag92RollbackNote(): string {
  return "Rollback phase-92: unset NEXT_PUBLIC_FEATURE_PHASE_92 / FEATURE_PHASE_92 or set to 0/false and restart. Registered subscriptions remain on disk but stop receiving dispatches; in-app notifications keep working unchanged."
}

const STELLAR_G_REGEX = /^G[A-Z2-7]{55}$/
const CIRCUIT_FAILURE_THRESHOLD = 3
const PRUNE_FAILURE_THRESHOLD = 5
const CIRCUIT_OPEN_MS = 5 * 60 * 1000
const EVENT_DEDUPE_TTL_MS = 15 * 60 * 1000
const DEFAULT_STALE_SUBSCRIPTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_BATCH_CONCURRENCY = 4

// ─── schemas ─────────────────────────────────────────────────────────────────

export const PushSubscriptionKeysSchema = z.object({
  p256dh: z.string().trim().min(1).max(256),
  auth: z.string().trim().min(1).max(256),
})

export const PushSubscriptionSchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX, "Invalid Stellar G address"),
  endpoint: z.string().trim().url().max(2048),
  keys: PushSubscriptionKeysSchema,
  subscribedAt: z.number().int().min(0),
  dedupeKey: z.string().trim().min(1).max(128).optional(),
  consecutiveFailures: z.number().int().min(0).optional(),
  circuitOpenUntil: z.number().int().min(0).optional(),
  lastFailureAt: z.number().int().min(0).optional(),
  lastSuccessAt: z.number().int().min(0).optional(),
})

export type PushSubscription = z.infer<typeof PushSubscriptionSchema>

export const SubscribePushRequestSchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX),
  endpoint: z.string().trim().url().max(2048),
  keys: PushSubscriptionKeysSchema,
})

export type SubscribePushRequest = z.infer<typeof SubscribePushRequestSchema>

export const PushNotificationEventSchema = z.enum(["signal_reply", "mention"])
export type PushNotificationEvent = z.infer<typeof PushNotificationEventSchema>

// ─── structured errors ───────────────────────────────────────────────────────

export class PushNotificationError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "NOT_FOUND"
  constructor(code: PushNotificationError["code"], message: string) {
    super(message)
    this.name = "PushNotificationError"
    this.code = code
  }
}

// ─── dedupe helpers ──────────────────────────────────────────────────────────

export function computeSubscriptionDedupeKey(wallet: string, endpoint: string): string {
  return createHash("sha256")
    .update(`${wallet.trim().toUpperCase()}|${endpoint.trim()}`, "utf8")
    .digest("hex")
}

export function computePushEventDedupeKey(
  wallet: string,
  event: PushNotificationEvent,
  payload: Record<string, unknown>,
  eventId?: string,
): string {
  const discriminator =
    eventId?.trim() ||
    JSON.stringify(
      Object.keys(payload)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = payload[k]
          return acc
        }, {}),
    )
  return createHash("sha256")
    .update(`${wallet.trim().toUpperCase()}|${event}|${discriminator}`, "utf8")
    .digest("hex")
}

// ─── store helpers ───────────────────────────────────────────────────────────

async function subscriptionsFilePath(): Promise<string> {
  const { serverDataJsonPath } = await import("@/lib/server-data-paths")
  return serverDataJsonPath("pushSubscriptions")
}

type SubscriptionStore = Record<string, PushSubscription[]>

function normalizeSubscriptionStore(raw: unknown): SubscriptionStore {
  if (!raw || typeof raw !== "object") return {}
  const parsed = raw as Record<string, unknown[]>
  const out: SubscriptionStore = {}
  for (const [wallet, list] of Object.entries(parsed)) {
    const clean = (Array.isArray(list) ? list : [])
      .map((v) => PushSubscriptionSchema.safeParse(v))
      .filter((r): r is { success: true; data: PushSubscription } => r.success)
      .map((r) => r.data)
    if (clean.length > 0) out[wallet] = clean
  }
  return out
}

async function readSubscriptionStore(): Promise<SubscriptionStore> {
  if (isPhase252Enabled()) {
    const raw = await readStore<SubscriptionStore>("pushSubscriptions", () => ({}))
    return normalizeSubscriptionStore(raw)
  }
  try {
    const fp = await subscriptionsFilePath()
    const raw = await readFile(fp, "utf8")
    return normalizeSubscriptionStore(JSON.parse(raw))
  } catch {
    return {}
  }
}

async function writeSubscriptionStore(data: SubscriptionStore): Promise<void> {
  const fp = await subscriptionsFilePath()
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(data, null, 2), "utf8")
}

type EventDedupeStore = {
  events: Record<string, number>
}

function normalizeEventDedupeStore(raw: unknown): EventDedupeStore {
  const r = raw as Partial<EventDedupeStore> | null | undefined
  if (!r || typeof r !== "object" || !r.events || typeof r.events !== "object") {
    return { events: {} }
  }
  return { events: r.events }
}

async function claimPushEventOnce(dedupeKey: string, now: number): Promise<boolean> {
  return updateStoreWithReader<EventDedupeStore, boolean>(
    "pushEventDedupe",
    normalizeEventDedupeStore,
    (store) => {
      // Prune expired entries to keep sidecar bounded
      for (const [k, ts] of Object.entries(store.events)) {
        if (now - ts >= EVENT_DEDUPE_TTL_MS) {
          delete store.events[k]
        }
      }
      if (store.events[dedupeKey] !== undefined) {
        return false
      }
      store.events[dedupeKey] = now
      return true
    },
  )
}

// ─── public API ──────────────────────────────────────────────────────────────

export async function subscribeToPush(req: SubscribePushRequest): Promise<PushSubscription> {
  if (!isPhase92Enabled()) {
    throw new PushNotificationError("FLAG_DISABLED", "Push notifications disabled (phase-92 flag off)")
  }
  const parsed = SubscribePushRequestSchema.safeParse(req)
  if (!parsed.success) {
    throw new PushNotificationError("VALIDATION_FAILED", parsed.error.message)
  }

  const dedupeKey = computeSubscriptionDedupeKey(parsed.data.wallet, parsed.data.endpoint)
  const sub: PushSubscription = PushSubscriptionSchema.parse({
    ...parsed.data,
    subscribedAt: Date.now(),
    ...(isPhase252Enabled(parsed.data.wallet)
      ? { dedupeKey, consecutiveFailures: 0, circuitOpenUntil: 0 }
      : {}),
  })

  if (isPhase252Enabled(parsed.data.wallet)) {
    return updateStoreWithReader<SubscriptionStore, PushSubscription>(
      "pushSubscriptions",
      normalizeSubscriptionStore,
      (store) => {
        const existing = store[sub.wallet] ?? []
        const deduped = existing.filter(
          (s) => s.endpoint !== sub.endpoint && s.dedupeKey !== dedupeKey,
        )
        store[sub.wallet] = [...deduped, sub].slice(-10)
        return sub
      },
    )
  }

  const store = await readSubscriptionStore()
  const existing = store[sub.wallet] ?? []
  const deduped = existing.filter((s) => s.endpoint !== sub.endpoint)
  store[sub.wallet] = [...deduped, sub].slice(-10) // cap per-wallet endpoints
  await writeSubscriptionStore(store)
  return sub
}

export async function unsubscribeFromPush(wallet: string, endpoint: string): Promise<void> {
  if (!isPhase92Enabled()) {
    throw new PushNotificationError("FLAG_DISABLED", "Push notifications disabled")
  }
  if (isPhase252Enabled(wallet)) {
    const dedupeKey = computeSubscriptionDedupeKey(wallet, endpoint)
    await updateStoreWithReader<SubscriptionStore, void>(
      "pushSubscriptions",
      normalizeSubscriptionStore,
      (store) => {
        const existing = store[wallet] ?? []
        const filtered = existing.filter(
          (s) => s.endpoint !== endpoint && s.dedupeKey !== dedupeKey,
        )
        if (filtered.length === existing.length) {
          throw new PushNotificationError("NOT_FOUND", "No matching push subscription for that endpoint")
        }
        if (filtered.length > 0) store[wallet] = filtered
        else delete store[wallet]
      },
    )
    return
  }

  const store = await readSubscriptionStore()
  const existing = store[wallet] ?? []
  const filtered = existing.filter((s) => s.endpoint !== endpoint)
  if (filtered.length === existing.length) {
    throw new PushNotificationError("NOT_FOUND", "No matching push subscription for that endpoint")
  }
  if (filtered.length > 0) store[wallet] = filtered
  else delete store[wallet]
  await writeSubscriptionStore(store)
}

export async function getPushSubscriptions(wallet: string): Promise<PushSubscription[]> {
  const store = await readSubscriptionStore()
  return store[wallet] ?? []
}

export async function pruneStalePushSubscriptions(
  maxAgeMs: number = DEFAULT_STALE_SUBSCRIPTION_MS,
  now: number = Date.now(),
): Promise<number> {
  if (!isPhase252Enabled()) return 0
  return updateStoreWithReader<SubscriptionStore, number>(
    "pushSubscriptions",
    normalizeSubscriptionStore,
    (store) => {
      let pruned = 0
      for (const [wallet, list] of Object.entries(store)) {
        const kept = list.filter((sub) => {
          const tooOld = now - sub.subscribedAt > maxAgeMs
          const dead = (sub.consecutiveFailures ?? 0) >= PRUNE_FAILURE_THRESHOLD
          if (tooOld || dead) {
            pruned++
            return false
          }
          return true
        })
        if (kept.length > 0) store[wallet] = kept
        else delete store[wallet]
      }
      if (pruned > 0) {
        incSecurityCounter("push_subscriptions_pruned", pruned)
      }
      return pruned
    },
  )
}

export type PushDeliveryResult = {
  endpoint: string
  ok: boolean
  skipped?: boolean
  error?: string
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(16, Math.trunc(concurrency)))
  const results = new Array<R>(items.length)
  let nextIdx = 0

  async function runWorker(): Promise<void> {
    while (true) {
      const idx = nextIdx++
      if (idx >= items.length) return
      results[idx] = await worker(items[idx]!)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker())
  await Promise.all(workers)
  return results
}

async function recordDeliveryOutcomes(
  wallet: string,
  outcomes: Array<{ endpoint: string; ok: boolean; statusCode?: number; error?: string }>,
  now: number,
): Promise<void> {
  if (outcomes.length === 0) return
  const byEndpoint = new Map(outcomes.map((o) => [o.endpoint, o]))
  await updateStoreWithReader<SubscriptionStore, void>(
    "pushSubscriptions",
    normalizeSubscriptionStore,
    (store) => {
      const list = store[wallet]
      if (!list || list.length === 0) return
      const nextList: PushSubscription[] = []
      for (const sub of list) {
        const outcome = byEndpoint.get(sub.endpoint)
        if (!outcome) {
          nextList.push(sub)
          continue
        }
        if (outcome.ok) {
          nextList.push({
            ...sub,
            consecutiveFailures: 0,
            circuitOpenUntil: 0,
            lastSuccessAt: now,
          })
          continue
        }
        const failures = (sub.consecutiveFailures ?? 0) + 1
        const isGone = outcome.statusCode === 404 || outcome.statusCode === 410
        if (isGone || failures >= PRUNE_FAILURE_THRESHOLD) {
          incSecurityCounter("push_subscriptions_pruned")
          continue
        }
        const wasOpen = (sub.circuitOpenUntil ?? 0) > now
        const circuitOpenUntil =
          failures >= CIRCUIT_FAILURE_THRESHOLD ? now + CIRCUIT_OPEN_MS : sub.circuitOpenUntil ?? 0
        if (!wasOpen && circuitOpenUntil > now) {
          incSecurityCounter("push_circuit_breaker_opened")
        }
        nextList.push({
          ...sub,
          consecutiveFailures: failures,
          circuitOpenUntil,
          lastFailureAt: now,
        })
      }
      if (nextList.length > 0) store[wallet] = nextList
      else delete store[wallet]
    },
  )
}

/**
 * Best-effort delivery: POSTs a minimal JSON payload to each of the wallet's
 * registered push endpoints.
 *
 * When phase-252 is enabled:
 * - Deduplicates concurrent bursts per (wallet, event, eventId/payload)
 * - Enforces per-subscription failure circuit breakers & prunes dead endpoints
 * - Dispatches in bounded-concurrency batches and emits closed counters
 */
export async function dispatchPushNotification(
  wallet: string,
  event: PushNotificationEvent,
  payload: Record<string, unknown>,
  opts: { eventId?: string; concurrency?: number; now?: number } = {},
): Promise<PushDeliveryResult[]> {
  if (!isPhase92Enabled()) return []
  const subs = await getPushSubscriptions(wallet)
  if (subs.length === 0) return []

  const now = opts.now ?? Date.now()
  if (isPhase252Enabled(wallet)) {
    const eventKey = computePushEventDedupeKey(wallet, event, payload, opts.eventId)
    const claimed = await claimPushEventOnce(eventKey, now)
    if (!claimed) {
      incSecurityCounter("push_notifications_deduped")
      return []
    }

    const activeSubs: PushSubscription[] = []
    const skippedResults: PushDeliveryResult[] = []
    for (const sub of subs) {
      if ((sub.circuitOpenUntil ?? 0) > now) {
        skippedResults.push({
          endpoint: sub.endpoint,
          ok: false,
          skipped: true,
          error: "circuit_open",
        })
      } else {
        activeSubs.push(sub)
      }
    }

    const outcomes: Array<{
      endpoint: string
      ok: boolean
      statusCode?: number
      error?: string
    }> = []

    const activeResults = await runWithConcurrency(
      activeSubs,
      opts.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
      async (sub): Promise<PushDeliveryResult> => {
        try {
          const res = await fetch(sub.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event, ...payload }),
          })
          if (res.ok) {
            incSecurityCounter("push_notifications_dispatched")
            outcomes.push({ endpoint: sub.endpoint, ok: true, statusCode: res.status })
          } else {
            incSecurityCounter("push_notifications_failed")
            outcomes.push({
              endpoint: sub.endpoint,
              ok: false,
              statusCode: res.status,
              error: `HTTP ${res.status}`,
            })
          }
          if (isAnalyticsWarehouseEnabled(wallet)) {
            void recordWarehouseEvent({
              surface: "push",
              stage: res.ok ? "push_dispatched" : "push_failed",
              wallet,
              reason: res.ok ? null : `HTTP ${res.status}`,
              metadata: { endpoint: sub.endpoint, event },
            }).catch(() => {})
          }
          return {
            endpoint: sub.endpoint,
            ok: res.ok,
            error: res.ok ? undefined : `HTTP ${res.status}`,
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e)
          incSecurityCounter("push_notifications_failed")
          outcomes.push({ endpoint: sub.endpoint, ok: false, error: err })
          if (isAnalyticsWarehouseEnabled(wallet)) {
            void recordWarehouseEvent({
              surface: "push",
              stage: "push_failed",
              wallet,
              reason: err,
              metadata: { endpoint: sub.endpoint, event },
            }).catch(() => {})
          }
          return { endpoint: sub.endpoint, ok: false, error: err }
        }
      },
    )

    await recordDeliveryOutcomes(wallet, outcomes, now)
    return [...activeResults, ...skippedResults]
  }

  // Legacy phase-92 path (phase-252 flag off)
  const results: PushDeliveryResult[] = []
  for (const sub of subs) {
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, ...payload }),
      })
      results.push({ endpoint: sub.endpoint, ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` })

      if (isAnalyticsWarehouseEnabled(wallet)) {
        void recordWarehouseEvent({
          surface: "push",
          stage: res.ok ? "push_dispatched" : "push_failed",
          wallet,
          reason: res.ok ? null : `HTTP ${res.status}`,
          metadata: { endpoint: sub.endpoint, event },
        }).catch(() => {})
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      results.push({ endpoint: sub.endpoint, ok: false, error: err })

      if (isAnalyticsWarehouseEnabled(wallet)) {
        void recordWarehouseEvent({
          surface: "push",
          stage: "push_failed",
          wallet,
          reason: err,
          metadata: { endpoint: sub.endpoint, event },
        }).catch(() => {})
      }
    }
  }
  return results
}

/**
 * Batch delivery across multiple wallets/events with bounded concurrency.
 */
export async function dispatchPushBatch(
  deliveries: Array<{
    wallet: string
    event: PushNotificationEvent
    payload: Record<string, unknown>
    eventId?: string
  }>,
  opts: { concurrency?: number } = {},
): Promise<Array<{ wallet: string; results: PushDeliveryResult[] }>> {
  return runWithConcurrency(
    deliveries,
    opts.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
    async (item) => ({
      wallet: item.wallet,
      results: await dispatchPushNotification(item.wallet, item.event, item.payload, {
        eventId: item.eventId,
        concurrency: opts.concurrency,
      }),
    }),
  )
}

/** Extracts wallet mentions (`@G...` tokens) from free-text reply/signal bodies. */
export function extractMentionedWallets(text: string): string[] {
  const matches = text.match(/@G[A-Z2-7]{55}\b/g) ?? []
  return [...new Set(matches.map((m) => m.slice(1)))].filter((w) => STELLAR_G_REGEX.test(w))
}

/**
 * `app/api/phase-nft/verify/route.ts` wiring hook: audits that the push
 * subscription schema and dispatch pipeline are loadable/consistent, without
 * altering NFT ownership verification logic in that route.
 */
export function auditPushNotificationWiring(): { ok: boolean; note: string } {
  if (!isPhase92Enabled()) {
    return { ok: true, note: "[phase-92] push notifications disabled; nothing to audit." }
  }
  const probe = SubscribePushRequestSchema.safeParse({
    wallet: "G" + "A".repeat(55),
    endpoint: "https://push.example.com/probe",
    keys: { p256dh: "probe", auth: "probe" },
  })
  if (!probe.success) {
    return { ok: false, note: `[phase-92] push subscription schema drift (unexpected, report): ${probe.error.message}` }
  }
  return { ok: true, note: "[phase-92] push notification wiring OK. " + flag92RollbackNote() }
}
