/**
 * Data retention and GDPR erasure pipeline (Article 17) with TTL sweeps.
 * Spike 617 / Issue #480.
 *
 * Two halves share one flag (phase-179):
 *
 *   1. TTL sweeps — pure prune functions plus `runRetentionSweeps()`, which
 *      applies them to the stores that accumulate time-shaped data: expired
 *      SEP-10 sessions, stale consumed challenges and old notifications.
 *      Sweeps fail safe: a record without a parseable timestamp is kept.
 *
 *   2. Wallet erasure — `executeWalletErasure()` walks the wallet-keyed
 *      sidecars (notifications, age declarations, follows, push
 *      subscriptions) plus the SEP-10 session map, removes every entry the
 *      wallet owns, and appends a schema-versioned receipt keyed by a wallet
 *      fingerprint (never the raw address).
 *
 * Erasure is gated by `assertNoLegalHold` (phase-169): an active hold throws
 * `LEGAL_HOLD_ACTIVE` (HTTP 423) and nothing is deleted. The terms-consent
 * ledger is deliberately NOT erased — consent records are the proof of legal
 * basis kept under Art. 17(3)(b), so withdrawal is recorded, not shredded.
 *
 * Partial slice: SQLite tables (signals, replies, listings, offers, tax
 * events) are not yet walked; erasure covers JSON sidecars only.
 * Rollback: unset the flag — routes 404 and stored receipts stay inert.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { assertNoLegalHold, LegalHoldError } from "@/lib/legal-hold"
import { updateStore } from "@/lib/json-store"
import { fingerprintWallet } from "@/lib/redaction"
import { incSecurityCounter } from "@/lib/security-counters"
import type { ServerDataFile } from "@/lib/server-data-paths"

export const ERASURE_RECEIPT_SCHEMA = "phase-gdpr-article-17-erasure"
export const ERASURE_RECEIPT_VERSION = "1.0.0"
export const MAX_ERASURE_RECEIPTS = 1000

const G_ADDRESS_RE = /^G[A-Z2-7]{55}$/

export function isRetentionErasureEnabled(): boolean {
  return isFeatureEnabled("phase-179")
}

export function retention179RollbackNote(): string {
  return "Rollback phase-179: unset NEXT_PUBLIC_FEATURE_PHASE_179 / FEATURE_PHASE_179 or set 0/false and restart. Sweeps stop running and the erasure route 404s; receipts stay inert."
}

export class RetentionErasureError extends Error {
  readonly code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "LEGAL_HOLD_ACTIVE"
  readonly details?: unknown
  constructor(code: RetentionErasureError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "RetentionErasureError"
    this.code = code
    this.details = details
  }
}

// ─── TTL sweeps (pure) ───────────────────────────────────────────────────────

export const RETENTION_TTL_MS = {
  authSession: 30 * 24 * 60 * 60 * 1000,
  consumedChallenge: 24 * 60 * 60 * 1000,
  notification: 90 * 24 * 60 * 60 * 1000,
} as const

export type TtlSweepResult<T> = { kept: T[]; removed: T[] }

export function sweepByTimestamp<T>(
  records: T[],
  opts: {
    now: number
    ttlMs: number
    timestampOf: (record: T) => number | null | undefined
  },
): TtlSweepResult<T> {
  const kept: T[] = []
  const removed: T[] = []
  for (const record of records) {
    const ts = opts.timestampOf(record)
    if (ts !== null && ts !== undefined && Number.isFinite(ts) && opts.now - ts > opts.ttlMs) {
      removed.push(record)
    } else {
      kept.push(record)
    }
  }
  return { kept, removed }
}

export type AuthSessionRecord = { wallet?: string; expires_at?: number }
export type AuthSessionStoreShape = {
  sessions?: Record<string, AuthSessionRecord>
  consumed_challenges?: Record<string, number>
}

/** SEP-10 stores `expires_at`/challenge timestamps in seconds; normalize to ms. */
function toEpochMs(value: number): number {
  return value < 1e12 ? value * 1000 : value
}

/** Drops expired sessions and consumed challenges older than their TTL. Mutates `store`. */
export function sweepAuthSessions(store: AuthSessionStoreShape, now: number): number {
  let removed = 0
  const sessions = store.sessions ?? {}
  for (const [token, record] of Object.entries(sessions)) {
    const expiresAt = typeof record?.expires_at === "number" ? toEpochMs(record.expires_at) : null
    if (expiresAt !== null && now > expiresAt) {
      delete sessions[token]
      removed++
    }
  }
  store.sessions = sessions

  const challenges = store.consumed_challenges ?? {}
  for (const [hash, consumedAt] of Object.entries(challenges)) {
    if (Number.isFinite(consumedAt) && now - toEpochMs(consumedAt) > RETENTION_TTL_MS.consumedChallenge) {
      delete challenges[hash]
      removed++
    }
  }
  store.consumed_challenges = challenges
  return removed
}

export type Notifiable = { created_at?: number }

/** Prunes expired notifications and empties wallet buckets that ran dry. Mutates `store`. */
export function sweepNotificationStore(
  store: Record<string, Notifiable[]>,
  now: number,
  ttlMs: number = RETENTION_TTL_MS.notification,
): number {
  let removed = 0
  for (const wallet of Object.keys(store)) {
    const list = Array.isArray(store[wallet]) ? store[wallet] : []
    const { kept, removed: dropped } = sweepByTimestamp(list, {
      now,
      ttlMs,
      timestampOf: (record) => (typeof record?.created_at === "number" ? record.created_at : null),
    })
    removed += dropped.length
    if (kept.length === 0) delete store[wallet]
    else store[wallet] = kept
  }
  return removed
}

