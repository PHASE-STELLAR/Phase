import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { z } from "zod"
import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { serverDataJsonPath } from "@/lib/server-data-paths"

export type NotificationType =
  | "mint_in_collection"
  | "narrator_generated"
  | "new_follower"
  | "signal_reply"
  | "mention"
  | "signal_upvote"
  | "quest_completed"
  | "world_mint"
  | "new_offer"
  | "offer_accepted"
  | "offer_rejected"
  | "achievement_unlocked"
  | "content_takedown"
  | "royalty_payout"
  | "signal_reaction"

export type Notification = {
  id: string
  wallet: string
  type: NotificationType
  read: boolean
  created_at: number
  data: Record<string, unknown>
}

type NotificationStore = Record<string, Notification[]>
type GatewayAuthRotationStore = Record<string, GatewayAuthRotation>

const MAX_PER_WALLET = 50
// phase-98: profile-level notification preferences.
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_98 / FEATURE_PHASE_98; existing notifications remain readable.
export type NotificationPreferences = {
  enabled: boolean
  types: Partial<Record<NotificationType, boolean>>
  updated_at: number
}

type NotificationPreferenceStore = Record<string, NotificationPreferences>

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  types: {},
  updated_at: 0,
}

export function isNotificationPreferencesEnabled(): boolean {
  const value = (process.env.NEXT_PUBLIC_FEATURE_PHASE_98 ?? process.env.FEATURE_PHASE_98 ?? "").trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

export function isPhase128Enabled(): boolean {
  return isFeatureEnabled("phase-128")
}

export function phase128RollbackNote(): string {
  return flagRollbackNote("phase-128")
}

export const GatewayAuthRotationSchema = z.object({
  gateway: z.string().trim().min(2).max(64).regex(/^[a-z0-9._-]+$/i),
  private_tier: z.enum(["starter", "pro", "enterprise"]),
  next_token: z.string().trim().min(16).max(4096),
  rotated_by: z.string().trim().min(1).max(128),
  overlap_ms: z.number().int().min(0).max(86_400_000).default(900_000),
})

export type GatewayAuthRotationInput = z.infer<typeof GatewayAuthRotationSchema>

export type GatewayAuthRotation = {
  gateway: string
  private_tier: GatewayAuthRotationInput["private_tier"]
  active_token_hash: string
  previous_token_hash: string | null
  previous_expires_at: number | null
  rotated_by: string
  rotated_at: number
}

export class GatewayAuthRotationError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED"
  details?: unknown

  constructor(code: GatewayAuthRotationError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "GatewayAuthRotationError"
    this.code = code
    this.details = details
  }
}

function hashGatewayToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

function gatewayRotationKey(gateway: string, privateTier: string): string {
  return `${gateway.toLowerCase()}:${privateTier}`
}

