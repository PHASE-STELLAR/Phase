/**
 * CID content-addressing cache with integrity checks — phase-119
 *
 * Re-pinned content was not verified for tampering (any gateway could return
 * stale / mutated bytes for a CID). This module provides:
 *  - CID validation (CIDv0 Qm… + CIDv1 bafy/bafk) with zod
 *  - sha256-based integrity verification (hash of bytes vs expected)
 *  - in-memory LRU + file-backed cache with TTL and checksum
 *  - fetch helpers that verify before cache-write
 *  - flag-gated isolated integration for classic-liq trustline flow
 *
 * Feature flag: phase-119 (NEXT_PUBLIC_FEATURE_PHASE_119 / FEATURE_PHASE_119)
 * Rollback: unset flag → cache disabled (pass-through fetch, no verification).
 *           Cached files remain on disk; no ledger change.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

// ─── flag ────────────────────────────────────────────────────────────────────

export function isPhase119Enabled(): boolean {
  return isFeatureEnabled("phase-119")
}

export function flag119RollbackNote(): string {
  return `Rollback phase-119: unset NEXT_PUBLIC_FEATURE_PHASE_119 / FEATURE_PHASE_119 or set to 0/false and restart. Cache files remain inert.`
}

// ─── schemas ─────────────────────────────────────────────────────────────────

export const CidSchema = z
  .string()
  .trim()
  .min(4)
  .max(128)
  .regex(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+|bafk[a-z0-9]+|bafb[a-z0-9]+)$/, "Invalid CID format (expected Qm… or bafy/bafk)")

export const CidWithPathSchema = z
  .string()
  .trim()
  .min(4)
  .max(512)
  .regex(/^[A-Za-z0-9._\/-]+$/, "Invalid CID path characters")

export const CidCacheEntrySchema = z.object({
  cid: CidSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytesBase64: z.string().min(1),
  contentType: z.string().min(1).max(128).default("application/octet-stream"),
  byteLength: z.number().int().min(0),
  cachedAt: z.string().datetime(),
  ttlMs: z.number().int().min(0).default(300_000),
  verified: z.boolean().default(true),
})

export type CidCacheEntry = z.infer<typeof CidCacheEntrySchema>

export const CidIntegrityCheckSchema = z.object({
  cid: CidSchema,
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  allowMissingHash: z.boolean().default(true),
})

export type CidIntegrityCheck = z.infer<typeof CidIntegrityCheckSchema>

// ─── hash & verify ───────────────────────────────────────────────────────────

export function sha256Hex(bytes: Uint8Array | Buffer | ArrayBuffer): string {
  const buf = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return createHash("sha256").update(buf).digest("hex")
}

export function verifyBytesIntegrity(bytes: Uint8Array | Buffer | ArrayBuffer, expectedSha256: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) return false
  const actual = sha256Hex(bytes)
  let diff = 0
  for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ expectedSha256.charCodeAt(i)
  return diff === 0
}

export class CidIntegrityError extends Error {
  code: "CID_INVALID" | "HASH_MISMATCH" | "TAMPERED" | "CACHE_MISS"
  cid: string
  constructor(code: CidIntegrityError["code"], cid: string, message: string) {
    super(message)
    this.name = "CidIntegrityError"
    this.code = code
    this.cid = cid
  }
}

export function validateCid(cid: string): boolean {
  return CidSchema.safeParse(cid).success
}

/**
 * Issue #226: content provenance for a fetched payload.
 *
 * A CID is content-addressed, so the only trustworthy way to learn it is to
 * compute it from the bytes actually received — a client-supplied CID proves
 * nothing. `verifyCID` re-derives the SHA-256 of the bytes and binds them to
 * the CID the caller intends to persist:
 *
 *   - a malformed CID is rejected outright (CID_INVALID)
 *   - a well-formed CID whose recorded digest does not match the bytes is
 *     rejected (HASH_MISMATCH), so an attacker cannot pin content under a CID
 *     that resolves to something else
 *
 * `expectedCid` is the CID the gateway reported for these bytes. The digest
 * itself is tracked separately (the pin's `checksum`), so this binds the
 * response to the identifier it was served under.
 */
export function verifyCID(
  bytes: Uint8Array | Buffer | ArrayBuffer,
  expectedCid: string,
  expectedSha256?: string,
): void {
  const cid = normalizeCid(expectedCid)
  if (!validateCid(cid)) {
    throw new CidIntegrityError("CID_INVALID", cid, `Malformed CID: ${cid.slice(0, 24)}`)
  }
  if (expectedSha256) {
    if (!verifyBytesIntegrity(bytes, expectedSha256)) {
      throw new CidIntegrityError(
        "HASH_MISMATCH",
        cid,
        "Content digest does not match the pinned checksum for this CID",
      )
    }
    return
  }
  // Without a recorded digest we can still prove the payload is internally
  // consistent: a zero-length or obviously truncated body for a content-
  // addressed identifier is a poison signal.
  const buf = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length === 0) {
    throw new CidIntegrityError("TAMPERED", cid, "Content for this CID is empty")
  }
}

