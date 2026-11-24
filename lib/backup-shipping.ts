/**
 * Backup and Disaster Recovery: Off-Box Shipping & Remote Storage — Issue #654
 *
 * Feature flag: phase-227 (NEXT_PUBLIC_FEATURE_PHASE_227 / FEATURE_PHASE_227)
 * Rollback: unset flag → off-box operations throw FLAG_DISABLED; local backups remain.
 *
 * Extends the existing local snapshot implementation with:
 *  - Remote object storage abstraction (S3-compatible, Cloudflare R2, MinIO, or isolated remote dir)
 *  - AES-256-GCM encryption before shipping (reusing sealed secrets envelope)
 *  - Remote verification after upload
 *  - Retention policy with safe pruning (never deletes the last known-good backup)
 *  - Failure alerting via webhook alerts
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
} from "node:crypto"
import { mkdir, readFile, writeFile, unlink, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"
import { sendWebhookAlert } from "@/lib/webhook-alerts"
import {
  BackupError,
  type SnapshotManifest,
  SNAPSHOT_MANIFEST_NAME,
  createSnapshot,
  verifySnapshot,
  isBackupEnabled,
} from "@/lib/backup-snapshot"
import { serverDataRoot } from "@/lib/server-data-paths"
import { readJsonFile, updateStore } from "@/lib/json-store"

export function isPhase227Enabled(): boolean {
  return isFeatureEnabled("phase-227")
}

export function phase227RollbackNote(): string {
  return flagRollbackNote("phase-227")
}

function assertPhase227(): void {
  if (!isPhase227Enabled()) {
    throw new BackupError(
      "FLAG_DISABLED",
      `Off-box backup shipping disabled (phase-227 flag off). ${phase227RollbackNote()}`,
    )
  }
}

// ─── Remote Object Storage Abstraction ───────────────────────────────────────

export interface RemoteObjectSummary {
  key: string
  size: number
  lastModified: Date
  etag?: string
}

export interface RemoteObjectStorage {
  putObject(
    key: string,
    data: Buffer,
    contentType?: string,
  ): Promise<{ ok: boolean; key: string; bytes: number; etag?: string }>
  getObject(key: string): Promise<Buffer | null>
  listObjects(prefix?: string): Promise<RemoteObjectSummary[]>
  deleteObject(key: string): Promise<boolean>
}

/**
 * File-backed remote storage implementation (useful for local staging, testing,
 * or mounted network volumes).
 */
export class FileSystemRemoteStorage implements RemoteObjectStorage {
  constructor(private readonly baseDir: string) {}

  private fullPath(key: string): string {
    const safeKey = key.replace(/\.\./g, "").replace(/^\/+/, "")
    return path.join(this.baseDir, safeKey)
  }

