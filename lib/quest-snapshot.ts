/**
 * phase-130: Quest progress snapshotting to survive serverless cold starts.
 *
 * On Vercel/Netlify serverless, every function invocation may start fresh.
 * The in-memory `questProgressCache` in the faucet route is lost on cold
 * start, causing redundant on-chain scans. This module persists snapshots
 * to disk (JSON sidecar) so the next cold start can load recent progress
 * without re-scanning the ledger.
 *
 * Issue #733: Quest expiry windows with explicit UTC inclusive/exclusive bounds
 * and snapshot integrity verification at claim time.
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_130 / FEATURE_PHASE_130
 *        NEXT_PUBLIC_FEATURE_PHASE_275 / FEATURE_PHASE_275 (expiry + integrity)
 * Rollback: unset the flag. In-memory cache reverts to its previous behavior.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { createHash } from "node:crypto"

const FLAG: "phase-130" = "phase-130"
const EXPIRY_FLAG: "phase-275" = "phase-275"

export function isQuestSnapshotEnabled(wallet?: string): boolean {
  return isFeatureEnabled(FLAG, wallet ? { wallet } : undefined)
}

export type QuestId =
  | "quest_connect_wallet"
  | "quest_first_collection"
  | "quest_first_settle"
  | "quest_first_world"
  | "quest_three_collections"

export type QuestProgress = {
  completed: boolean
  progressPct: number
  requirementText: string
}

export type QuestSnapshotEntry = {
  wallet: string
  progress: Record<QuestId, QuestProgress>
  snapshotAt: number
  cohortKey?: string
  /** phase-254: monotonic per-wallet snapshot version & integrity hash */
  version?: number
  snapshotHash?: string
}

type QuestSnapshotStore = Record<string, QuestSnapshotEntry>

const SNAPSHOT_TTL_MS = 5 * 60 * 1000 // 5 minutes — fresh enough to avoid stale UX

function snapshotFilePath(): string {
  const fromEnv = process.env.PHASE_SERVER_DATA_DIR?.trim()
  const root = fromEnv
    ? fromEnv
    : process.env.VERCEL
      ? path.join(require("node:os").tmpdir(), "phase-server-data")
      : path.join(process.cwd(), ".data")
  return path.join(root, "quest-progress-snapshots.json")
}

async function readSnapshotStore(): Promise<QuestSnapshotStore> {
  try {
    const raw = await readFile(snapshotFilePath(), "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed as QuestSnapshotStore
    return {}
  } catch {
    return {}
  }
}

async function writeSnapshotStore(data: QuestSnapshotStore): Promise<void> {
  const fp = snapshotFilePath()
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(data, null, 2), "utf8")
}

/**
 * Load a cached quest-progress snapshot if available and fresh.
 * Returns null when the flag is off, the snapshot is missing, or it is stale.
 */
export async function loadQuestSnapshot(
  wallet: string,
): Promise<Record<QuestId, QuestProgress> | null> {
  if (!isQuestSnapshotEnabled(wallet)) return null
  if (!wallet) return null

  const store = await readSnapshotStore()
  const entry = store[wallet]
  if (!entry) return null
  if (Date.now() - entry.snapshotAt > SNAPSHOT_TTL_MS) return null
  return entry.progress
}

/**
 * Persist a quest-progress snapshot for the given wallet.
 * Called after a fresh on-chain scan to give the next cold start a head start.
 */
export async function saveQuestSnapshot(
  wallet: string,
  progress: Record<QuestId, QuestProgress>,
): Promise<void> {
  if (!isQuestSnapshotEnabled(wallet)) return
  if (!wallet) return

  const store = await readSnapshotStore()
  const prev = store[wallet]
  const nextVersion = (prev?.version ?? 0) + 1
  const now = Date.now()
  const entry: QuestSnapshotEntry = {
    wallet,
    progress,
    snapshotAt: now,
    version: nextVersion,
  }
  entry.snapshotHash = computeSnapshotHash(entry)
  store[wallet] = entry
  await writeSnapshotStore(store)
}

/**
 * phase-254: Persist a versioned, hash-bound quest snapshot for bounty claims.
 * Works when either `phase-254` or `phase-130` is enabled.
 */
