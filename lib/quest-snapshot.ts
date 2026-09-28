/**
 * phase-130: Quest progress snapshotting to survive serverless cold starts.
 *
 * On Vercel/Netlify serverless, every function invocation may start fresh.
 * The in-memory `questProgressCache` in the faucet route is lost on cold
 * start, causing redundant on-chain scans. This module persists snapshots
 * to disk (JSON sidecar) so the next cold start can load recent progress
 * without re-scanning the ledger.
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_130 / FEATURE_PHASE_130
 * Rollback: unset the flag. In-memory cache reverts to its previous behavior.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { isFeatureEnabled } from "@/lib/feature-flags"

const FLAG: "phase-130" = "phase-130"

export function isQuestSnapshotEnabled(): boolean {
  return isFeatureEnabled(FLAG)
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
  if (!isQuestSnapshotEnabled()) return null
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
  if (!isQuestSnapshotEnabled()) return
  if (!wallet) return

  const store = await readSnapshotStore()
  store[wallet] = {
    wallet,
    progress,
    snapshotAt: Date.now(),
  }
  await writeSnapshotStore(store)
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
