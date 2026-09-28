/**
 * Push notifications for replies and mentions — phase-92
 *
 * Users previously missed engagement (signal replies, @mentions) without
 * actively polling `/api/notifications`. This module lets a wallet register
 * a browser Push subscription and provides a best-effort dispatch queue that
 * fans an in-app notification out to that wallet's registered push endpoints.
 *
 * Feature flag: phase-92 (NEXT_PUBLIC_FEATURE_PHASE_92 / FEATURE_PHASE_92)
 * Rollback: unset flag → subscribe/dispatch calls throw FLAG_DISABLED or are
 *           no-ops; existing in-app notifications (lib/notification-store.ts)
 *           are unaffected — this module only adds a delivery side-channel.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

export function isPhase92Enabled(): boolean {
  return isFeatureEnabled("phase-92")
}

export function flag92RollbackNote(): string {
  return "Rollback phase-92: unset NEXT_PUBLIC_FEATURE_PHASE_92 / FEATURE_PHASE_92 or set to 0/false and restart. Registered subscriptions remain on disk but stop receiving dispatches; in-app notifications keep working unchanged."
}

const STELLAR_G_REGEX = /^G[A-Z2-7]{55}$/

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

// ─── store helpers ───────────────────────────────────────────────────────────

async function subscriptionsFilePath(): Promise<string> {
  const { serverDataJsonPath } = await import("@/lib/server-data-paths")
  return serverDataJsonPath("pushSubscriptions")
}

type SubscriptionStore = Record<string, PushSubscription[]>

async function readSubscriptionStore(): Promise<SubscriptionStore> {
  try {
    const fp = await subscriptionsFilePath()
    const raw = await readFile(fp, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown[]>
    const out: SubscriptionStore = {}
    for (const [wallet, list] of Object.entries(parsed)) {
      const clean = (Array.isArray(list) ? list : [])
        .map((v) => PushSubscriptionSchema.safeParse(v))
        .filter((r): r is { success: true; data: PushSubscription } => r.success)
        .map((r) => r.data)
      if (clean.length > 0) out[wallet] = clean
    }
    return out
  } catch {
    return {}
  }
}

async function writeSubscriptionStore(data: SubscriptionStore): Promise<void> {
  const fp = await subscriptionsFilePath()
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(data, null, 2), "utf8")
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
  const sub: PushSubscription = PushSubscriptionSchema.parse({ ...parsed.data, subscribedAt: Date.now() })
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

export type PushDeliveryResult = { endpoint: string; ok: boolean; error?: string }

/**
 * Best-effort delivery: POSTs a minimal JSON payload to each of the wallet's
 * registered push endpoints. Any transport failure is captured per-endpoint
 * and never throws — a failed push must not block the in-app notification.
 */
export async function dispatchPushNotification(
  wallet: string,
  event: PushNotificationEvent,
  payload: Record<string, unknown>,
): Promise<PushDeliveryResult[]> {
  if (!isPhase92Enabled()) return []
  const subs = await getPushSubscriptions(wallet)
  if (subs.length === 0) return []

  const results: PushDeliveryResult[] = []
  for (const sub of subs) {
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, ...payload }),
      })
      results.push({ endpoint: sub.endpoint, ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` })
    } catch (e) {
      results.push({ endpoint: sub.endpoint, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return results
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