  async putObject(
    key: string,
    data: Buffer,
    _contentType = "application/octet-stream",
  ): Promise<{ ok: boolean; key: string; bytes: number; etag: string }> {
    const target = this.fullPath(key)
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, data)
    const { rename } = await import("node:fs/promises")
    await rename(tmp, target)
    const etag = createHash("md5").update(data).digest("hex")
    return { ok: true, key, bytes: data.length, etag }
  }

  async getObject(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.fullPath(key))
    } catch {
      return null
    }
  }

  async listObjects(prefix = ""): Promise<RemoteObjectSummary[]> {
    const results: RemoteObjectSummary[] = []
    const walk = async (dir: string, currentPrefix: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const entryRel = currentPrefix ? `${currentPrefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            await walk(path.join(dir, entry.name), entryRel)
          } else if (entry.isFile()) {
            if (!prefix || entryRel.startsWith(prefix)) {
              const st = await stat(path.join(dir, entry.name))
              results.push({
                key: entryRel,
                size: st.size,
                lastModified: st.mtime,
              })
            }
          }
        }
      } catch {}
    }
    await walk(this.baseDir, "")
    return results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
  }

  async deleteObject(key: string): Promise<boolean> {
    try {
      await unlink(this.fullPath(key))
      return true
    } catch {
      return false
    }
  }
}

/**
 * S3-compatible remote object storage client using standard node:crypto SigV4.
 * Works seamlessly with AWS S3, Cloudflare R2, MinIO, or Google Cloud Storage XML API.
 */
export class S3RemoteStorage implements RemoteObjectStorage {
  private readonly bucket: string
  private readonly endpoint: string
  private readonly region: string
  private readonly accessKeyId: string
  private readonly secretAccessKey: string

  constructor(opts: {
    bucket: string
    endpoint?: string
    region?: string
    accessKeyId?: string
    secretAccessKey?: string
  }) {
    this.bucket = opts.bucket
    this.endpoint = (opts.endpoint || process.env.BACKUP_S3_ENDPOINT || "https://s3.amazonaws.com").replace(/\/+$/, "")
    this.region = opts.region || process.env.BACKUP_S3_REGION || "us-east-1"
    this.accessKeyId = opts.accessKeyId || process.env.AWS_ACCESS_KEY_ID || process.env.BACKUP_S3_ACCESS_KEY || ""
    this.secretAccessKey = opts.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || process.env.BACKUP_S3_SECRET_KEY || ""
  }

  private sign(method: string, canonicalUri: string, headers: Record<string, string>, payloadSha256: string): string {
    const dateStr = headers["x-amz-date"]!
    const dateOnly = dateStr.slice(0, 8)
    const sortedHeaders = Object.keys(headers).sort()
    const canonicalHeaders = sortedHeaders.map((k) => `${k.toLowerCase()}:${headers[k]!.trim()}\n`).join("")
    const signedHeaders = sortedHeaders.map((k) => k.toLowerCase()).join(";")

    const canonicalRequest = [
      method,
      canonicalUri,
      "", // query
      canonicalHeaders,
      signedHeaders,
      payloadSha256,
    ].join("\n")

    const scope = `${dateOnly}/${this.region}/s3/aws4_request`
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      dateStr,
      scope,
      createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
    ].join("\n")

    const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest()
    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateOnly)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, "s3")
    const kSigning = hmac(kService, "aws4_request")
    const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex")

    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }

  private buildUrl(key: string): string {
    const cleanKey = key.replace(/^\/+/, "")
    if (this.endpoint.includes("s3.amazonaws.com") && !this.endpoint.includes(`${this.bucket}.`)) {
      return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${cleanKey}`
    }
    return `${this.endpoint}/${this.bucket}/${cleanKey}`
  }

  async putObject(
    key: string,
    data: Buffer,
    contentType = "application/octet-stream",
  ): Promise<{ ok: boolean; key: string; bytes: number; etag?: string }> {
    const cleanKey = key.replace(/^\/+/, "")
    const url = this.buildUrl(cleanKey)
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
    const payloadHash = createHash("sha256").update(data).digest("hex")

    const headers: Record<string, string> = {
      host: new URL(url).host,
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    }
    const parsedUrl = new URL(url)
    headers["authorization"] = this.sign("PUT", parsedUrl.pathname, headers, payloadHash)

    const res = await fetch(url, { method: "PUT", headers, body: data })
    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      throw new Error(`S3 PUT ${key} failed (${res.status}): ${errText.slice(0, 160)}`)
    }
    const etag = res.headers.get("etag")?.replace(/"/g, "") || undefined
    return { ok: true, key: cleanKey, bytes: data.length, etag }
  }

  async getObject(key: string): Promise<Buffer | null> {
    const cleanKey = key.replace(/^\/+/, "")
    const url = this.buildUrl(cleanKey)
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
    const payloadHash = createHash("sha256").update("").digest("hex")

    const headers: Record<string, string> = {
      host: new URL(url).host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    }
    const parsedUrl = new URL(url)
    headers["authorization"] = this.sign("GET", parsedUrl.pathname, headers, payloadHash)

    const res = await fetch(url, { method: "GET", headers })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(`S3 GET ${key} failed (${res.status})`)
    }
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  }

  async listObjects(prefix = ""): Promise<RemoteObjectSummary[]> {
    // Basic listing via bucket GET with prefix
    const url = `${this.buildUrl("")}?list-type=2&prefix=${encodeURIComponent(prefix)}`
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
    const payloadHash = createHash("sha256").update("").digest("hex")

    const headers: Record<string, string> = {
      host: new URL(url).host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    }
    const parsedUrl = new URL(url)
    headers["authorization"] = this.sign("GET", parsedUrl.pathname, headers, payloadHash)

    const res = await fetch(url, { method: "GET", headers })
    if (!res.ok) return []
    const xml = await res.text()

    const results: RemoteObjectSummary[] = []
    const keyMatches = [...xml.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<LastModified>([^<]+)<\/LastModified>/g)]
    for (const match of keyMatches) {
      results.push({
        key: match[1]!,
        size: Number(match[2]!),
        lastModified: new Date(match[3]!),
      })
    }
    return results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
  }

  async deleteObject(key: string): Promise<boolean> {
    const cleanKey = key.replace(/^\/+/, "")
    const url = this.buildUrl(cleanKey)
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
    const payloadHash = createHash("sha256").update("").digest("hex")

    const headers: Record<string, string> = {
      host: new URL(url).host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    }
    const parsedUrl = new URL(url)
    headers["authorization"] = this.sign("DELETE", parsedUrl.pathname, headers, payloadHash)

    const res = await fetch(url, { method: "DELETE", headers })
    return res.ok || res.status === 404
  }
}

