/**
 * Backup and disaster-recovery snapshots — partial slice of spike 605 (issue #469).
 *
 * Nothing used to snapshot the ~40 JSON sidecars or `phase.sqlite3`. Each
 * sidecar write is atomic, but the *set* is not, and a raw copy of a WAL
 * database is not a consistent image. This module captures all of them at one
 * logical instant, proves the image is restorable, and restores it without
 * racing the distributor refill cron.
 *
 * - Consistency: every sidecar path is locked (sorted order, so lockers cannot
 *   deadlock) and the SQLite image is produced with `VACUUM INTO`, which is a
 *   transactionally consistent copy that needs no WAL/SHM files.
 * - Integrity: a manifest carries sha256 and size per file plus per-table row
 *   counts. `verifySnapshot` re-hashes, parses JSON, and runs SQLite
 *   `integrity_check` and `foreign_key_check`.
 * - Restore safety: `restoreSnapshot` verifies first, writes through tmp+rename,
 *   and holds a marker file for the duration. `isRestoreInProgress` lets the
 *   faucet-health cron refuse to run mid-restore instead of double-spending.
 * - Secrets: never written into a snapshot. `sealSecrets` produces an
 *   AES-256-GCM envelope (scrypt-derived key) that is only ever decrypted by
 *   `openSecrets`; errors never echo plaintext.
 *
 * Scope: library + drill script (`scripts/backup-drill.ts`). Off-box
 * shipping to object storage, scheduled snapshots, and `age`/SOPS interop are
 * spike 605 follow-ups; a cron that writes into Vercel's `os.tmpdir()` would be
 * false safety, so none is added.
 *
 * Feature flag: phase-171. Rollback: unset → every entry point throws
 * `FLAG_DISABLED` and `isRestoreInProgress` returns false; snapshots already on
 * disk are inert.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { withFileLock } from "@/lib/json-store"
import { incSecurityCounter } from "@/lib/security-counters"
import { getDb } from "@/lib/sqlite-db"
import {
  serverDataFileKeys,
  serverDataFileName,
  serverDataJsonPath,
  serverDataRoot,
} from "@/lib/server-data-paths"

export const SNAPSHOT_MANIFEST_NAME = "manifest.json"
export const RESTORE_MARKER_NAME = ".restore-in-progress"
/** A marker older than this is a crashed restore, not a live one. */
export const RESTORE_MARKER_TTL_MS = 10 * 60 * 1000

export type SnapshotFileEntry = { name: string; bytes: number; sha256: string }
export type SnapshotManifest = {
  version: 1
  createdAt: string
  files: SnapshotFileEntry[]
  sqlite: (SnapshotFileEntry & { tables: Record<string, number> }) | null
}

export type BackupErrorCode =
  | "FLAG_DISABLED"
  | "SNAPSHOT_CORRUPT"
  | "RESTORE_IN_PROGRESS"
  | "SECRETS_UNSEAL_FAILED"
  | "WEAK_PASSPHRASE"

export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message)
    this.name = "BackupError"
  }
}

export function isBackupEnabled(): boolean {
  return isFeatureEnabled("phase-171")
}

export function backupRollbackNote(): string {
  return "Rollback phase-171: unset NEXT_PUBLIC_FEATURE_PHASE_171 / FEATURE_PHASE_171 or set to 0/false and restart. Snapshots on disk are inert; no migration to revert."
}

function assertEnabled(): void {
  if (!isBackupEnabled()) throw new BackupError("FLAG_DISABLED", "Backup snapshots disabled (phase-171 flag off)")
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function writeAtomic(target: string, bytes: Buffer | string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, bytes)
  await rename(tmp, target)
}

