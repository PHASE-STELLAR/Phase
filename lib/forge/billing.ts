import { createHash } from "node:crypto"
import { z } from "zod"
import { flagRollbackNote, isFeatureEnabled } from "@/lib/feature-flags"
import { readStore, updateStoreWithReader } from "@/lib/json-store"

// ── Spike 615 (phase-177): billing and metering for paid forge tiers ──
//
// The forge charged a flat x402 fee with no per-wallet metering: nothing
// stopped a wallet from settling the same fee in an unbounded number of jobs,
// and there was no usage record to reconcile against the cost ledger. This
// module meters accepted forge jobs per wallet per UTC day (idempotent by
// jobId) and enforces a daily quota with 429 + Retry-After. Tiers are config,
// not code: PHASE_FORGE_BILLING_TIERS maps tier id → daily limit.
//
// Feature flag: phase-177 (NEXT_PUBLIC_FEATURE_PHASE_177 / FEATURE_PHASE_177)
// Rollback: unset the flag → checkForgeQuota always allows, recordForgeBillingEvent
//           is a no-op; forge-billing.json stays inert on disk. No migration.
//
// Privacy: wallets are stored as sha256(wallet) hex only.

export function isForgeBillingEnabled(): boolean {
  return isFeatureEnabled("phase-177")
}

export function forgeBillingRollbackNote(): string {
  return flagRollbackNote("phase-177")
}

export const FORGE_BILLING_TIER_IDS = ["standard", "bronze", "silver", "gold", "obsidian"] as const
export type ForgeBillingTierId = (typeof FORGE_BILLING_TIER_IDS)[number]

const DEFAULT_DAILY_LIMITS: Record<ForgeBillingTierId, number> = {
  standard: 5,
  bronze: 10,
  silver: 20,
  gold: 40,
  obsidian: 100,
}

/** Daily job limits per tier; overridable per env without a deploy. */
export function forgeBillingTierLimits(): Record<ForgeBillingTierId, number> {
  const limits = { ...DEFAULT_DAILY_LIMITS }
  const raw = process.env.PHASE_FORGE_BILLING_TIERS?.trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const id of FORGE_BILLING_TIER_IDS) {
        const v = parsed[id]
        if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000) limits[id] = v
      }
    } catch {
      // Invalid config fails safe to defaults — billing must never brick the forge.
    }
  }
  return limits
}

/**
 * Tier for a wallet. Stake lookup (staked-forge-discounts) is intentionally
 * not threaded here yet: this minimal core meters every wallet at the
 * deployment default tier; per-wallet stake upgrades are a follow-up.
 */
export function resolveBillingTier(_wallet?: string): ForgeBillingTierId {
  const raw = process.env.PHASE_FORGE_BILLING_DEFAULT_TIER?.trim().toLowerCase()
  return (FORGE_BILLING_TIER_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as ForgeBillingTierId)
    : "standard"
}

export const ForgeBillingEventSchema = z.object({
  wallet: z.string().trim().regex(/^G[A-Z2-7]{55}$/, "valid ed25519 public key required"),
  jobId: z.string().trim().min(1).max(128),
  settlementTxHash: z.string().trim().max(128).optional(),
  amountStroops: z.string().trim().regex(/^\d{1,19}$/).optional(),
  tierId: z.enum(FORGE_BILLING_TIER_IDS).optional(),
})

export type ForgeBillingEvent = z.infer<typeof ForgeBillingEventSchema>

export type ForgeQuota = {
  allowed: boolean
  tierId: ForgeBillingTierId
  used: number
  limit: number
  remaining: number
  /** Unix seconds (UTC) when the daily window resets. */
  resetAt: number
}

export class ForgeBillingError extends Error {
  code: "VALIDATION_FAILED"
  details?: unknown
  constructor(message: string, details?: unknown) {
    super(message)
    this.name = "ForgeBillingError"
    this.code = "VALIDATION_FAILED"
    this.details = details
  }
}

type WalletDayUsage = {
  count: number
  /** jobId → settlement hash (dedup key; bounded). */
  jobs: Record<string, string>
  updatedAt: number
}

type ForgeBillingStore = {
  version: number
  /** Keyed by `<walletHash>:<YYYY-MM-DD>`. */
  days: Record<string, WalletDayUsage>
}

const MAX_WALLET_DAYS = 5_000
const MAX_JOBS_PER_WALLET_DAY = 200

function emptyStore(): ForgeBillingStore {
  return { version: 1, days: {} }
}

function normalizeStore(raw: unknown): ForgeBillingStore {
  const s = raw as ForgeBillingStore | undefined
  if (!s || typeof s !== "object" || !s.days || typeof s.days !== "object") return emptyStore()
  return { version: typeof s.version === "number" && s.version > 0 ? s.version : 1, days: s.days }
}

export function walletBillingHash(wallet: string): string {
  return createHash("sha256").update(wallet.trim().toUpperCase(), "utf8").digest("hex")
}

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function utcDayResetSeconds(dayKey: string): number {
  return Math.floor(Date.parse(`${dayKey}T00:00:00.000Z`) / 1000) + 86_400
}