/**
 * Resolves the configured remote object storage provider.
 */
export function resolveRemoteStorage(): RemoteObjectStorage {
  const bucket = process.env.BACKUP_S3_BUCKET?.trim()
  if (bucket) {
    return new S3RemoteStorage({ bucket })
  }
  // Default fallback: isolated off-box directory under serverDataRoot or custom dir
  const fallbackDir =
    process.env.PHASE_REMOTE_BACKUP_DIR?.trim() ||
    path.join(serverDataRoot(), "remote-backups-storage")
  return new FileSystemRemoteStorage(fallbackDir)
}

// ─── Snapshot Encryption & Packaging ─────────────────────────────────────────

export type EncryptedSnapshotBundle = {
  v: 1
  id: string
  createdAt: string
  manifestSha256: string
  salt: string
  iv: string
  tag: string
  ct: string // Base64 ciphertext containing JSON { manifest, files: Record<filename, base64> }
}

const MIN_PASSPHRASE_LENGTH = 16

function deriveEncryptionKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupError(
      "WEAK_PASSPHRASE",
      `Backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
    )
  }
  return scryptSync(passphrase, salt, 32)
}

export function resolveBackupPassphrase(explicit?: string): string {
  const p =
    explicit?.trim() ||
    process.env.BACKUP_ENCRYPTION_PASSPHRASE?.trim() ||
    process.env.ADMIN_SECRET_KEY?.trim() ||
    process.env.SEP10_SERVER_SECRET?.trim() ||
    ""
  if (!p || p.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupError(
      "WEAK_PASSPHRASE",
      `Backup encryption requires a strong passphrase (at least ${MIN_PASSPHRASE_LENGTH} chars). Set BACKUP_ENCRYPTION_PASSPHRASE.`,
    )
  }
  return p
}

/**
 * Bundles and encrypts a verified local snapshot directory into an authenticated AES-256-GCM package.
 */
export async function sealSnapshotDirectory(
  snapshotDir: string,
  passphrase: string,
): Promise<{ bundle: EncryptedSnapshotBundle; manifest: SnapshotManifest; bundleBuffer: Buffer }> {
  const verification = await verifySnapshot(snapshotDir)
  if (!verification.ok || !verification.manifest) {
    throw new BackupError(
      "SNAPSHOT_CORRUPT",
      "Cannot seal corrupted snapshot",
      verification.problems,
    )
  }

  const manifest = verification.manifest
  const filesPayload: Record<string, string> = {}

  const allEntries = manifest.sqlite ? [...manifest.files, manifest.sqlite] : manifest.files
  for (const entry of allEntries) {
    const raw = await readFile(path.join(snapshotDir, entry.name))
    filesPayload[entry.name] = raw.toString("base64")
  }

  const plainPackage = JSON.stringify({
    manifest,
    files: filesPayload,
  })

  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveEncryptionKey(passphrase, salt)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(plainPackage, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()

  const manifestSha = createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
  const id = `snap_${manifest.createdAt.replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z")}_${manifestSha.slice(0, 8)}`

  const bundle: EncryptedSnapshotBundle = {
    v: 1,
    id,
    createdAt: manifest.createdAt,
    manifestSha256: manifestSha,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  }

  const bundleBuffer = Buffer.from(JSON.stringify(bundle, null, 2), "utf8")
  return { bundle, manifest, bundleBuffer }
}

/**
 * Decrypts an encrypted snapshot bundle and writes the verified contents into targetDir.
 */
export async function unsealSnapshotBundle(
  bundleBuffer: Buffer,
  passphrase: string,
  targetDir: string,
): Promise<SnapshotManifest> {
  let bundle: EncryptedSnapshotBundle
  try {
    bundle = JSON.parse(bundleBuffer.toString("utf8")) as EncryptedSnapshotBundle
    if (bundle.v !== 1 || !bundle.salt || !bundle.iv || !bundle.tag || !bundle.ct) {
      throw new Error("Invalid bundle structure")
    }
  } catch (e) {
    throw new BackupError("SNAPSHOT_CORRUPT", "Unreadable encrypted bundle", [String(e)])
  }

  let plainPackageStr: string
  try {
    const key = deriveEncryptionKey(passphrase, Buffer.from(bundle.salt, "base64"))
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(bundle.iv, "base64"))
    decipher.setAuthTag(Buffer.from(bundle.tag, "base64"))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(bundle.ct, "base64")),
      decipher.final(),
    ])
    plainPackageStr = plain.toString("utf8")
  } catch {
    throw new BackupError(
      "SECRETS_UNSEAL_FAILED",
      "Decryption failed: incorrect passphrase or corrupted/tampered bundle",
    )
  }

  let parsed: { manifest: SnapshotManifest; files: Record<string, string> }
  try {
    parsed = JSON.parse(plainPackageStr) as typeof parsed
  } catch {
    throw new BackupError("SNAPSHOT_CORRUPT", "Decrypted payload is not valid JSON")
  }

  await mkdir(targetDir, { recursive: true })

  // Write files
  for (const [name, b64] of Object.entries(parsed.files)) {
    const filePath = path.join(targetDir, name)
    await writeFile(filePath, Buffer.from(b64, "base64"))
  }

  // Write manifest
  await writeFile(
    path.join(targetDir, SNAPSHOT_MANIFEST_NAME),
    JSON.stringify(parsed.manifest, null, 2),
  )

  // Verify unpacked contents
  const verification = await verifySnapshot(targetDir)
  if (!verification.ok) {
    throw new BackupError(
      "SNAPSHOT_CORRUPT",
      "Unsealed snapshot failed verification check",
      verification.problems,
    )
  }

  return parsed.manifest
}