export async function saveVersionedQuestSnapshot(
  wallet: string,
  progress: Record<QuestId, QuestProgress>,
  now: number = Date.now(),
): Promise<QuestSnapshotEntry> {
  const store = await readSnapshotStore()
  const prev = store[wallet]
  const nextVersion = (prev?.version ?? 0) + 1
  const entry: QuestSnapshotEntry = {
    wallet,
    progress,
    snapshotAt: now,
    version: nextVersion,
  }
  entry.snapshotHash = computeSnapshotHash(entry)
  store[wallet] = entry
  await writeSnapshotStore(store)
  return entry
}

/**
 * phase-254: Load the latest versioned quest snapshot for a wallet.
 * Returns null if absent or expired past `maxAgeMs`.
 */
export async function loadVersionedQuestSnapshot(
  wallet: string,
  maxAgeMs: number = SNAPSHOT_TTL_MS,
): Promise<(QuestSnapshotEntry & { version: number; snapshotHash: string }) | null> {
  if (!wallet) return null
  const store = await readSnapshotStore()
  const entry = store[wallet]
  if (!entry) return null
  if (Date.now() - entry.snapshotAt > maxAgeMs) return null
  const version = typeof entry.version === "number" && entry.version > 0 ? entry.version : 1
  const snapshotHash = entry.snapshotHash ?? computeSnapshotHash(entry)
  return { ...entry, version, snapshotHash }
}

/**
 * Prune entries older than `maxAgeMs` from the snapshot store.
 * Call periodically (e.g. on each save) to prevent unbounded growth.
 */
export async function pruneStaleSnapshots(maxAgeMs: number = 30 * 60 * 1000): Promise<number> {
  const store = await readSnapshotStore()
  const now = Date.now()
  let pruned = 0
  for (const [wallet, entry] of Object.entries(store)) {
    if (now - entry.snapshotAt > maxAgeMs) {
      delete store[wallet]
      pruned++
    }
  }
  if (pruned > 0) await writeSnapshotStore(store)
  return pruned
}

// ─── Issue #733: Quest expiry windows and snapshot integrity ──────────────

/**
 * Quest expiry window policy.
 * Bounds are INCLUSIVE at the start, EXCLUSIVE at the end (standard [start, end) convention).
 * This means a quest with expiresAt = T is still "active" at T-1ms but "expired" at T.
 */
export type QuestExpiryWindow = {
  /** Quest creation timestamp (UTC, ms) */
  createdAt: number
  /** Time-to-live in ms from creation */
  ttlMs: number
  /** Grace period after expiry (ms) — INCLUSIVE of the start, EXCLUSIVE of the end */
  graceMs?: number
}

export type QuestExpiryState = "active" | "grace" | "expired"

export type QuestExpiryResult = {
  state: QuestExpiryState
  expiresAt: number
  graceUntil: number | null
  /** Remaining ms before expiry (0 if expired) */
  msRemaining: number
}

/**
 * Typed errors for quest claim validation.
 */
export class QuestClaimError extends Error {
  readonly code: "CLAIM_TOO_EARLY" | "CLAIM_EXPIRED" | "SNAPSHOT_TAMPERED" | "SNAPSHOT_MISSING"
  readonly detail?: string

  constructor(
    code: QuestClaimError["code"],
    message: string,
    detail?: string,
  ) {
    super(message)
    this.name = "QuestClaimError"
    this.code = code
    this.detail = detail
  }
}

/**
 * Issue #733: Compute quest expiry state at a given UTC timestamp.
 *
 * Boundaries are INCLUSIVE at the start:
 * - active:   [createdAt, expiresAt)    — createdAt ≤ now < expiresAt
 * - grace:    [expiresAt, graceUntil)   — expiresAt ≤ now < graceUntil
 * - expired:  [graceUntil, ∞)            — now ≥ graceUntil
 */
export function computeQuestExpiryWindow(
  window: QuestExpiryWindow,
  nowUtcMs: number,
): QuestExpiryResult {
  const expiresAt = window.createdAt + window.ttlMs
  const graceMs = window.graceMs ?? 0
  const graceUntil = expiresAt + graceMs

  if (nowUtcMs < expiresAt) {
    return {
      state: "active",
      expiresAt,
      graceUntil: graceMs > 0 ? graceUntil : null,
      msRemaining: expiresAt - nowUtcMs,
    }
  }

  if (graceMs > 0 && nowUtcMs < graceUntil) {
    return {
      state: "grace",
      expiresAt,
      graceUntil,
      msRemaining: 0,
    }
  }

  return {
    state: "expired",
    expiresAt,
    graceUntil: graceMs > 0 ? graceUntil : null,
    msRemaining: 0,
  }
}

