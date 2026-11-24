/**
 * Scheduled Snapshots & Automated Disaster Recovery Drills — Issue #654
 *
 * Feature flag: phase-227
 *
 * Provides:
 *  - Scheduled snapshot execution with lock-consistent snapshotting (VACUUM INTO)
 *  - Concurrency lock protection to prevent conflicting scheduled executions
 *  - Off-box encrypted shipping + retention policy pruning
 *  - Failure alerting via webhook alerts
 *  - Automated recovery drill verification
 */

import { stat, writeFile, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"
import { sendWebhookAlert } from "@/lib/webhook-alerts"
import {
  BackupError,
  createSnapshot,
  verifySnapshot,
  restoreSnapshot,
  isRestoreInProgress,
  RESTORE_MARKER_NAME,
} from "@/lib/backup-snapshot"
import {
  isPhase227Enabled,
  shipSnapshotOffBox,
  applyBackupRetention,
  resolveRemoteStorage,
  unsealSnapshotBundle,
  resolveBackupPassphrase,
  type RemoteObjectStorage,
} from "@/lib/backup-shipping"
import { serverDataRoot } from "@/lib/server-data-paths"
import { getDb } from "@/lib/sqlite-db"
import { compareSources, sqliteParitySource } from "@/lib/db-parity"

export const SCHEDULED_SNAPSHOT_LOCK_NAME = ".snapshot-in-progress"
export const SCHEDULED_SNAPSHOT_LOCK_TTL_MS = 15 * 60 * 1000 // 15 min lock TTL

export type ScheduledBackupResult = {
  ok: boolean
  snapshotId: string
  remoteKey: string
  bytes: number
  retainedCount: number
  prunedCount: number
  durationMs: number
  error?: string
}

export type RestoreDrillResult = {
  ok: boolean
  drillId: string
  verified: boolean
  parityOk: boolean
  durationMs: number
  tableCount: number
  problems: string[]
}

/**
 * Checks if a scheduled snapshot is currently executing.
 */
export async function isSnapshotInProgress(root: string = serverDataRoot(), now: number = Date.now()): Promise<boolean> {
  try {
    const info = await stat(path.join(root, SCHEDULED_SNAPSHOT_LOCK_NAME))
    return now - info.mtimeMs < SCHEDULED_SNAPSHOT_LOCK_TTL_MS
  } catch {
    return false
  }
}

/**
 * Runs a complete scheduled backup:
 *  1. Checks phase-227
 *  2. Acquires snapshot mutex lock
 *  3. Creates local lock-consistent snapshot (VACUUM INTO + sidecars)
 *  4. Seals and ships encrypted snapshot off-box
 *  5. Prunes expired remote backups according to retention policy
 *  6. Alerts on failure
 */
export async function runScheduledBackup(opts: {
  passphrase?: string
  storage?: RemoteObjectStorage
  dataRoot?: string
  retentionMinKeep?: number
  retentionMaxAgeDays?: number
} = {}): Promise<ScheduledBackupResult> {
  if (!isPhase227Enabled()) {
    throw new BackupError(
      "FLAG_DISABLED",
      `Scheduled off-box backups disabled (phase-227 flag off). ${flagRollbackNote("phase-227")}`,
    )
  }

  const root = opts.dataRoot || serverDataRoot()
  const now = Date.now()
  const start = Date.now()

  // Prevent running mid-restore
  if (await isRestoreInProgress(root, now)) {
    throw new BackupError("RESTORE_IN_PROGRESS", "Cannot create backup while restore is in progress")
  }

  // Mutex lock to prevent overlapping scheduled snapshot runs
  if (await isSnapshotInProgress(root, now)) {
    incSecurityCounter("backup_restore_blocked")
    throw new Error("Another snapshot is currently in progress")
  }

  const lockFile = path.join(root, SCHEDULED_SNAPSHOT_LOCK_NAME)
  await writeFile(lockFile, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }))

  let tempDir: string | null = null

  try {
    incSecurityCounter("backup_scheduler_triggered")
    tempDir = await mkdtemp(path.join(tmpdir(), "phase-scheduled-backup-"))

    // Step 1: Create local snapshot
    const manifest = await createSnapshot(tempDir)

    // Step 2: Ship off-box with encryption
    const shipResult = await shipSnapshotOffBox(tempDir, {
      passphrase: opts.passphrase,
      storage: opts.storage,
    })

    if (!shipResult.ok) {
      throw new Error(`Off-box shipping failed: ${shipResult.error}`)
    }

    // Step 3: Apply retention policy
    const retentionRes = await applyBackupRetention({
      storage: opts.storage,
      policy: {
        minBackupsToKeep: opts.retentionMinKeep ?? 3,
        maxAgeDays: opts.retentionMaxAgeDays ?? 14,
      },
    }).catch(() => ({ retained: [], deleted: [] }))

    const durationMs = Date.now() - start
    return {
      ok: true,
      snapshotId: shipResult.id,
      remoteKey: shipResult.remoteKey,
      bytes: shipResult.bytesShipped,
      retainedCount: retentionRes.retained.length,
      prunedCount: retentionRes.deleted.length,
      durationMs,
    }
  } catch (error) {
    incSecurityCounter("backup_offbox_failed")
    const msg = error instanceof Error ? error.message : String(error)
    await sendWebhookAlert("critical", "Scheduled Backup Run Failed", {
      error: msg,
      timestamp: new Date().toISOString(),
    }).catch(() => {})
    throw error
  } finally {
    await rm(lockFile, { force: true }).catch(() => {})
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Executes an automated disaster-recovery drill from an off-box snapshot into a scratch directory:
 *  1. Retrieves encrypted off-box bundle from remote storage
 *  2. Unseals bundle in an isolated recovery directory (never overwrites live production data)
 *  3. Verifies manifest, JSON sidecars, SQLite integrity
 *  4. Validates table parity
 *  5. Alerts on drill failure
 */
export async function runAutomatedRestoreDrill(opts: {
  remoteKey?: string
  passphrase?: string
  storage?: RemoteObjectStorage
} = {}): Promise<RestoreDrillResult> {
  const start = Date.now()
  const drillId = `drill_${Date.now()}`
  const storage = opts.storage || resolveRemoteStorage()
  const passphrase = resolveBackupPassphrase(opts.passphrase)

  let remoteKey = opts.remoteKey
  if (!remoteKey) {
    const list = await storage.listObjects("snapshots/")
    const encList = list.filter((l) => l.key.endsWith(".enc.json"))
    if (encList.length === 0) {
      incSecurityCounter("backup_drill_failed")
      await sendWebhookAlert("critical", "Restore Drill Failed: No remote snapshots found", { drillId }).catch(() => {})
      return {
        ok: false,
        drillId,
        verified: false,
        parityOk: false,
        durationMs: Date.now() - start,
        tableCount: 0,
        problems: ["No remote snapshots available for restore drill"],
      }
    }
    remoteKey = encList[0]!.key
  }

  const bundleBytes = await storage.getObject(remoteKey)
  if (!bundleBytes) {
    incSecurityCounter("backup_drill_failed")
    await sendWebhookAlert("critical", "Restore Drill Failed: Remote object not found", { drillId, remoteKey }).catch(() => {})
    return {
      ok: false,
      drillId,
      verified: false,
      parityOk: false,
      durationMs: Date.now() - start,
      tableCount: 0,
      problems: [`Remote object ${remoteKey} could not be retrieved`],
    }
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), "phase-drill-recovery-"))

  try {
    // Unseal into scratch directory
    const manifest = await unsealSnapshotBundle(bundleBytes, passphrase, scratchDir)
    const verification = await verifySnapshot(scratchDir)

    if (!verification.ok) {
      incSecurityCounter("backup_drill_failed")
      await sendWebhookAlert("critical", "Restore Drill Failed: Snapshot verification failed", {
        drillId,
        problems: verification.problems,
      }).catch(() => {})
      return {
        ok: false,
        drillId,
        verified: false,
        parityOk: false,
        durationMs: Date.now() - start,
        tableCount: 0,
        problems: verification.problems,
      }
    }

    // Parity check against live database
    const restoredDb = new DatabaseSync(path.join(scratchDir, "phase.sqlite3"), { readOnly: true })
    const parity = compareSources(sqliteParitySource(getDb()), sqliteParitySource(restoredDb))
    restoredDb.close()

    if (!parity.ok) {
      incSecurityCounter("backup_drill_failed")
      const problems = parity.tables.filter((t) => !t.match).map((t) => `Table mismatch: ${t.table}`)
      await sendWebhookAlert("critical", "Restore Drill Failed: Database parity mismatch", {
        drillId,
        problems,
      }).catch(() => {})
      return {
        ok: false,
        drillId,
        verified: true,
        parityOk: false,
        durationMs: Date.now() - start,
        tableCount: parity.tables.length,
        problems,
      }
    }

    incSecurityCounter("backup_drill_passed")
    return {
      ok: true,
      drillId,
      verified: true,
      parityOk: true,
      durationMs: Date.now() - start,
      tableCount: parity.tables.length,
      problems: [],
    }
  } catch (error) {
    incSecurityCounter("backup_drill_failed")
    const msg = error instanceof Error ? error.message : String(error)
    await sendWebhookAlert("critical", "Restore Drill Exception", { drillId, error: msg }).catch(() => {})
    return {
      ok: false,
      drillId,
      verified: false,
      parityOk: false,
      durationMs: Date.now() - start,
      tableCount: 0,
      problems: [msg],
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  }
}