async function readGatewayAuthRotationStore(): Promise<GatewayAuthRotationStore> {
  try {
    const raw = await readFile(serverDataJsonPath("ipfsGatewayAuthRotations"), "utf8")
    const parsed = JSON.parse(raw) as GatewayAuthRotationStore
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writeGatewayAuthRotationStore(data: GatewayAuthRotationStore): Promise<void> {
  const filePath = serverDataJsonPath("ipfsGatewayAuthRotations")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

export async function rotateIpfsGatewayAuth(input: unknown, opts: { force?: boolean; now?: number } = {}): Promise<GatewayAuthRotation> {
  if (!opts.force && !isPhase128Enabled()) {
    throw new GatewayAuthRotationError("FLAG_DISABLED", "phase-128 flag disabled", {
      rollback: phase128RollbackNote(),
    })
  }

  const parsed = GatewayAuthRotationSchema.safeParse(input)
  if (!parsed.success) {
    throw new GatewayAuthRotationError("VALIDATION_FAILED", "valid gateway rotation payload required", parsed.error.flatten())
  }

  const now = opts.now ?? Date.now()
  const data = parsed.data
  const store = await readGatewayAuthRotationStore()
  const key = gatewayRotationKey(data.gateway, data.private_tier)
  const current = store[key]
  const activeTokenHash = hashGatewayToken(data.next_token)

  const rotation: GatewayAuthRotation = {
    gateway: data.gateway,
    private_tier: data.private_tier,
    active_token_hash: activeTokenHash,
    previous_token_hash: current?.active_token_hash && current.active_token_hash !== activeTokenHash
      ? current.active_token_hash
      : current?.previous_token_hash ?? null,
    previous_expires_at: current?.active_token_hash && current.active_token_hash !== activeTokenHash
      ? now + data.overlap_ms
      : current?.previous_expires_at ?? null,
    rotated_by: data.rotated_by,
    rotated_at: now,
  }

  store[key] = rotation
  await writeGatewayAuthRotationStore(store)
  return rotation
}

async function readPreferenceStore(): Promise<NotificationPreferenceStore> {
  try {
    const raw = await readFile(serverDataJsonPath("notificationPreferences"), "utf8")
    const parsed = JSON.parse(raw) as NotificationPreferenceStore
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writePreferenceStore(data: NotificationPreferenceStore): Promise<void> {
  const filePath = serverDataJsonPath("notificationPreferences")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

export async function getNotificationPreferences(wallet: string): Promise<NotificationPreferences> {
  const store = await readPreferenceStore()
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(store[wallet] ?? {}) }
}

export async function saveNotificationPreferences(
  wallet: string,
  preferences: Partial<Omit<NotificationPreferences, "updated_at">>,
): Promise<NotificationPreferences> {
  const current = await getNotificationPreferences(wallet)
  const next: NotificationPreferences = {
    enabled: preferences.enabled ?? current.enabled,
    types: { ...current.types, ...(preferences.types ?? {}) },
    updated_at: Date.now(),
  }
  const store = await readPreferenceStore()
  store[wallet] = next
  await writePreferenceStore(store)
  return next
}

export async function shouldStoreNotification(wallet: string, type: NotificationType): Promise<boolean> {
  if (!isNotificationPreferencesEnabled()) return true
  const preferences = await getNotificationPreferences(wallet)
  if (!preferences.enabled) return false
  return preferences.types[type] ?? true
}

async function readStore(): Promise<NotificationStore> {
  try {
    return JSON.parse(await readFile(serverDataJsonPath("notifications"), "utf8")) as NotificationStore
  } catch {
    return {}
  }
}

async function writeStore(data: NotificationStore): Promise<void> {
  const filePath = serverDataJsonPath("notifications")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

export async function createNotification(
  wallet: string,
  type: NotificationType,
  data: Record<string, unknown>,
): Promise<void> {
  if (!(await shouldStoreNotification(wallet, type))) return

  const store = await readStore()
  const list = store[wallet] ?? []
  const notif: Notification = {
    id: randomUUID(),
    wallet,
    type,
    read: false,
    created_at: Date.now(),
    data,
  }
  // Prepend newest first; cap at MAX_PER_WALLET
  const updated = [notif, ...list].slice(0, MAX_PER_WALLET)
  store[wallet] = updated
  await writeStore(store)
}

export async function getNotifications(wallet: string, limit = 30): Promise<Notification[]> {
  const store = await readStore()
  return (store[wallet] ?? []).slice(0, limit)
}

export async function markRead(wallet: string, notificationId: string): Promise<void> {
  const store = await readStore()
  const list = store[wallet]
  if (!list) return
  store[wallet] = list.map((n) => (n.id === notificationId ? { ...n, read: true } : n))
  await writeStore(store)
}

export async function markAllRead(wallet: string): Promise<void> {
  const store = await readStore()
  const list = store[wallet]
  if (!list) return
  store[wallet] = list.map((n) => ({ ...n, read: true }))
  await writeStore(store)
}

export async function getUnreadCount(wallet: string): Promise<number> {
  const store = await readStore()
  return (store[wallet] ?? []).filter((n) => !n.read).length
}

// ── module #53 (phase-53): faucet analytics — claim funnel metrics ─────────
//
// Operators had no visibility into where users abandoned the reward flow: the
// only signal was a completed claim in the ledger, so drop-off between "opened
// the faucet" and "claim confirmed" was invisible. This isolated, flag-gated
// module records lightweight funnel events and aggregates them into per-stage
// counts, step-to-step conversion, and overall drop-off — the data behind a
// claim-funnel dashboard. Event bodies carry no secrets; wallet is optional and
// only used for unique-visitor counts.
//
// Feature flag: phase-53 (NEXT_PUBLIC_FEATURE_PHASE_53 / FEATURE_PHASE_53)
// Rollback: unset the flag → recordFaucetFunnelEvent throws FLAG_DISABLED and
//           nothing is written. The events sidecar can be deleted safely.

export const FAUCET_FUNNEL_STAGES = [
  "viewed",
  "wallet_connected",
  "claim_started",
  "claim_signed",
  "claim_confirmed",
  "claim_failed",
] as const

export type FaucetFunnelStage = (typeof FAUCET_FUNNEL_STAGES)[number]

/** Ordered happy-path stages (claim_failed is a terminal branch, not a step). */
const FUNNEL_PATH: FaucetFunnelStage[] = [
  "viewed",
  "wallet_connected",
  "claim_started",
  "claim_signed",
  "claim_confirmed",
]

const MAX_FUNNEL_EVENTS = 5_000

export function isFaucetAnalyticsEnabled(): boolean {
  const value = (process.env.NEXT_PUBLIC_FEATURE_PHASE_53 ?? process.env.FEATURE_PHASE_53 ?? "").trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

export function flag53RollbackNote(): string {
  return "Rollback phase-53: unset NEXT_PUBLIC_FEATURE_PHASE_53 / FEATURE_PHASE_53 or set to 0/false and restart. Funnel recording stops; the faucet-funnel-events.json sidecar can be deleted."
}

export const FaucetFunnelEventSchema = z.object({
  stage: z.enum(FAUCET_FUNNEL_STAGES),
  wallet: z.string().trim().min(1).max(56).optional(),
  session_id: z.string().trim().min(1).max(64).optional(),
  ts: z.number().int().min(0).max(4_102_444_800_000).optional(),
  reason: z.string().trim().max(200).optional(),
})

export type FaucetFunnelEventInput = z.infer<typeof FaucetFunnelEventSchema>

export type FaucetFunnelEvent = {
  stage: FaucetFunnelStage
  wallet: string | null
  session_id: string | null
  ts: number
  reason: string | null
}

type FaucetFunnelStore = { events: FaucetFunnelEvent[] }

export class FaucetFunnelError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED"
  details?: unknown
  constructor(code: FaucetFunnelError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "FaucetFunnelError"
    this.code = code
    this.details = details
  }
}

async function readFunnelStore(): Promise<FaucetFunnelStore> {
  try {
    const raw = await readFile(serverDataJsonPath("faucetFunnelEvents"), "utf8")
    const parsed = JSON.parse(raw) as FaucetFunnelStore
    return parsed && Array.isArray(parsed.events) ? parsed : { events: [] }
  } catch {
    return { events: [] }
  }
}

async function writeFunnelStore(data: FaucetFunnelStore): Promise<void> {
  const filePath = serverDataJsonPath("faucetFunnelEvents")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

export async function recordFaucetFunnelEvent(
  input: unknown,
  opts: { force?: boolean; now?: number } = {},
): Promise<FaucetFunnelEvent> {
  if (!opts.force && !isFaucetAnalyticsEnabled()) {
    throw new FaucetFunnelError("FLAG_DISABLED", "phase-53 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_53=1)", {
      rollback: flag53RollbackNote(),
    })
  }
  const parsed = FaucetFunnelEventSchema.safeParse(input)
  if (!parsed.success) {
    throw new FaucetFunnelError("VALIDATION_FAILED", "valid funnel event required", parsed.error.flatten())
  }
  const event: FaucetFunnelEvent = {
    stage: parsed.data.stage,
    wallet: parsed.data.wallet ?? null,
    session_id: parsed.data.session_id ?? null,
    ts: parsed.data.ts ?? opts.now ?? Date.now(),
    reason: parsed.data.reason ?? null,
  }
  const store = await readFunnelStore()
  store.events = [...store.events, event].slice(-MAX_FUNNEL_EVENTS)
  await writeFunnelStore(store)
  return event
}

export type ClaimFunnelStageMetric = {
  stage: FaucetFunnelStage
  events: number
  uniqueSubjects: number
  conversionFromPrev: number | null
  dropOffFromPrev: number | null
}

export type ClaimFunnelReport = {
  windowMs: number | null
  totalEvents: number
  stages: ClaimFunnelStageMetric[]
  failed: { events: number; uniqueSubjects: number }
  overallConversion: number
}

function subjectKey(e: FaucetFunnelEvent): string | null {
  return e.wallet ?? e.session_id ?? null
}

/** Pure aggregation: turn a flat event list into per-stage funnel metrics. */
export function computeClaimFunnel(events: readonly FaucetFunnelEvent[], opts: { windowMs?: number; now?: number } = {}): ClaimFunnelReport {
  const now = opts.now ?? Date.now()
  const scoped = opts.windowMs ? events.filter((e) => e.ts >= now - opts.windowMs!) : events

  const byStage = new Map<FaucetFunnelStage, FaucetFunnelEvent[]>()
  for (const stage of FAUCET_FUNNEL_STAGES) byStage.set(stage, [])
  for (const e of scoped) byStage.get(e.stage)?.push(e)

  const uniqueOf = (list: FaucetFunnelEvent[]) => new Set(list.map(subjectKey).filter((k): k is string => k !== null)).size

  const stages: ClaimFunnelStageMetric[] = FUNNEL_PATH.map((stage, i) => {
    const list = byStage.get(stage) ?? []
    const unique = uniqueOf(list)
    let conversionFromPrev: number | null = null
    let dropOffFromPrev: number | null = null
    if (i > 0) {
      const prev = uniqueOf(byStage.get(FUNNEL_PATH[i - 1]!) ?? [])
      conversionFromPrev = prev > 0 ? Math.round((unique / prev) * 10_000) / 10_000 : 0
      dropOffFromPrev = prev > 0 ? Math.round((1 - unique / prev) * 10_000) / 10_000 : 0
    }
    return { stage, events: list.length, uniqueSubjects: unique, conversionFromPrev, dropOffFromPrev }
  })

  const failedList = byStage.get("claim_failed") ?? []
  const top = stages[0]?.uniqueSubjects ?? 0
  const bottom = stages[stages.length - 1]?.uniqueSubjects ?? 0

  return {
    windowMs: opts.windowMs ?? null,
    totalEvents: scoped.length,
    stages,
    failed: { events: failedList.length, uniqueSubjects: uniqueOf(failedList) },
    overallConversion: top > 0 ? Math.round((bottom / top) * 10_000) / 10_000 : 0,
  }
}

export async function getFaucetFunnelAnalytics(opts: { windowMs?: number; now?: number } = {}): Promise<ClaimFunnelReport> {
  const store = await readFunnelStore()
  return computeClaimFunnel(store.events, opts)
}

export function auditFaucetAnalyticsWiring(): { ok: boolean; note: string } {
  if (!isFaucetAnalyticsEnabled()) {
    return { ok: true, note: "[phase-53] faucet claim-funnel analytics disabled; nothing to audit." }
  }
  const probe: FaucetFunnelEvent[] = [
    { stage: "viewed", wallet: null, session_id: "s1", ts: 1, reason: null },
    { stage: "wallet_connected", wallet: "GW1", session_id: "s1", ts: 2, reason: null },
    { stage: "claim_started", wallet: "GW1", session_id: "s1", ts: 3, reason: null },
  ]
  try {
    const report = computeClaimFunnel(probe)
    if (report.stages.length !== FUNNEL_PATH.length) {
      return { ok: false, note: "[phase-53] funnel report shape drift (report)." }
    }
    return { ok: true, note: `[phase-53] faucet claim-funnel analytics wiring OK. ${flag53RollbackNote()}` }
  } catch (e) {
    return { ok: false, note: `[phase-53] funnel analytics schema drift (unexpected, report): ${e instanceof Error ? e.message : String(e)}` }
  }
}