/**
 * Issue #733: Compute a cryptographic hash of a quest snapshot for integrity verification.
 * Uses SHA-256 over a canonical JSON encoding of the snapshot entry.
 */
export function computeSnapshotHash(entry: Omit<QuestSnapshotEntry, "cohortKey">): string {
  const canonical = JSON.stringify({
    wallet: entry.wallet,
    progress: entry.progress,
    snapshotAt: entry.snapshotAt,
  })
  return createHash("sha256").update(canonical).digest("hex")
}

/**
 * Issue #733: Verify a quest snapshot against an expected hash.
 * Rejects tampered snapshots with a typed error.
 */
export function verifySnapshotIntegrity(
  entry: QuestSnapshotEntry,
  expectedHash: string,
): { ok: boolean; error?: QuestClaimError } {
  const actualHash = computeSnapshotHash(entry)
  if (actualHash !== expectedHash) {
    return {
      ok: false,
      error: new QuestClaimError(
        "SNAPSHOT_TAMPERED",
        "Quest snapshot integrity check failed: hash mismatch.",
        `Expected ${expectedHash.slice(0, 16)}… but got ${actualHash.slice(0, 16)}…`,
      ),
    }
  }
  return { ok: true }
}

/**
 * Issue #733: Validate a quest claim against expiry window and snapshot integrity.
 *
 * Rejects:
 * - Claims before the quest's creation (too early) with CLAIM_TOO_EARLY
 * - Claims after the expiry window (expired) with CLAIM_EXPIRED
 * - Claims with a tampered snapshot with SNAPSHOT_TAMPERED
 * - Claims with no snapshot when one is expected with SNAPSHOT_MISSING
 *
 * @param window - The quest expiry window policy
 * @param nowUtcMs - Current UTC timestamp in ms
 * @param snapshot - Optional snapshot entry for integrity verification
 * @param expectedHash - Optional expected hash of the snapshot
 */
export function validateQuestClaim(
  window: QuestExpiryWindow,
  nowUtcMs: number,
  snapshot?: QuestSnapshotEntry,
  expectedHash?: string,
): { ok: boolean; error?: QuestClaimError; expiryState?: QuestExpiryState } {
  const flagOn = isFeatureEnabled(EXPIRY_FLAG as any)

  // Flag off: legacy claim validation (no expiry or integrity checks)
  if (!flagOn) return { ok: true }

  // Check early claims (before creation timestamp)
  if (nowUtcMs < window.createdAt) {
    return {
      ok: false,
      error: new QuestClaimError(
        "CLAIM_TOO_EARLY",
        "Quest claim submitted before quest creation time.",
        `now (${nowUtcMs}) < createdAt (${window.createdAt})`,
      ),
    }
  }

  // Compute expiry state — INCLUSIVE bounds
  const expiry = computeQuestExpiryWindow(window, nowUtcMs)

  // A claim one second after expiry is rejected
  if (expiry.state === "expired") {
    return {
      ok: false,
      expiryState: "expired",
      error: new QuestClaimError(
        "CLAIM_EXPIRED",
        "Quest has expired and can no longer be claimed.",
        `expired at ${expiry.graceUntil ?? expiry.expiresAt}, now is ${nowUtcMs}`,
      ),
    }
  }

  // Verify snapshot integrity if a snapshot and expected hash are provided
  if (snapshot && expectedHash) {
    const integrity = verifySnapshotIntegrity(snapshot, expectedHash)
    if (!integrity.ok) {
      return {
        ok: false,
        expiryState: expiry.state,
        error: integrity.error,
      }
    }
  } else if (expectedHash && !snapshot) {
    return {
      ok: false,
      expiryState: expiry.state,
      error: new QuestClaimError(
        "SNAPSHOT_MISSING",
        "Snapshot was expected for integrity verification but none was provided.",
      ),
    }
  }

  return { ok: true, expiryState: expiry.state }
}
