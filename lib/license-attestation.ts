/**
 * Signed creator licensing declarations on collection creation — spike 639 (issue #501).
 *
 * Wallet identity (phase-94, artist badges) does not prove the creator has the
 * right to publish the work. A creator declares the rights basis of a new world
 * and signs that declaration with the same wallet key used for SEP-10. The
 * declaration is verified, bound to the collection and creator wallet, stored
 * once per collection, and its nonce is never accepted twice.
 *
 * Feature flag: phase-165. Rollback: unset flag; stored attestations stay inert on disk.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { verifyAttestationSignature } from "@/lib/artist-attestation"

export const RIGHTS_BASES = ["original", "ai-generated", "licensed", "public-domain", "fair-use"] as const
export type RightsBasis = (typeof RIGHTS_BASES)[number]

/** Bases that cannot stand without third-party evidence (agreement, PD proof, model+prompt record). */
const EVIDENCE_REQUIRED: readonly RightsBasis[] = ["ai-generated", "licensed", "public-domain", "fair-use"]

/** Signed timestamps must be this fresh; longer windows let old declarations be replayed. */
export const LICENSE_ATTESTATION_MAX_AGE_SECONDS = 300

export type LicenseAttestation = {
  wallet: string
  collection_id: number
  rights_basis: RightsBasis
  evidence_cid: string | null
  issued_at: number
  nonce: string
  signature: string
  recorded_at: number
}

export type LicenseAttestationInput = Omit<LicenseAttestation, "collection_id" | "recorded_at"> & {
  collection_id?: number
}

export class LicenseAttestationError extends Error {
  code: "FLAG_DISABLED" | "LICENSE_ATTESTATION_REQUIRED" | "LICENSE_ATTESTATION_INVALID" | "ALREADY_ISSUED" | "NONCE_REUSED"
  constructor(code: LicenseAttestationError["code"], message: string) {
    super(message)
    this.name = "LicenseAttestationError"
    this.code = code
  }
}

export function isLicense165Enabled(): boolean {
  return isFeatureEnabled("phase-165")
}

/** Deterministic bytes the creator signs. Field order is fixed and every field is bound. */
export function canonicalLicenseMessage(
  input: Pick<LicenseAttestation, "wallet" | "collection_id" | "rights_basis" | "evidence_cid" | "issued_at" | "nonce">,
): string {
  return [
    "PHASE_LICENSE_ATTESTATION_V1",
    input.wallet,
    String(input.collection_id),
    input.rights_basis,
    input.evidence_cid ?? "",
    String(input.issued_at),
    input.nonce,
  ].join("|")
}

/** Validates shape and cross-field rules. Returns a reason string on failure, null when valid. */
export function validateLicenseShape(input: LicenseAttestationInput): string | null {
  if (!(RIGHTS_BASES as readonly string[]).includes(input.rights_basis)) return "unknown rights_basis"
  if (EVIDENCE_REQUIRED.includes(input.rights_basis) && !input.evidence_cid) {
    return `rights_basis "${input.rights_basis}" requires evidence_cid`
  }
  if (!Number.isInteger(input.issued_at) || input.issued_at <= 0) return "issued_at must be a unix timestamp"
  if (typeof input.nonce !== "string" || input.nonce.length < 8 || input.nonce.length > 64) return "nonce length invalid"
  if (typeof input.signature !== "string" || input.signature.length === 0) return "signature missing"
  return null
}

type LicenseStore = Record<string, LicenseAttestation>

async function readStore(): Promise<LicenseStore> {
  try {
    const raw = await readFile(serverDataJsonPath("licenseAttestations"), "utf8")
    return JSON.parse(raw) as LicenseStore
  } catch {
    return {}
  }
}

async function writeStore(store: LicenseStore): Promise<void> {
  const fp = serverDataJsonPath("licenseAttestations")
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(store, null, 2), "utf8")
}

export async function getLicenseAttestation(collectionId: number): Promise<LicenseAttestation | null> {
  const store = await readStore()
  return store[String(collectionId)] ?? null
}

/**
 * Verify and persist the creator's licensing declaration for a new collection.
 * The first attestation per collection is final; a reused nonce is rejected anywhere in the store.
 */
export async function recordLicenseAttestation(
  input: LicenseAttestationInput & { collection_id: number },
  now: number = Math.floor(Date.now() / 1000),
): Promise<LicenseAttestation> {
  if (!isLicense165Enabled()) {
    throw new LicenseAttestationError("FLAG_DISABLED", "license attestation disabled (phase-165 flag off)")
  }
  const shapeError = validateLicenseShape(input)
  if (shapeError) throw new LicenseAttestationError("LICENSE_ATTESTATION_INVALID", shapeError)
  if (Math.abs(now - input.issued_at) > LICENSE_ATTESTATION_MAX_AGE_SECONDS) {
    throw new LicenseAttestationError("LICENSE_ATTESTATION_INVALID", "attestation timestamp outside the allowed window")
  }

  const message = canonicalLicenseMessage({ ...input, collection_id: input.collection_id, evidence_cid: input.evidence_cid ?? null })
  if (!verifyAttestationSignature(input.wallet, message, input.signature)) {
    throw new LicenseAttestationError("LICENSE_ATTESTATION_INVALID", "signature does not match creator wallet")
  }

  const store = await readStore()
  const key = String(input.collection_id)
  if (store[key]) {
    throw new LicenseAttestationError("ALREADY_ISSUED", "collection already has a licensing declaration")
  }
  if (Object.values(store).some((a) => a.nonce === input.nonce)) {
    throw new LicenseAttestationError("NONCE_REUSED", "attestation nonce was already used")
  }

  const record: LicenseAttestation = {
    wallet: input.wallet,
    collection_id: input.collection_id,
    rights_basis: input.rights_basis,
    evidence_cid: input.evidence_cid ?? null,
    issued_at: input.issued_at,
    nonce: input.nonce,
    signature: input.signature,
    recorded_at: now,
  }
  store[key] = record
  await writeStore(store)
  return record
}
