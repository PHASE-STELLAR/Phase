/**
 * Off-chain metadata delta storage — phase-122
 *
 * Large metadata inflates contract storage rent. This module keeps the full
 * metadata off-chain (JSON sidecar) and stores only a content hash + delta
 * pointer on-chain. The on-chain size is reduced to 32 bytes (hash) + 8 bytes
 * (version) + URI stub, while the full JSON lives in PHASE_SERVER_DATA_DIR
 * or IPFS.
 *
 * Feature flag: phase-122 (NEXT_PUBLIC_FEATURE_PHASE_122 / FEATURE_PHASE_122)
 * Rollback: disable flag → verify route falls back to on-chain token_uri only.
 *           Off-chain files remain on disk; no ledger change to revert.
 */

import { createHash } from "node:crypto"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const OffchainDeltaManifestSchema = z.object({
  version: z.literal(1),
  tokenId: z.number().int().min(1),
  contractId: z.string().min(56).max(56),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/, "expected sha256 hex"),
  deltaRefs: z.array(z.string().max(256)).default([]),
  storedAt: z.string().datetime(),
  byteSize: z.number().int().min(0),
  onChainStub: z.string().max(256),
})

export type OffchainDeltaManifest = z.infer<typeof OffchainDeltaManifestSchema>

export type DeltaStoreResult =
  | { ok: true; manifest: OffchainDeltaManifest; hash: string }
  | { ok: false; error: string; code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "STORE_FAILED" }

export type DeltaFetchResult =
  | { ok: true; data: unknown; manifest: OffchainDeltaManifest }
  | { ok: false; error: string; code: "FLAG_DISABLED" | "NOT_FOUND" | "HASH_MISMATCH" | "VALIDATION_FAILED" }

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))
}

export function computeDeltaHash(payload: unknown): string {
  return sha256Hex(stableStringify(payload))
}

export function buildOnChainStub(tokenId: number, contentHash: string): string {
  // On-chain footprint: "delta:{tokenId}:{hash8}" ~ 20 chars instead of full JSON
  return `delta:${tokenId}:${contentHash.slice(0, 8)}`
}

export function parseOnChainStub(stub: string): { tokenId: number; hashPrefix: string } | null {
  const m = stub.match(/^delta:(\d+):([a-f0-9]{8})$/)
  if (!m) return null
  const tokenId = parseInt(m[1]!, 10)
  if (!Number.isFinite(tokenId) || tokenId <= 0) return null
  return { tokenId, hashPrefix: m[2]! }
}

// In-memory + optional file persistence (lazy import to avoid bundling fs in client)
const memoryStore = new Map<string, { manifest: OffchainDeltaManifest; payload: unknown }>()

function deltaKey(contractId: string, tokenId: number): string {
  return `${contractId}:${tokenId}`
}

function ensureFlagOrFail(): DeltaStoreResult | null {
  if (!isFeatureEnabled("phase-122")) {
    return { ok: false, error: "Off-chain delta storage is disabled (phase-122 flag off).", code: "FLAG_DISABLED" }
  }
  return null
}