// ─── Off-Box Shipping & Inventory ───────────────────────────────────────────

export type OffBoxShippingResult = {
  ok: boolean
  id: string
  remoteKey: string
  bytesShipped: number
  sha256: string
  createdAt: string
  verified: boolean
  error?: string
}

export type BackupCatalogEntry = {
  id: string
  remoteKey: string
  createdAt: string
  bytes: number
  sha256: string
  manifestSha256: string
  verifiedAt: number
}

export type BackupCatalog = {
  lastBackupAt: number | null
  lastVerifiedAt: number | null
  backups: BackupCatalogEntry[]
}

const CATALOG_KEY = "backupCatalog"

export async function readBackupCatalog(): Promise<BackupCatalog> {
  const { serverDataJsonPath } = await import("@/lib/server-data-paths")
  return readJsonFile<BackupCatalog>(serverDataJsonPath("backupInventory" as any), {
    lastBackupAt: null,
    lastVerifiedAt: null,
    backups: [],
  }).catch(() => ({
    lastBackupAt: null,
    lastVerifiedAt: null,
    backups: [],
  }))
}

export async function saveCatalogEntry(entry: BackupCatalogEntry): Promise<void> {
  await updateStore<BackupCatalog>("backupInventory" as any, (catalog) => {
    const list = Array.isArray(catalog.backups) ? catalog.backups : []
    const filtered = list.filter((b) => b.id !== entry.id)
    catalog.backups = [entry, ...filtered]
    catalog.lastBackupAt = Date.now()
    catalog.lastVerifiedAt = entry.verifiedAt
    return catalog
  }).catch(() => {})
}

/**
 * Ships a local snapshot off-box: seals it with encryption, uploads to remote storage,
 * verifies remote integrity, and records the catalog entry.
 */
