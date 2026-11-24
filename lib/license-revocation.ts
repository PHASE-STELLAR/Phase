/**
 * phase-216 — license revocation with cascade to market listings.
 *
 * phase-165 stored signed license attestations but had no revocation path.
 * Revocation here is additive: the original signed declaration (wallet,
 * rights basis, nonce, signature) is never mutated or deleted; only the three
 * revocation fields are appended. Every decision is recorded in the
 * append-only gating audit log.
 *
 * Flag off: revocation throws FLAG_DISABLED and listings are untouched.
 */

import { isPhase216Enabled, phase216RollbackNote } from "@/lib/age-gate-216"
import { readStore, updateStore } from "@/lib/json-store"
import { appendGatingDecision } from "@/lib/gating-audit"
import { cancelListingsForCollection } from "@/lib/market-store"
import type { LicenseAttestation } from "@/lib/license-attestation"

export { isPhase216Enabled, phase216RollbackNote }

export type LicenseStatus = "active" | "revoked" | "none"

export interface LicenseMetadata {
  collection_id: number
  rights_basis: string | null
  evidence_cid: string | null
  status: LicenseStatus
  revoked_at?: number
}

type LicenseStore = Record<string, LicenseAttestation>

export class LicenseRevocationError extends Error {
  readonly code: "FLAG_DISABLED" | "NOT_FOUND" | "INVALID_COLLECTION"
  constructor(code: LicenseRevocationError["code"], message: string) {
    super(message)
    this.name = "LicenseRevocationError"
    this.code = code
  }
}

function emptyStore(): LicenseStore {
  return {}
}

export async function getLicenseMetadata(collectionId: number): Promise<LicenseMetadata> {
  if (!isPhase216Enabled()) {
    return { collection_id: collectionId, rights_basis: null, evidence_cid: null, status: "none" }
  }
  try {
    const store = await readStore<LicenseStore>("licenseAttestations", emptyStore)
    const attestation = store[String(collectionId)]
    if (!attestation) {
      return { collection_id: collectionId, rights_basis: null, evidence_cid: null, status: "none" }
    }
    const revoked = typeof attestation.revoked_at === "number"
    return {
      collection_id: collectionId,
      rights_basis: attestation.rights_basis,
      evidence_cid: attestation.evidence_cid,
      status: revoked ? "revoked" : "active",
      ...(revoked ? { revoked_at: attestation.revoked_at } : {}),
    }
  } catch {
    return { collection_id: collectionId, rights_basis: null, evidence_cid: null, status: "none" }
  }
}

/** Attach license metadata to a list of listings without mutating them. */
export async function attachLicenseMetadata<T extends { collection_id: number }>(
  listings: readonly T[],
): Promise<Array<T & { license: LicenseMetadata }>> {
  if (!isPhase216Enabled()) {
    return listings.map((listing) => ({
      ...listing,
      license: {
        collection_id: listing.collection_id,
        rights_basis: null,
        evidence_cid: null,
        status: "none" as const,
      },
    }))
  }
  const unique = Array.from(new Set(listings.map((l) => l.collection_id)))
  const metas = await Promise.all(unique.map((id) => getLicenseMetadata(id)))
  const byCollection = new Map(metas.map((meta) => [meta.collection_id, meta]))
  return listings.map((listing) => ({
    ...listing,
    license: byCollection.get(listing.collection_id) ?? {
      collection_id: listing.collection_id,
      rights_basis: null,
      evidence_cid: null,
      status: "none" as const,
    },
  }))
}

/**
 * Revoke a collection license and delist every active listing for it. The
 * cascade happens within one tick (before this function resolves).
 */
export async function revokeLicense(
  collectionId: number,
  adminWallet: string,
  reason: string,
): Promise<{ attestation: LicenseAttestation; delisted: number }> {
  if (!isPhase216Enabled()) {
    throw new LicenseRevocationError("FLAG_DISABLED", "license revocation disabled (phase-216 flag off)")
  }
  if (!Number.isInteger(collectionId) || collectionId < 0) {
    throw new LicenseRevocationError("INVALID_COLLECTION", "collection_id must be a non-negative integer")
  }

  const now = Math.floor(Date.now() / 1000)
  const attestation = await updateStore<LicenseStore, LicenseAttestation | null>(
    "licenseAttestations",
    (store) => {
      const existing = store[String(collectionId)]
      if (!existing) return null
      if (existing.revoked_at === undefined) {
        // Additive: original fields are left untouched.
        store[String(collectionId)] = {
          ...existing,
          revoked_at: now,
          revoked_by: adminWallet,
          revocation_reason: reason.slice(0, 500),
        }
      }
      return store[String(collectionId)]
    },
  )
  if (!attestation) {
    await appendGatingDecision({
      action: "license.revocation",
      subject: String(collectionId),
      wallet: adminWallet,
      decision: "denied",
      reason: "not_found",
    })
    throw new LicenseRevocationError("NOT_FOUND", "no license attestation for this collection")
  }

  const delisted = await cancelListingsForCollection(collectionId)
  await appendGatingDecision({
    action: "license.revocation",
    subject: String(collectionId),
    wallet: adminWallet,
    decision: "allowed",
    reason: reason.slice(0, 500),
  })
  await appendGatingDecision({
    action: "license.cascade",
    subject: String(collectionId),
    wallet: adminWallet,
    decision: "allowed",
    reason: `delisted ${delisted} listing(s)`,
  })

  return { attestation, delisted }
}