// ─── Wallet erasure (Article 17) ─────────────────────────────────────────────

export type ErasureDomainResult = { domain: string; removed: number }

export type ErasureReceipt = {
  schema: typeof ERASURE_RECEIPT_SCHEMA
  version: string
  wallet_fingerprint: string
  domains: ErasureDomainResult[]
  total_removed: number
  executed_at: number
  initiated_by: "wallet" | "admin"
}

type ErasureTarget = {
  domain: string
  store: ServerDataFile
  shape: "wallet-keyed" | "auth-sessions"
}

export const ERASURE_TARGETS: ErasureTarget[] = [
  { domain: "notifications", store: "notifications", shape: "wallet-keyed" },
  { domain: "age_declarations", store: "ageDeclarations", shape: "wallet-keyed" },
  { domain: "follows", store: "profileFollows", shape: "wallet-keyed" },
  { domain: "push_subscriptions", store: "pushSubscriptions", shape: "wallet-keyed" },
  { domain: "auth_sessions", store: "authSessions", shape: "auth-sessions" },
]

/**
 * Deletes the wallet's bucket from a `Record<wallet, value>` sidecar and
 * returns how many records went away (array buckets count their elements).
 * Mutates `store`, matching the `updateStore` callback contract.
 */
export function eraseWalletKeyedRecord(store: Record<string, unknown>, wallet: string): number {
  if (!Object.prototype.hasOwnProperty.call(store, wallet)) return 0
  const value = store[wallet]
  const removed = Array.isArray(value) ? value.length : 1
  delete store[wallet]
  return removed
}

/** Removes every SEP-10 session bound to the wallet. Mutates `store`. */
export function eraseWalletAuthSessions(store: AuthSessionStoreShape, wallet: string): number {
  const sessions = store.sessions ?? {}
  let removed = 0
  for (const [token, record] of Object.entries(sessions)) {
    if (record?.wallet === wallet) {
      delete sessions[token]
      removed++
    }
  }
  store.sessions = sessions
  return removed
}

export type ErasureOptions = {
  initiatedBy?: "wallet" | "admin"
  now?: number
}

export async function executeWalletErasure(
  wallet: string,
  opts: ErasureOptions = {},
): Promise<ErasureReceipt> {
  if (!isRetentionErasureEnabled()) {
    throw new RetentionErasureError("FLAG_DISABLED", "GDPR erasure is disabled (phase-179 flag off)")
  }
  const target = wallet.trim()
  if (!G_ADDRESS_RE.test(target)) {
    throw new RetentionErasureError("VALIDATION_FAILED", "a Stellar wallet address (G...) is required")
  }

  try {
    await assertNoLegalHold("wallet", target, "erasure", target)
  } catch (error) {
    if (error instanceof LegalHoldError) {
      incSecurityCounter("gdpr_erasure_blocked")
      throw new RetentionErasureError("LEGAL_HOLD_ACTIVE", error.message)
    }
    throw error
  }

  const domains: ErasureDomainResult[] = []
  for (const erasure of ERASURE_TARGETS) {
    const removed = await updateStore<object, number>(erasure.store, (data) => {
      if (erasure.shape === "wallet-keyed") {
        return eraseWalletKeyedRecord((data ?? {}) as Record<string, unknown>, target)
      }
      return eraseWalletAuthSessions((data ?? {}) as AuthSessionStoreShape, target)
    })
    if (removed > 0) {
      domains.push({ domain: erasure.domain, removed })
      incSecurityCounter("gdpr_erasure_records", removed)
    }
  }

  const receipt: ErasureReceipt = {
    schema: ERASURE_RECEIPT_SCHEMA,
    version: ERASURE_RECEIPT_VERSION,
    wallet_fingerprint: fingerprintWallet(target),
    domains,
    total_removed: domains.reduce((sum, d) => sum + d.removed, 0),
    executed_at: opts.now ?? Date.now(),
    initiated_by: opts.initiatedBy ?? "wallet",
  }

  await updateStore<{ receipts: ErasureReceipt[] }>("gdprErasureLog", (store) => {
    store.receipts = [receipt, ...(store.receipts ?? [])].slice(0, MAX_ERASURE_RECEIPTS)
  })

  incSecurityCounter("gdpr_erasure_completed")
  return receipt
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export type SweepOutcome = { store: string; removed: number }

export async function runRetentionSweeps(
  now: number = Date.now(),
): Promise<{ ok: true; sweeps: SweepOutcome[]; total_removed: number }> {
  if (!isRetentionErasureEnabled()) {
    throw new RetentionErasureError("FLAG_DISABLED", "Retention sweeps are disabled (phase-179 flag off)")
  }

  const sweeps: SweepOutcome[] = []

  const authRemoved = await updateStore<AuthSessionStoreShape, number>("authSessions", (store) =>
    sweepAuthSessions(store, now),
  )
  sweeps.push({ store: "authSessions", removed: authRemoved })

  const notificationRemoved = await updateStore<Record<string, Notifiable[]>, number>(
    "notifications",
    (store) => sweepNotificationStore(store, now),
  )
  sweeps.push({ store: "notifications", removed: notificationRemoved })

  const total_removed = sweeps.reduce((sum, s) => sum + s.removed, 0)
  incSecurityCounter("retention_sweep_runs")
  if (total_removed > 0) incSecurityCounter("retention_records_expired", total_removed)

  return { ok: true, sweeps, total_removed }
}