export async function storeOffchainDelta(
  contractId: string,
  tokenId: number,
  payload: unknown,
  opts: { deltaRefs?: string[] } = {},
): Promise<DeltaStoreResult> {
  const flagFail = ensureFlagOrFail()
  if (flagFail) return flagFail

  if (!contractId || contractId.length !== 56 || !contractId.startsWith("C")) {
    return { ok: false, error: "Invalid contractId (expected C… 56 chars)", code: "VALIDATION_FAILED" }
  }
  if (!Number.isFinite(tokenId) || tokenId <= 0) {
    return { ok: false, error: "Invalid tokenId", code: "VALIDATION_FAILED" }
  }

  const raw = stableStringify(payload)
  const byteSize = Buffer.byteLength(raw, "utf8")
  // Guard large payloads inflating memory; cap 256KB for delta
  if (byteSize > 256 * 1024) {
    return { ok: false, error: `Payload too large: ${byteSize} bytes (max 256KB)`, code: "VALIDATION_FAILED" }
  }

  const hash = sha256Hex(raw)
  const manifest: OffchainDeltaManifest = {
    version: 1,
    tokenId,
    contractId,
    contentHash: hash,
    deltaRefs: opts.deltaRefs ?? [],
    storedAt: new Date().toISOString(),
    byteSize,
    onChainStub: buildOnChainStub(tokenId, hash),
  }

  const parsed = OffchainDeltaManifestSchema.safeParse(manifest)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, code: "VALIDATION_FAILED" }
  }

  const key = deltaKey(contractId, tokenId)
  memoryStore.set(key, { manifest: parsed.data, payload })

  // Best-effort file persistence (server only)
  if (typeof process !== "undefined" && typeof require !== "undefined") {
    try {
      const { serverDataJsonPath } = await import("@/lib/server-data-paths")
      const { default: fs } = await import("node:fs/promises")
      const { default: path } = await import("node:path")
      const dir = serverDataJsonPath("nftListings").replace(/nft-listings\.json$/, "offchain-deltas")
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${contractId}_${tokenId}.json`)
      await fs.writeFile(file, JSON.stringify({ manifest: parsed.data, payload }, null, 2), "utf8")
    } catch {
      // memory-only is acceptable (e.g., Vercel tmp)
    }
  }

  return { ok: true, manifest: parsed.data, hash }
}

export async function fetchOffchainDelta(
  contractId: string,
  tokenId: number,
  opts: { expectedHash?: string } = {},
): Promise<DeltaFetchResult> {
  if (!isFeatureEnabled("phase-122")) {
    return { ok: false, error: "Off-chain delta storage is disabled (phase-122 flag off).", code: "FLAG_DISABLED" }
  }

  const key = deltaKey(contractId, tokenId)
  const mem = memoryStore.get(key)
  if (mem) {
    if (opts.expectedHash && mem.manifest.contentHash !== opts.expectedHash) {
      return { ok: false, error: `Hash mismatch: expected ${opts.expectedHash.slice(0, 8)}… got ${mem.manifest.contentHash.slice(0, 8)}…`, code: "HASH_MISMATCH" }
    }
    return { ok: true, data: mem.payload, manifest: mem.manifest }
  }

  // Try file fallback
  try {
    const { serverDataJsonPath } = await import("@/lib/server-data-paths")
    const { default: fs } = await import("node:fs/promises")
    const { default: path } = await import("node:path")
    const dir = serverDataJsonPath("nftListings").replace(/nft-listings\.json$/, "offchain-deltas")
    const file = path.join(dir, `${contractId}_${tokenId}.json`)
    const raw = await fs.readFile(file, "utf8")
    const parsed = JSON.parse(raw) as { manifest: unknown; payload: unknown }
    const man = OffchainDeltaManifestSchema.safeParse(parsed.manifest)
    if (!man.success) return { ok: false, error: man.error.message, code: "VALIDATION_FAILED" }
    const payload = parsed.payload
    // Verify hash
    const computed = sha256Hex(stableStringify(payload))
    if (computed !== man.data.contentHash) {
      return { ok: false, error: "Stored payload hash does not match manifest", code: "HASH_MISMATCH" }
    }
    if (opts.expectedHash && man.data.contentHash !== opts.expectedHash) {
      return { ok: false, error: `Hash mismatch`, code: "HASH_MISMATCH" }
    }
    memoryStore.set(key, { manifest: man.data, payload })
    return { ok: true, data: payload, manifest: man.data }
  } catch {
    return { ok: false, error: `No off-chain delta for token ${tokenId} on ${contractId.slice(0, 8)}…`, code: "NOT_FOUND" }
  }
}

export function isDeltaEnabled(): boolean {
  return isFeatureEnabled("phase-122")
}

export function deltaStorageStats(): { entries: number; totalBytes: number } {
  let totalBytes = 0
  for (const { manifest } of memoryStore.values()) totalBytes += manifest.byteSize
  return { entries: memoryStore.size, totalBytes }
}

export function clearDeltaMemoryStore(): void {
  memoryStore.clear()
}

// Validation schemas for API payloads
export const StoreDeltaRequestSchema = z.object({
  tokenId: z.number().int().min(1).max(1_000_000),
  contractId: z.string().length(56).regex(/^C[A-Z2-7]{55}$/, "Invalid contract strkey"),
  payload: z.unknown(),
  deltaRefs: z.array(z.string().max(256)).optional(),
})

export const FetchDeltaQuerySchema = z.object({
  tokenId: z.coerce.number().int().min(1),
  c: z.string().length(56).regex(/^C[A-Z2-7]{55}$/).optional(),
})
