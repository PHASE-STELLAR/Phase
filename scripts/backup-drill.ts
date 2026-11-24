/**
 * Disaster-recovery drill: local + encrypted off-box recovery — Spike 605 / Issue #469 / Issue #654 (phase-227).
 *
 * 1. Snapshots the live data root, verifies it, restores it into a scratch directory,
 *    and proves SQLite parity between source and restore.
 * 2. When phase-227 is enabled (or flag --offbox is passed):
 *    - Encrypts snapshot bundle with AES-256-GCM (scrypt-derived key)
 *    - Ships to remote storage abstraction
 *    - Downloads from remote storage to a fresh recovery scratch directory
 *    - Tests that an invalid passphrase is strictly rejected
 *    - Decrypts with correct passphrase and restores into scratch recovery directory
 *    - Verifies manifest, JSON sidecars, SQLite integrity, and table parity
 *
 * Never writes into the live data root and never prints secrets.
 *
 * Usage:
 *   npx tsx scripts/backup-drill.ts [snapshot-dir] [--offbox]
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

process.env.FEATURE_PHASE_171 = "1"
process.env.FEATURE_PHASE_172 = "1"
process.env.FEATURE_PHASE_227 = "1"

export async function runBackupDrill(opts: {
  snapshotDir?: string
  offbox?: boolean
  passphrase?: string
} = {}): Promise<{
  ok: boolean
  localOk: boolean
  offboxOk?: boolean
  problems: string[]
}> {
  const { createSnapshot, restoreSnapshot, verifySnapshot } = await import("../lib/backup-snapshot")
  const { compareSources, sqliteParitySource } = await import("../lib/db-parity")
  const { getDb } = await import("../lib/sqlite-db")

  const snapDir = opts.snapshotDir ?? (await mkdtemp(path.join(tmpdir(), "phase-drill-snap-")))
  const restoreDir = await mkdtemp(path.join(tmpdir(), "phase-drill-restore-"))
  const problems: string[] = []

  let localOk = false
  let offboxOk: boolean | undefined = undefined

  try {
    // ── Local Snapshot & Restore Drill ───────────────────────────────────────
    const manifest = await createSnapshot(snapDir)
    console.log(`[drill] snapshot: ${manifest.files.length} sidecar(s), ${Object.keys(manifest.sqlite?.tables ?? {}).length} table(s) -> ${snapDir}`)

    const verification = await verifySnapshot(snapDir)
    if (!verification.ok) {
      problems.push(...verification.problems)
      console.error("[drill] local verify FAILED:", verification.problems)
      return { ok: false, localOk: false, problems }
    }
    console.log("[drill] local verify: ok")

    await restoreSnapshot(snapDir, restoreDir)
    const restored = new DatabaseSync(path.join(restoreDir, "phase.sqlite3"), { readOnly: true })
    const parity = compareSources(sqliteParitySource(getDb()), sqliteParitySource(restored))
    restored.close()
    if (!parity.ok) {
      const mismatches = parity.tables.filter((t) => !t.match).map((t) => t.table)
      problems.push(`Table parity mismatch: ${mismatches.join(", ")}`)
      console.error("[drill] local parity FAILED:", JSON.stringify(mismatches))
      return { ok: false, localOk: false, problems }
    }
    console.log(`[drill] local parity: ok across ${parity.tables.length} table(s); restored into ${restoreDir}`)
    localOk = true

    // ── Off-Box Encrypted Shipping & Restore Drill (Issue #654) ───────────────
    if (opts.offbox !== false) {
      console.log("[drill] starting off-box encrypted shipping and recovery drill...")
      const {
        shipSnapshotOffBox,
        unsealSnapshotBundle,
        resolveRemoteStorage,
        resolveBackupPassphrase,
      } = await import("../lib/backup-shipping")

      const testPassphrase = opts.passphrase || process.env.BACKUP_ENCRYPTION_PASSPHRASE || "drill-test-passphrase-at-least-16-chars!"
      process.env.BACKUP_ENCRYPTION_PASSPHRASE = testPassphrase

      const storage = resolveRemoteStorage()
      const shipResult = await shipSnapshotOffBox(snapDir, {
        passphrase: testPassphrase,
        storage,
      })

      if (!shipResult.ok) {
        problems.push(`Off-box shipping failed: ${shipResult.error}`)
        console.error("[drill] off-box ship FAILED:", shipResult.error)
        return { ok: false, localOk, offboxOk: false, problems }
      }
      console.log(`[drill] off-box shipped: ${shipResult.remoteKey} (${shipResult.bytesShipped} bytes)`)

      // Retrieve encrypted bundle from remote storage
      const remoteBytes = await storage.getObject(shipResult.remoteKey)
      if (!remoteBytes) {
        problems.push("Could not retrieve remote encrypted bundle from storage")
        return { ok: false, localOk, offboxOk: false, problems }
      }

      // Test wrong passphrase rejection
      const offboxScratchDir = await mkdtemp(path.join(tmpdir(), "phase-drill-offbox-recovery-"))
      try {
        let wrongPassRejected = false
        try {
          await unsealSnapshotBundle(remoteBytes, "wrong-passphrase-16-chars-long", offboxScratchDir)
        } catch {
          wrongPassRejected = true
        }
        if (!wrongPassRejected) {
          problems.push("Security check failed: unsealing with incorrect passphrase did not throw")
          return { ok: false, localOk, offboxOk: false, problems }
        }
        console.log("[drill] wrong passphrase rejection: verified")

        // Unseal with valid passphrase
        const unsealedManifest = await unsealSnapshotBundle(remoteBytes, testPassphrase, offboxScratchDir)
        const offboxVerification = await verifySnapshot(offboxScratchDir)
        if (!offboxVerification.ok) {
          problems.push(...offboxVerification.problems)
          console.error("[drill] off-box unsealed verify FAILED:", offboxVerification.problems)
          return { ok: false, localOk, offboxOk: false, problems }
        }
        console.log(`[drill] off-box unsealed verify: ok (${unsealedManifest.files.length} sidecars)`)

        // Parity check on unsealed database
        const offboxRestoredDb = new DatabaseSync(path.join(offboxScratchDir, "phase.sqlite3"), { readOnly: true })
        const offboxParity = compareSources(sqliteParitySource(getDb()), sqliteParitySource(offboxRestoredDb))
        offboxRestoredDb.close()
        if (!offboxParity.ok) {
          const mismatches = offboxParity.tables.filter((t) => !t.match).map((t) => t.table)
          problems.push(`Off-box table parity mismatch: ${mismatches.join(", ")}`)
          return { ok: false, localOk, offboxOk: false, problems }
        }
        console.log(`[drill] off-box restore parity: ok across ${offboxParity.tables.length} table(s)`)
        offboxOk = true
      } finally {
        await rm(offboxScratchDir, { recursive: true, force: true }).catch(() => {})
      }
    }

    return { ok: localOk && (offboxOk !== false), localOk, offboxOk, problems: [] }
  } finally {
    await rm(restoreDir, { recursive: true, force: true }).catch(() => {})
    if (!opts.snapshotDir) {
      await rm(snapDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const isOffboxArg = args.includes("--offbox") || args.length === 0 || Boolean(process.env.FEATURE_PHASE_227)
  const snapDirArg = args.find((a) => !a.startsWith("--"))

  const result = await runBackupDrill({
    snapshotDir: snapDirArg,
    offbox: isOffboxArg,
  })

  if (!result.ok) {
    console.error("[drill] Drill execution failed with problems:", result.problems)
    process.exit(1)
  }
  console.log("[drill] All disaster-recovery drill checks passed successfully.")
}

// If run directly as script
if (typeof require !== "undefined" && require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
} else {
  // If run via tsx ESM
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
