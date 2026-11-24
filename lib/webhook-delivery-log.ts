/**
 * phase-215 — append-only webhook delivery log + event dedupe.
 *
 * The log is the audit surface for the admin redelivery UI. It stores only a
 * sanitized payload snapshot: any key resembling a secret/token/signature is
 * replaced before persistence, and the HMAC signing secret is never included.
 *
 * Rollback: unset phase-215; the sidecar stays on disk but is never read.
 */

import { randomUUID } from "node:crypto"
import { readStore, updateStoreWithReader } from "@/lib/json-store"

export type DeliveryStatus = "delivered" | "failed" | "skipped" | "redelivered"

export interface WebhookDeliveryRecord {
  id: string
  eventId: string
  event: string
  subscriptionId: string
  endpoint: string
  status: DeliveryStatus
  attempt: number
  httpStatus: number | null
  reason?: string
  payload: unknown
  at: number
}

type DeliveryStore = {
  records: WebhookDeliveryRecord[]
  seen: Record<string, number>
}

const MAX_RECORDS = 2_000
const REDACTED = "[REDACTED]"
const SENSITIVE_KEY = /(secret|token|authoriz|api[_-]?key|seed|signature|password|credential)/i

/** Recursively drop secret-looking fields and bound string sizes. */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]"
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1))
  if (typeof value !== "object") return String(value)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED
      continue
    }
    out[key] = sanitizeForLog(item, depth + 1)
  }
  return out
}

function emptyStore(): DeliveryStore {
  return { records: [], seen: {} }
}

function normalizeStore(raw: unknown): DeliveryStore {
  const store = (raw ?? {}) as Partial<DeliveryStore>
  return {
    records: Array.isArray(store.records) ? store.records : [],
    seen: store.seen && typeof store.seen === "object" ? store.seen : {},
  }
}

/**
 * Claim an event id exactly once. Returns false when this transition was
 * already emitted, so every real mutation produces one logical event.
 */
export async function claimEventId(eventId: string): Promise<boolean> {
  if (!eventId) return false
  return updateStoreWithReader<DeliveryStore, boolean>(
    "webhookDeliveries",
    normalizeStore,
    (store) => {
      if (store.seen[eventId]) return false
      store.seen[eventId] = Date.now()
      // Bound the dedupe map alongside the record list.
      const ids = Object.keys(store.seen)
      if (ids.length > MAX_RECORDS * 2) {
        for (const id of ids.slice(0, ids.length - MAX_RECORDS)) delete store.seen[id]
      }
      return true
    },
  )
}

export async function appendDelivery(
  input: Omit<WebhookDeliveryRecord, "id" | "at">,
): Promise<WebhookDeliveryRecord> {
  const record: WebhookDeliveryRecord = {
    ...input,
    id: randomUUID(),
    payload: sanitizeForLog(input.payload),
    at: Date.now(),
  }
  await updateStoreWithReader<DeliveryStore, void>(
    "webhookDeliveries",
    normalizeStore,
    (store) => {
      store.records.push(record)
      if (store.records.length > MAX_RECORDS) {
        store.records.splice(0, store.records.length - MAX_RECORDS)
      }
    },
  )
  return { ...record, payload: REDACTED }
}

export async function listDeliveries(subscriptionId?: string): Promise<WebhookDeliveryRecord[]> {
  try {
    const store = await readStore<DeliveryStore>("webhookDeliveries", emptyStore)
    const records = subscriptionId
      ? store.records.filter((r) => r.subscriptionId === subscriptionId)
      : store.records
    return [...records].reverse()
  } catch {
    return []
  }
}

export async function getDelivery(id: string): Promise<WebhookDeliveryRecord | null> {
  try {
    const store = await readStore<DeliveryStore>("webhookDeliveries", emptyStore)
    return store.records.find((r) => r.id === id) ?? null
  } catch {
    return null
  }
}
