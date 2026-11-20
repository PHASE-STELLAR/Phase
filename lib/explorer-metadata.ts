import { createHash } from "node:crypto"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const EXPLORER_METADATA_TTL_MS = 60_000
export const EXPLORER_METADATA_STALE_MAX_MS = 300_000
export const EXPLORER_ADAPTER_TIMEOUT_MS = 3_000

export const ExplorerMetadataSchema = z.object({
  collectionId: z.number().int().positive(),
  name: z.string().min(1).max(256),
  externalUrl: z.string().max(1024),
  verified: z.boolean(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  fetchedAt: z.number().int().nonnegative(),
})

export type ExplorerMetadataRecord = z.infer<typeof ExplorerMetadataSchema>

export type ExplorerMetadataStatus =
  | "disabled"
  | "verified"
  | "mismatch"
  | "unverified"
  | "stale"
  | "unavailable"

export type ExplorerMetadataResult = {
  status: ExplorerMetadataStatus
  showVerifiedBadge: boolean
  stale: boolean
  metadata: ExplorerMetadataRecord | null
  error?: string
}

export type ExplorerMetadataAdapter = (
  collectionId: number,
  signal: AbortSignal,
) => Promise<Omit<ExplorerMetadataRecord, "digest" | "fetchedAt"> & { digest?: string }>

type CacheEntry = {
  metadata: ExplorerMetadataRecord
  fetchedAt: number
}

const metadataCache = new Map<number, CacheEntry>()

export function clearExplorerMetadataCacheForTests(): void {
  metadataCache.clear()
}

export function computeExplorerMetadataDigest(input: {
  collectionId: number
  name: string
  externalUrl: string
}): string {
  const canonical = JSON.stringify({
    collectionId: input.collectionId,
    name: input.name,
    externalUrl: input.externalUrl,
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

async function defaultSorobanExplorerAdapter(
  collectionId: number,
  signal: AbortSignal,
): Promise<Omit<ExplorerMetadataRecord, "digest" | "fetchedAt">> {
  const rpcUrl = process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org"
  const contractId = process.env.PHASE_EXPLORER_METADATA_CONTRACT_ID?.trim()
  if (!contractId) {
    throw new Error("EXPLORER_CONTRACT_UNCONFIGURED")
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `explorer-meta-${collectionId}`,
      method: "getLedgerEntries",
      params: { keys: [] },
    }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`EXPLORER_RPC_HTTP_${response.status}`)
  }

  // Contract read stubbed to fail closed when no verified record is returned by RPC
  throw new Error("EXPLORER_METADATA_NOT_FOUND")
}

function evaluateMetadataMatch(
  metadata: ExplorerMetadataRecord,
  committedDigest?: string,
): ExplorerMetadataResult {
  if (committedDigest && metadata.digest !== committedDigest) {
    return {
      status: "mismatch",
      showVerifiedBadge: false,
      stale: false,
      metadata,
    }
  }
  if (!metadata.verified) {
    return {
      status: "unverified",
      showVerifiedBadge: false,
      stale: false,
      metadata,
    }
  }
  return {
    status: "verified",
    showVerifiedBadge: true,
    stale: false,
    metadata,
  }
}

export async function fetchExplorerMetadata(
  collectionId: number,
  committedDigest?: string,
  options?: {
    adapter?: ExplorerMetadataAdapter
    ttlMs?: number
    staleMaxMs?: number
    timeoutMs?: number
    now?: number
  },
): Promise<ExplorerMetadataResult> {
  if (!isFeatureEnabled("phase-250")) {
    return {
      status: "disabled",
      showVerifiedBadge: false,
      stale: false,
      metadata: null,
    }
  }

  const now = options?.now ?? Date.now()
  const ttlMs = options?.ttlMs ?? EXPLORER_METADATA_TTL_MS
  const staleMaxMs = options?.staleMaxMs ?? EXPLORER_METADATA_STALE_MAX_MS
  const timeoutMs = options?.timeoutMs ?? EXPLORER_ADAPTER_TIMEOUT_MS
  const adapter = options?.adapter ?? defaultSorobanExplorerAdapter

  const cached = metadataCache.get(collectionId)
  if (cached && now - cached.fetchedAt < ttlMs) {
    return evaluateMetadataMatch(cached.metadata, committedDigest)
  }

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = await Promise.race([
      adapter(collectionId, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("EXPLORER_ADAPTER_TIMEOUT"))
        }, timeoutMs)
      }),
    ])

    const computedDigest =
      raw.digest ??
      computeExplorerMetadataDigest({
        collectionId: raw.collectionId,
        name: raw.name,
        externalUrl: raw.externalUrl,
      })

    const parsed = ExplorerMetadataSchema.parse({
      collectionId: raw.collectionId,
      name: raw.name,
      externalUrl: raw.externalUrl,
      verified: raw.verified,
      digest: computedDigest,
      fetchedAt: now,
    })

    metadataCache.set(collectionId, { metadata: parsed, fetchedAt: now })
    return evaluateMetadataMatch(parsed, committedDigest)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (cached && now - cached.fetchedAt <= staleMaxMs) {
      return {
        status: "stale",
        showVerifiedBadge: false,
        stale: true,
        metadata: cached.metadata,
        error,
      }
    }
    return {
      status: "unavailable",
      showVerifiedBadge: false,
      stale: false,
      metadata: null,
      error,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