function usageKey(walletHash: string, dayKey: string): string {
  return `${walletHash}:${dayKey}`
}

/** Daily quota for a wallet. Flag off → always allowed (limit reported for UI). */
export async function checkForgeQuota(wallet: string, opts: { now?: number } = {}): Promise<ForgeQuota> {
  const cleanWallet = wallet.trim()
  const tierId = resolveBillingTier(cleanWallet)
  const limit = forgeBillingTierLimits()[tierId]
  const now = opts.now ?? Date.now()
  const dayKey = utcDayKey(now)
  const control: ForgeQuota = {
    allowed: true,
    tierId,
    used: 0,
    limit,
    remaining: limit,
    resetAt: utcDayResetSeconds(dayKey),
  }
  if (!cleanWallet || !isForgeBillingEnabled()) return control

  const store = normalizeStore(await readStore<ForgeBillingStore>("forgeBilling", emptyStore))
  const usage = store.days[usageKey(walletBillingHash(cleanWallet), dayKey)]
  const used = usage?.count ?? 0
  return {
    allowed: used < limit,
    tierId,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: utcDayResetSeconds(dayKey),
  }
}

/** Seconds a quota-refused caller should wait; floor of 60. */
export function forgeBillingRetryAfterSeconds(quota: ForgeQuota): number {
  const nowSec = Math.floor(Date.now() / 1000)
  return Math.max(60, quota.resetAt - nowSec)
}

/**
 * Records an accepted forge job against the wallet's daily usage. Idempotent
 * by jobId: a retry after a serverless timeout returns duplicate=true without
 * double-counting the quota. Flag off → no-op returning recorded=false.
 */
export async function recordForgeBillingEvent(
  raw: unknown,
  opts: { now?: number } = {},
): Promise<{ recorded: boolean; duplicate: boolean; usage?: WalletDayUsage }> {
  const parsed = ForgeBillingEventSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ForgeBillingError("valid forge billing event required", parsed.error.flatten())
  }
  if (!isForgeBillingEnabled()) return { recorded: false, duplicate: false }

  const event = parsed.data
  const now = opts.now ?? Date.now()
  const dayKey = utcDayKey(now)
  const key = usageKey(walletBillingHash(event.wallet), dayKey)
  const tierId = event.tierId ?? resolveBillingTier(event.wallet)

  return updateStoreWithReader<ForgeBillingStore, { recorded: boolean; duplicate: boolean; usage?: WalletDayUsage }>(
    "forgeBilling",
    normalizeStore,
    (store) => {
      const usage = store.days[key] ?? { count: 0, jobs: {}, updatedAt: now }
      if (Object.prototype.hasOwnProperty.call(usage.jobs, event.jobId)) {
        store.version += 1
        return { recorded: false, duplicate: true, usage }
      }
      if (Object.keys(usage.jobs).length >= MAX_JOBS_PER_WALLET_DAY) {
        // Hard per-day bound: refuse to grow the map unboundedly; the quota
        // limit is always far below this ceiling.
        store.version += 1
        return { recorded: false, duplicate: false, usage }
      }
      usage.jobs[event.jobId] = event.settlementTxHash ?? ""
      usage.count += 1
      usage.updatedAt = now
      store.days[key] = usage
      pruneOldDays(store, dayKey)
      store.version += 1
      return { recorded: true, duplicate: false, usage }
    },
  )
}

function pruneOldDays(store: ForgeBillingStore, currentDayKey: string): void {
  const keys = Object.keys(store.days)
  if (keys.length <= MAX_WALLET_DAYS) return
  // Keep the current day; drop the oldest entries by updatedAt.
  const sorted = keys
    .filter((k) => !k.endsWith(`:${currentDayKey}`))
    .sort((a, b) => (store.days[a]?.updatedAt ?? 0) - (store.days[b]?.updatedAt ?? 0))
  const excess = keys.length - MAX_WALLET_DAYS
  for (let i = 0; i < excess && i < sorted.length; i++) {
    delete store.days[sorted[i]!]
  }
}

/** Usage snapshot for a wallet-day (reporting; no raw wallet stored). */
export async function getForgeBillingUsage(
  wallet: string,
  opts: { now?: number } = {},
): Promise<{ tierId: ForgeBillingTierId; count: number; limit: number; jobs: string[] }> {
  const now = opts.now ?? Date.now()
  const dayKey = utcDayKey(now)
  const tierId = resolveBillingTier(wallet)
  const limit = forgeBillingTierLimits()[tierId]
  const store = normalizeStore(await readStore<ForgeBillingStore>("forgeBilling", emptyStore))
  const usage = store.days[usageKey(walletBillingHash(wallet), dayKey)]
  return { tierId, count: usage?.count ?? 0, limit, jobs: usage ? Object.keys(usage.jobs) : [] }
}