/** Holds every lock in sorted order, then runs `task` inside all of them. */
function withAllLocks<T>(paths: string[], task: () => Promise<T>): Promise<T> {
  const [head, ...rest] = [...paths].sort()
  if (!head) return task()
  return withFileLock(head, () => withAllLocks(rest, task))
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>
  const out: Record<string, number> = {}
  for (const { name } of names) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }
    out[name] = Number(row.n)
  }
  return out
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** Captures all sidecars and the SQLite database at one logical instant. */
export async function createSnapshot(outDir: string, now: () => Date = () => new Date()): Promise<SnapshotManifest> {
  assertEnabled()
  const sidecars = serverDataFileKeys().filter((key) => key !== "sqliteDb")
  const lockPaths = sidecars.map((key) => serverDataJsonPath(key))
  await mkdir(outDir, { recursive: true })

  const manifest = await withAllLocks(lockPaths, async () => {
    const files: SnapshotFileEntry[] = []
    for (const key of sidecars) {
      const source = serverDataJsonPath(key)
      if (!(await exists(source))) continue
      const bytes = await readFile(source)
      JSON.parse(bytes.toString("utf8")) // a torn or corrupt sidecar must fail the snapshot, not ship
      const name = serverDataFileName(key)
      await writeAtomic(path.join(outDir, name), bytes)
      files.push({ name, bytes: bytes.length, sha256: sha256(bytes) })
    }

    const sqliteName = serverDataFileName("sqliteDb")
    const target = path.join(outDir, sqliteName)
    await rm(target, { force: true })
    const db = getDb()
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    const sqliteBytes = await readFile(target)
    const sqlite = {
      name: sqliteName,
      bytes: sqliteBytes.length,
      sha256: sha256(sqliteBytes),
      tables: tableCounts(db),
    }
    return { version: 1 as const, createdAt: now().toISOString(), files, sqlite }
  })

  await writeAtomic(path.join(outDir, SNAPSHOT_MANIFEST_NAME), JSON.stringify(manifest, null, 2))
  incSecurityCounter("backup_snapshot_created")
  return manifest
}

export type SnapshotVerification = { ok: boolean; problems: string[]; manifest: SnapshotManifest | null }

export async function verifySnapshot(dir: string): Promise<SnapshotVerification> {
  assertEnabled()
  const problems: string[] = []
  let manifest: SnapshotManifest | null = null
  try {
    manifest = JSON.parse(await readFile(path.join(dir, SNAPSHOT_MANIFEST_NAME), "utf8")) as SnapshotManifest
    if (manifest.version !== 1) problems.push(`unsupported manifest version ${String(manifest.version)}`)
  } catch {
    problems.push("manifest missing or unreadable")
    incSecurityCounter("backup_snapshot_corrupt")
    return { ok: false, problems, manifest: null }
  }

  const entries = manifest.sqlite ? [...manifest.files, manifest.sqlite] : manifest.files
  for (const entry of entries) {
    let bytes: Buffer
    try {
      bytes = await readFile(path.join(dir, entry.name))
    } catch {
      problems.push(`${entry.name}: missing`)
      continue
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      problems.push(`${entry.name}: checksum mismatch`)
      continue
    }
    if (entry.name.endsWith(".json")) {
      try {
        JSON.parse(bytes.toString("utf8"))
      } catch {
        problems.push(`${entry.name}: invalid JSON`)
      }
    }
  }

  if (manifest.sqlite && !problems.some((p) => p.startsWith(manifest!.sqlite!.name))) {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path.join(dir, manifest.sqlite.name), { readOnly: true })
      const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") problems.push("sqlite: integrity_check failed")
      const dangling = db.prepare("PRAGMA foreign_key_check").all()
      if (dangling.length > 0) problems.push(`sqlite: ${dangling.length} dangling foreign key row(s)`)
      const counts = tableCounts(db)
      for (const [table, expected] of Object.entries(manifest.sqlite.tables)) {
        if (counts[table] !== expected) problems.push(`sqlite: table ${table} has ${counts[table] ?? "no"} rows, expected ${expected}`)
      }
    } catch (error) {
      problems.push(`sqlite: unreadable (${error instanceof Error ? error.message : "unknown"})`)
    } finally {
      db?.close()
    }
  }

  incSecurityCounter(problems.length === 0 ? "backup_snapshot_verified" : "backup_snapshot_corrupt")
  return { ok: problems.length === 0, problems, manifest }
}

/** True while a restore holds the marker in `root`; stale markers are ignored. */
export async function isRestoreInProgress(root: string = serverDataRoot(), now: number = Date.now()): Promise<boolean> {
  if (!isBackupEnabled()) return false
  try {
    const info = await stat(path.join(root, RESTORE_MARKER_NAME))
    return now - info.mtimeMs < RESTORE_MARKER_TTL_MS
  } catch {
    return false
  }
}