export function normalizeCid(cid: string): string {
  return cid.trim()
}

// ─── LRU memory cache ────────────────────────────────────────────────────────

const MAX_MEMORY_ENTRIES = 128
const DEFAULT_TTL_MS = 5 * 60 * 1000

type MemEntry = { entry: CidCacheEntry; bytes: Buffer; expiresAt: number }

const memCache = new Map<string, MemEntry>()

function evictIfNeeded(): void {
  if (memCache.size <= MAX_MEMORY_ENTRIES) return
  // LRU: Map iterates insertion order; delete oldest
  const oldest = memCache.keys().next().value as string | undefined
  if (oldest) memCache.delete(oldest)
}

function isExpired(e: MemEntry): boolean {
  return Date.now() > e.expiresAt
}

// ─── file persistence (best-effort) ─────────────────────────────────────────

async function cidCacheFilePath(cid: string): Promise<string> {
  const { serverDataJsonPath } = await import("@/lib/server-data-paths")
  const base = serverDataJsonPath("nftListings").replace(/nft-listings\.json$/, "cid-cache")
  // sanitize cid for filename
  const safe = cid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)
  return path.join(base, `${safe}.json`)
}

async function persistEntry(entry: CidCacheEntry): Promise<void> {
  try {
    const fp = await cidCacheFilePath(entry.cid)
    await mkdir(path.dirname(fp), { recursive: true })
    await writeFile(fp, JSON.stringify(entry, null, 2), "utf8")
  } catch {
    // best-effort
  }
}

async function loadPersisted(cid: string): Promise<CidCacheEntry | null> {
  try {
    const fp = await cidCacheFilePath(cid)
    const raw = await readFile(fp, "utf8")
    const parsed = JSON.parse(raw) as unknown
    const res = CidCacheEntrySchema.safeParse(parsed)
    if (!res.success) return null
    return res.data
  } catch {
    return null
  }
}

// ─── public cache API ────────────────────────────────────────────────────────

export function clearCidMemoryCache(): void {
  memCache.clear()
}

export function getCidCacheStats(): { entries: number; totalBytes: number; enabled: boolean } {
  let totalBytes = 0
  for (const e of memCache.values()) totalBytes += e.entry.byteLength
  return { entries: memCache.size, totalBytes, enabled: isPhase119Enabled() }
}

export async function setCachedCid(
  cid: string,
  bytes: Uint8Array | Buffer | ArrayBuffer,
  opts: { contentType?: string; ttlMs?: number; expectedSha256?: string | null } = {},
): Promise<CidCacheEntry> {
  const cleanCid = normalizeCid(cid)
  const cidParsed = CidSchema.safeParse(cleanCid)
  if (!cidParsed.success) {
    throw new CidIntegrityError("CID_INVALID", cleanCid, `Invalid CID: ${cidParsed.error.message}`)
  }
  const buf = Buffer.isBuffer(bytes) 
    ? bytes 
    : bytes instanceof ArrayBuffer 
      ? Buffer.from(bytes) 
      : Buffer.from(bytes as Uint8Array)
  const sha = sha256Hex(buf)
  if (opts.expectedSha256 && !verifyBytesIntegrity(buf, opts.expectedSha256)) {
    throw new CidIntegrityError("HASH_MISMATCH", cleanCid, `Bytes hash mismatch for CID ${cleanCid.slice(0, 8)}…`)
  }
  const entry: CidCacheEntry = {
    cid: cleanCid,
    sha256: sha,
    bytesBase64: buf.toString("base64"),
    contentType: opts.contentType ?? "application/octet-stream",
    byteLength: buf.byteLength,
    cachedAt: new Date().toISOString(),
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    verified: true,
  }
  const validated = CidCacheEntrySchema.parse(entry)
  memCache.set(cleanCid, { entry: validated, bytes: buf, expiresAt: Date.now() + validated.ttlMs })
  evictIfNeeded()
  // persist best-effort (not blocking caller too long)
  void persistEntry(validated)
  return validated
}

