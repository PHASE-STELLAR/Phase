/**
 * phase-80: Fractional-ownership store
 *
 * Persistence layer for co-ownership listings created through the
 * /api/fractional routes.  All mutations run inside `withFileLock` so
 * concurrent buy requests for the same artifact are serialised within
 * one process — the second writer sees the state the first writer left,
 * and returns 409 when the available share count has already dropped
 * below the requested amount.
 *
 * No on-chain escrow exists yet.  Every listing is off-chain only.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_80 / FEATURE_PHASE_80 —
 * the API routes 404 and this module is never imported in that path.
 *
 * SCOPE LIMIT — the file lock is per-process.  Cross-instance safety
 * on serverless platforms requires a shared datastore.  See
 * lib/json-store.ts for the same caveat on all JSON sidecars.
 */

import { randomUUID } from "node:crypto"
import { readJsonFile, updateJsonFile } from "@/lib/json-store"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import {
  validateFractionalListing,
  validateSharePurchase,
  type FractionalArtifact,
  type CreateFractionalListing,
  type PurchaseShares,
  MAX_SHAREHOLDERS_PER_ARTIFACT,
} from "@/lib/fractional-ownership"

// ── Store shape ────────────────────────────────────────────────────────────

type StoreV1 = {
  version: 1
  listings: Record<string, FractionalArtifact>
}

const STORE_VERSION = 1 as const

function storeFilePath(): string {
  return serverDataJsonPath("fractionalListings")
}

async function readStore(): Promise<StoreV1> {
  const raw = await readJsonFile<StoreV1>(storeFilePath(), {
    version: STORE_VERSION,
    listings: {},
  })
  if (raw.version !== STORE_VERSION) {
    return { version: STORE_VERSION, listings: {} }
  }
  return raw
}

// ── Public API ─────────────────────────────────────────────────────────────

export type CreateListingResult =
  | { ok: true; artifact: FractionalArtifact }
  | { ok: false; error: string; status: number }

export async function createFractionalListing(
  input: CreateFractionalListing
): Promise<CreateListingResult> {
  const v = validateFractionalListing(input)
  if (!v.valid) {
    return { ok: false, error: v.error ?? "invalid input", status: 400 }
  }

  let created: FractionalArtifact | null = null

  await updateJsonFile<StoreV1>(
    storeFilePath(),
    (store) => {
      const artifactId = randomUUID()
      const now = Date.now()

      const artifact: FractionalArtifact = {
        artifactId,
        tokenId: input.tokenId,
        collectionId: input.collectionId,
        totalShares: input.totalShares,
        sharePrice: input.sharePrice,
        availableShares: input.totalShares,
        shareholders: [],
        creator: input.creator,
        createdAt: now,
        status: "listing",
        metadata: input.metadata,
      }

      store.listings[artifactId] = artifact
      created = artifact
      return store
    },
    { version: STORE_VERSION, listings: {} }
  )

  if (!created) return { ok: false, error: "store write failed", status: 500 }
  return { ok: true, artifact: created }
}

export async function getFractionalListings(opts?: {
  status?: FractionalArtifact["status"]
  creator?: string
}): Promise<FractionalArtifact[]> {
  const store = await readStore()
  let listings = Object.values(store.listings)

  if (opts?.status) {
    listings = listings.filter((l) => l.status === opts.status)
  }
  if (opts?.creator) {
    listings = listings.filter((l) => l.creator === opts.creator)
  }

  return listings.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getFractionalListing(
  artifactId: string
): Promise<FractionalArtifact | null> {
  const store = await readStore()
  return store.listings[artifactId] ?? null
}

export type PurchaseResult =
  | { ok: true; artifact: FractionalArtifact }
  | { ok: false; error: string; status: number }

export async function purchaseFractionalShares(
  input: PurchaseShares
): Promise<PurchaseResult> {
  const v = validateSharePurchase(input)
  if (!v.valid) {
    return { ok: false, error: v.error ?? "invalid input", status: 400 }
  }

  let result: PurchaseResult | null = null

  await updateJsonFile<StoreV1>(
    storeFilePath(),
    (store) => {
      const artifact = store.listings[input.artifactId]
      if (!artifact) {
        result = { ok: false, error: "listing not found", status: 404 }
        return store
      }
      if (artifact.status !== "listing") {
        result = { ok: false, error: "listing is not open", status: 409 }
        return store
      }
      if (artifact.availableShares < input.shares) {
        // Concurrent buy that raced ahead already claimed these shares.
        result = { ok: false, error: "not enough available shares", status: 409 }
        return store
      }
      if (artifact.shareholders.length >= MAX_SHAREHOLDERS_PER_ARTIFACT) {
        const existing = artifact.shareholders.find((s) => s.address === input.buyer)
        if (!existing) {
          result = { ok: false, error: "holder cap reached (max 100)", status: 409 }
          return store
        }
      }

      // Apply purchase — BigInt for all arithmetic.
      const existing = artifact.shareholders.find((s) => s.address === input.buyer)
      if (existing) {
        existing.shares = Number(BigInt(existing.shares) + BigInt(input.shares))
      } else {
        artifact.shareholders.push({
          address: input.buyer,
          shares: input.shares,
          acquiredAt: Date.now(),
        })
      }

      artifact.availableShares = Number(
        BigInt(artifact.availableShares) - BigInt(input.shares)
      )

      if (artifact.availableShares === 0) {
        artifact.status = "fully_owned"
      }

      result = { ok: true, artifact }
      return store
    },
    { version: STORE_VERSION, listings: {} }
  )

  return result ?? { ok: false, error: "store write failed", status: 500 }
}