/**
 * Restores a verified snapshot into `targetDir` (default: the live data root).
 * The caller must have closed any open SQLite connection on the target first —
 * restore replaces the file underneath it.
 */
export async function restoreSnapshot(dir: string, targetDir: string = serverDataRoot()): Promise<SnapshotManifest> {
  assertEnabled()
  const verification = await verifySnapshot(dir)
  if (!verification.ok || !verification.manifest) {
    throw new BackupError("SNAPSHOT_CORRUPT", "Refusing to restore an unverified snapshot", verification.problems)
  }
  if (await isRestoreInProgress(targetDir)) {
    incSecurityCounter("backup_restore_blocked")
    throw new BackupError("RESTORE_IN_PROGRESS", "Another restore holds the marker for this data root")
  }

  const manifest = verification.manifest
  await mkdir(targetDir, { recursive: true })
  const marker = path.join(targetDir, RESTORE_MARKER_NAME)
  await writeFile(marker, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }))
  try {
    for (const entry of manifest.files) {
      await writeAtomic(path.join(targetDir, entry.name), await readFile(path.join(dir, entry.name)))
    }
    if (manifest.sqlite) {
      const target = path.join(targetDir, manifest.sqlite.name)
      // A stale WAL/SHM pair would be replayed over the restored image.
      await rm(`${target}-wal`, { force: true })
      await rm(`${target}-shm`, { force: true })
      await writeAtomic(target, await readFile(path.join(dir, manifest.sqlite.name)))
    }
  } finally {
    await rm(marker, { force: true })
  }
  incSecurityCounter("backup_restore_completed")
  return manifest
}

// ── Sealed secrets envelope ────────────────────────────────────────────────

/** Secret env names covered by the secrets map; values are never logged. */
export const BACKUP_SECRET_ENV_NAMES = [
  "ADMIN_SECRET_KEY",
  "FAUCET_DISTRIBUTOR_SECRET_KEY",
  "CLASSIC_LIQ_ISSUER_SECRET",
  "PINATA_JWT",
  "PINATA_API_JWT",
  "NANOBANANA_API_KEY",
  "NANOBANANA_WEBHOOK_SECRET",
  "CRON_SECRET",
  "PHASE_ADMIN_KEY",
  "SEP10_SERVER_SECRET",
] as const

export type SealedSecrets = {
  v: 1
  kdf: "scrypt"
  names: string[]
  salt: string
  iv: string
  tag: string
  ct: string
}

const MIN_PASSPHRASE = 16

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new BackupError("WEAK_PASSPHRASE", `Backup passphrase must be at least ${MIN_PASSPHRASE} characters`)
  }
  return scryptSync(passphrase, salt, 32)
}

export function collectSecretsMap(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of BACKUP_SECRET_ENV_NAMES) {
    const value = env[name]?.trim()
    if (value) out[name] = value
  }
  return out
}

export function sealSecrets(secrets: Record<string, string>, passphrase: string): SealedSecrets {
  assertEnabled()
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()])
  return {
    v: 1,
    kdf: "scrypt",
    names: Object.keys(secrets).sort(),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  }
}

export function openSecrets(sealed: SealedSecrets, passphrase: string): Record<string, string> {
  assertEnabled()
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(passphrase, Buffer.from(sealed.salt, "base64")),
      Buffer.from(sealed.iv, "base64"),
    )
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"))
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()])
    return JSON.parse(plain.toString("utf8")) as Record<string, string>
  } catch (error) {
    if (error instanceof BackupError) throw error
    // Wrong passphrase and tampering are indistinguishable by design.
    throw new BackupError("SECRETS_UNSEAL_FAILED", "Sealed secrets could not be opened")
  }
}

/** Names only: which secrets differ between a restored map and the live env. */
export function diffSecretsMap(
  restored: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): { changed: string[]; missingInEnv: string[]; missingInBackup: string[] } {
  const live = collectSecretsMap(env)
  return {
    changed: Object.keys(restored).filter((name) => name in live && live[name] !== restored[name]).sort(),
    missingInEnv: Object.keys(restored).filter((name) => !(name in live)).sort(),
    missingInBackup: Object.keys(live).filter((name) => !(name in restored)).sort(),
  }
}