export async function shipSnapshotOffBox(
  snapshotDir: string,
  opts: {
    passphrase?: string
    storage?: RemoteObjectStorage
    tag?: string
  } = {},
): Promise<OffBoxShippingResult> {
  assertPhase227()

  const passphrase = resolveBackupPassphrase(opts.passphrase)
  const storage = opts.storage || resolveRemoteStorage()

  try {
    const { bundle, bundleBuffer } = await sealSnapshotDirectory(snapshotDir, passphrase)
    const remoteKey = `snapshots/${bundle.id}.enc.json`
    const bundleSha = createHash("sha256").update(bundleBuffer).digest("hex")

    // Upload with retry
    let uploadOk = false
    let lastError: string | null = null

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const putRes = await storage.putObject(remoteKey, bundleBuffer, "application/json")
        if (putRes.ok) {
          uploadOk = true
          break
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        const delay = attempt * 500
        await new Promise((r) => setTimeout(r, delay))
      }
    }

    if (!uploadOk) {
      incSecurityCounter("backup_offbox_failed")
      await sendWebhookAlert("critical", "Backup Off-Box Upload Failed", {
        snapshotId: bundle.id,
        remoteKey,
        error: lastError || "Failed after 3 attempts",
      }).catch(() => {})
      return {
        ok: false,
        id: bundle.id,
        remoteKey,
        bytesShipped: 0,
        sha256: bundleSha,
        createdAt: bundle.createdAt,
        verified: false,
        error: lastError || "Upload failed",
      }
    }

    // Verify remote object was received and has identical bytes
    const remoteBytes = await storage.getObject(remoteKey)
    if (!remoteBytes || remoteBytes.length !== bundleBuffer.length) {
      incSecurityCounter("backup_offbox_failed")
      await sendWebhookAlert("critical", "Backup Remote Verification Failed", {
        snapshotId: bundle.id,
        remoteKey,
        error: "Remote byte length mismatch",
      }).catch(() => {})
      return {
        ok: false,
        id: bundle.id,
        remoteKey,
        bytesShipped: bundleBuffer.length,
        sha256: bundleSha,
        createdAt: bundle.createdAt,
        verified: false,
        error: "Remote bytes verification failed",
      }
    }

    const remoteSha = createHash("sha256").update(remoteBytes).digest("hex")
    if (remoteSha !== bundleSha) {
      incSecurityCounter("backup_offbox_failed")
      await sendWebhookAlert("critical", "Backup Remote Digest Mismatch", {
        snapshotId: bundle.id,
        remoteKey,
        error: "Remote sha256 mismatch",
      }).catch(() => {})
      return {
        ok: false,
        id: bundle.id,
        remoteKey,
        bytesShipped: bundleBuffer.length,
        sha256: bundleSha,
        createdAt: bundle.createdAt,
        verified: false,
        error: "Remote sha256 mismatch",
      }
    }

    // Record into inventory
    await saveCatalogEntry({
      id: bundle.id,
      remoteKey,
      createdAt: bundle.createdAt,
      bytes: bundleBuffer.length,
      sha256: bundleSha,
      manifestSha256: bundle.manifestSha256,
      verifiedAt: Date.now(),
    })

    incSecurityCounter("backup_offbox_uploaded")
    return {
      ok: true,
      id: bundle.id,
      remoteKey,
      bytesShipped: bundleBuffer.length,
      sha256: bundleSha,
      createdAt: bundle.createdAt,
      verified: true,
    }
  } catch (error) {
    incSecurityCounter("backup_offbox_failed")
    const msg = error instanceof Error ? error.message : String(error)
    await sendWebhookAlert("critical", "Backup Shipping Error", {
      error: msg,
    }).catch(() => {})
    throw error
  }
}

// ─── Retention Policy ────────────────────────────────────────────────────────

export type BackupRetentionPolicy = {
  minBackupsToKeep: number
  maxAgeDays: number
}

export const DEFAULT_RETENTION_POLICY: BackupRetentionPolicy = {
  minBackupsToKeep: 3,
  maxAgeDays: 14,
}

/**
 * Applies retention policy to remote backups:
 *  - Sorts existing remote backups
 *  - Safely deletes expired backups
 *  - CRITICAL: Never deletes the last known-good backup before confirming that a newer valid backup exists.
 */
export async function applyBackupRetention(opts: {
  policy?: Partial<BackupRetentionPolicy>
  storage?: RemoteObjectStorage
  now?: number
} = {}): Promise<{ retained: string[]; deleted: string[] }> {
  assertPhase227()

  const policy: BackupRetentionPolicy = {
    ...DEFAULT_RETENTION_POLICY,
    ...opts.policy,
  }
  const storage = opts.storage || resolveRemoteStorage()
  const now = opts.now ?? Date.now()

  const allObjects = await storage.listObjects("snapshots/")
  const snapshotObjects = allObjects.filter((o) => o.key.endsWith(".enc.json"))

  // Sort descending (newest first)
  snapshotObjects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())

  // Safeguard: must keep at least `minBackupsToKeep` copies, and NEVER leave 0 backups!
  const effectiveMinKeep = Math.max(1, policy.minBackupsToKeep)
  const maxAgeMs = policy.maxAgeDays * 24 * 60 * 60 * 1000

  const retained: string[] = []
  const deleted: string[] = []

  for (let i = 0; i < snapshotObjects.length; i++) {
    const item = snapshotObjects[i]!
    const ageMs = now - item.lastModified.getTime()

    // Keep if within index limit or within age limit, or if it's the last remaining copy!
    if (i < effectiveMinKeep || ageMs < maxAgeMs || (snapshotObjects.length - deleted.length <= 1)) {
      retained.push(item.key)
    } else {
      // Confirm that newer verified backups exist before deleting
      const newerCount = retained.length
      if (newerCount < 1) {
        retained.push(item.key)
        continue
      }

      const ok = await storage.deleteObject(item.key).catch(() => false)
      if (ok) {
        deleted.push(item.key)
        incSecurityCounter("backup_retention_pruned")
      } else {
        retained.push(item.key)
      }
    }
  }

  return { retained, deleted }
}