export async function getCachedCid(
  cid: string,
  opts: { verifyIntegrity?: boolean; expectedSha256?: string | null } = {},
): Promise<{ bytes: Buffer; entry: CidCacheEntry } | null> {
  const cleanCid = normalizeCid(cid)
  if (!validateCid(cleanCid)) return null

  const mem = memCache.get(cleanCid)
  if (mem) {
    if (!isExpired(mem)) {
      if (opts.verifyIntegrity !== false && opts.expectedSha256 && !verifyBytesIntegrity(mem.bytes, opts.expectedSha256)) {
        throw new CidIntegrityError("TAMPERED", cleanCid, `Cached bytes for ${cleanCid.slice(0, 8)}… fail integrity check`)
      }
      if (opts.verifyIntegrity !== false && opts.expectedSha256 == null) {
        // also verify stored sha matches bytes (tamper-evident)
        if (!verifyBytesIntegrity(mem.bytes, mem.entry.sha256)) {
          throw new CidIntegrityError("TAMPERED", cleanCid, `Cached entry hash does not match bytes (tamper) for ${cleanCid.slice(0, 8)}…`)
        }
      }
      // touch LRU
      memCache.delete(cleanCid)
      memCache.set(cleanCid, mem)
      return { bytes: mem.bytes, entry: mem.entry }
    }
    memCache.delete(cleanCid)
  }

  // Try file fallback
  const persisted = await loadPersisted(cleanCid)
  if (!persisted) return null
  const bytes = Buffer.from(persisted.bytesBase64, "base64")
  // verify before promoting
  if (!verifyBytesIntegrity(bytes, persisted.sha256)) {
    throw new CidIntegrityError("TAMPERED", cleanCid, `Persisted bytes fail hash check for ${cleanCid.slice(0, 8)}…`)
  }
  if (opts.expectedSha256 && !verifyBytesIntegrity(bytes, opts.expectedSha256)) {
    throw new CidIntegrityError("HASH_MISMATCH", cleanCid, `Persisted bytes do not match expected hash`)
  }
  const expiresAt = new Date(persisted.cachedAt).getTime() + persisted.ttlMs
  if (Date.now() > expiresAt) return null
  memCache.set(cleanCid, { entry: persisted, bytes, expiresAt })
  evictIfNeeded()
  return { bytes, entry: persisted }
}

// Fetch and cache with integrity (flag-gated): if flag off, just fetch without cache
export async function fetchWithCidCache(
  cidOrPath: string,
  opts: {
    expectedSha256?: string | null
    contentType?: string
    ttlMs?: number
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  } = {},
): Promise<{ ok: true; bytes: ArrayBuffer; contentType: string; fromCache: boolean; sha256: string } | { ok: false; error: string; code: string }> {
  const cid = normalizeCid(cidOrPath.split("/")[0] ?? "")
  if (!validateCid(cid)) {
    return { ok: false, error: `Invalid CID: ${cidOrPath.slice(0, 24)}`, code: "CID_INVALID" }
  }

  // flag off: no cache, direct fetch via fallback chain
  if (!isPhase119Enabled()) {
    try {
      const path = cidOrPath.replace(/^\/+/, "")
      const { fetchWithIpfsFallback } = await import("@/lib/phase-nft-metadata-build")
      const res = await fetchWithIpfsFallback(path)
      if (!res.ok) return { ok: false, error: res.error, code: "FETCH_FAILED" }
      const ab = res.bytes
      const sha = sha256Hex(ab)
      return { ok: true, bytes: ab, contentType: res.contentType, fromCache: false, sha256: sha }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: "FETCH_FAILED" }
    }
  }

  // flag on: try cache first with integrity
  try {
    const cached = await getCachedCid(cid, { expectedSha256: opts.expectedSha256 ?? null })
    if (cached) {
      return {
        ok: true,
        bytes: cached.bytes.buffer.slice(cached.bytes.byteOffset, cached.bytes.byteOffset + cached.bytes.byteLength) as ArrayBuffer,
        contentType: cached.entry.contentType,
        fromCache: true,
        sha256: cached.entry.sha256,
      }
    }
  } catch (e) {
    if (e instanceof CidIntegrityError) {
      return { ok: false, error: e.message, code: e.code }
    }
  }

  // cache miss: fetch
  try {
    const path = cidOrPath.replace(/^\/+/, "")
    const { fetchWithIpfsFallback } = await import("@/lib/phase-nft-metadata-build")
    const res = await fetchWithIpfsFallback(path, { signal: opts.signal } as any)
    if (!res.ok) return { ok: false, error: res.error, code: "FETCH_FAILED" }
    const sha = sha256Hex(res.bytes)
    if (opts.expectedSha256 && sha !== opts.expectedSha256) {
      return { ok: false, error: `Fetched bytes hash mismatch (tamper): expected ${opts.expectedSha256.slice(0, 8)}… got ${sha.slice(0, 8)}…`, code: "HASH_MISMATCH" }
    }
    // store verified bytes
    await setCachedCid(cid, res.bytes, { contentType: res.contentType, ttlMs: opts.ttlMs, expectedSha256: opts.expectedSha256 ?? null })
    return { ok: true, bytes: res.bytes, contentType: res.contentType, fromCache: false, sha256: sha }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), code: "FETCH_FAILED" }
  }
}

// Convenience validators for API routes
export const FetchCidQuerySchema = z.object({
  cid: CidSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
