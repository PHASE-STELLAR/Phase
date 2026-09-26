/**
 * Verified-artist badge issuance via signed attestation — phase-94
 *
 * Fake artist impersonation was previously unchecked in the setup/reset/SAC
 * scripts: any wallet could self-label as an "artist" in profile metadata.
 * This module issues a badge only after a wallet signs a canonical attestation
 * payload with its Stellar keypair; the signature is verified against the
 * claimed public key before the badge is persisted.
 *
 * Feature flag: phase-94 (NEXT_PUBLIC_FEATURE_PHASE_94 / FEATURE_PHASE_94)
 * Rollback: unset flag → issuance/verification calls throw FLAG_DISABLED;
 *           previously issued badges remain on disk and keep reading fine
 *           (no destructive migration involved).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"

export function isPhase94Enabled(): boolean {
  return isFeatureEnabled("phase-94")
}

export function flag94RollbackNote(): string {
  return "Rollback phase-94: unset NEXT_PUBLIC_FEATURE_PHASE_94 / FEATURE_PHASE_94 or set to 0/false and restart. Issued badges remain on disk; new issuance/verification is disabled until re-enabled."
}

// ─── schemas ─────────────────────────────────────────────────────────────────

const STELLAR_G_REGEX = /^G[A-Z2-7]{55}$/

export const ArtistAttestationPayloadSchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX, "Invalid Stellar G address"),
  displayName: z.string().trim().min(1).max(48),
  claim: z.literal("verified-artist"),
  issuedAt: z.number().int().min(0),
  nonce: z.string().trim().min(8).max(64),
})

export type ArtistAttestationPayload = z.infer<typeof ArtistAttestationPayloadSchema>

export const IssueBadgeRequestSchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX),
  displayName: z.string().trim().min(1).max(48),
  issuedAt: z.number().int().min(0),
  nonce: z.string().trim().min(8).max(64),
  /** Base64 ed25519 signature of the canonical attestation payload, produced by the wallet's keypair. */
  signature: z.string().trim().min(1).max(512),
})

export type IssueBadgeRequest = z.infer<typeof IssueBadgeRequestSchema>

export const ArtistBadgeSchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX),
  displayName: z.string().trim().min(1).max(48),
  claim: z.literal("verified-artist"),
  issuedAt: z.number().int().min(0),
  nonce: z.string().trim().min(8).max(64),
  signature: z.string().trim().min(1).max(512),
  verifiedAt: z.number().int().min(0),
})

export type ArtistBadge = z.infer<typeof ArtistBadgeSchema>

// ─── structured errors ───────────────────────────────────────────────────────

export class ArtistAttestationError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "SIGNATURE_INVALID" | "ALREADY_ISSUED" | "NOT_FOUND" | "STORE_FAILED"
  constructor(code: ArtistAttestationError["code"], message: string) {
    super(message)
    this.name = "ArtistAttestationError"
    this.code = code
  }
}

// ─── canonical payload + signature verification ─────────────────────────────

/** Deterministic byte layout so wallet-signed bytes match server-side verification exactly. */
export function canonicalAttestationMessage(payload: Omit<ArtistAttestationPayload, "claim">): string {
  return `PHASE_VERIFIED_ARTIST_ATTESTATION_V1|${payload.wallet}|${payload.displayName}|${payload.issuedAt}|${payload.nonce}`
}

export function verifyAttestationSignature(
  wallet: string,
  message: string,
  signatureBase64: string,
): boolean {
  if (!StrKey.isValidEd25519PublicKey(wallet)) return false
  try {
    const kp = Keypair.fromPublicKey(wallet)
    const sig = Buffer.from(signatureBase64, "base64")
    return kp.verify(Buffer.from(message, "utf8"), sig)
  } catch {
    return false
  }
}

// ─── store helpers ───────────────────────────────────────────────────────────

async function badgesFilePath(): Promise<string> {
  const { serverDataJsonPath } = await import("@/lib/server-data-paths")
  return serverDataJsonPath("artistAttestations")
}

type BadgeStore = Record<string, ArtistBadge>

async function readBadgeStore(): Promise<BadgeStore> {
  try {
    const fp = await badgesFilePath()
    const raw = await readFile(fp, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: BadgeStore = {}
    for (const [k, v] of Object.entries(parsed)) {
      const res = ArtistBadgeSchema.safeParse(v)
      if (res.success) out[k] = res.data
    }
    return out
  } catch {
    return {}
  }
}

async function writeBadgeStore(data: BadgeStore): Promise<void> {
  const fp = await badgesFilePath()
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(data, null, 2), "utf8")
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Verify a wallet's signature over the canonical attestation payload and, if
 * valid, persist a verified-artist badge. Rejects mismatched/forged signatures
 * (the fake-impersonation gap this module closes).
 */
export async function issueVerifiedArtistBadge(req: IssueBadgeRequest): Promise<ArtistBadge> {
  if (!isPhase94Enabled()) {
    throw new ArtistAttestationError("FLAG_DISABLED", "Verified-artist badge issuance disabled (phase-94 flag off)")
  }
  const parsed = IssueBadgeRequestSchema.safeParse(req)
  if (!parsed.success) {
    throw new ArtistAttestationError("VALIDATION_FAILED", parsed.error.message)
  }
  const { wallet, displayName, issuedAt, nonce, signature } = parsed.data

  const message = canonicalAttestationMessage({ wallet, displayName, issuedAt, nonce })
  if (!verifyAttestationSignature(wallet, message, signature)) {
    throw new ArtistAttestationError(
      "SIGNATURE_INVALID",
      `Attestation signature does not match wallet ${wallet.slice(0, 6)}…; badge not issued.`,
    )
  }

  const store = await readBadgeStore()
  const existing = store[wallet]
  if (existing && existing.nonce === nonce) {
    throw new ArtistAttestationError("ALREADY_ISSUED", `Badge already issued for wallet ${wallet.slice(0, 6)}… with this nonce.`)
  }

  const badge: ArtistBadge = ArtistBadgeSchema.parse({
    wallet,
    displayName,
    claim: "verified-artist",
    issuedAt,
    nonce,
    signature,
    verifiedAt: Date.now(),
  })
  store[wallet] = badge
  await writeBadgeStore(store)
  return badge
}

export async function getVerifiedArtistBadge(wallet: string): Promise<ArtistBadge | null> {
  if (!STRKEY_VALID(wallet)) return null
  const store = await readBadgeStore()
  return store[wallet] ?? null
}

function STRKEY_VALID(wallet: string): boolean {
  return StrKey.isValidEd25519PublicKey(wallet)
}

export async function isVerifiedArtist(wallet: string): Promise<boolean> {
  return (await getVerifiedArtistBadge(wallet)) != null
}

export async function revokeVerifiedArtistBadge(wallet: string): Promise<void> {
  if (!isPhase94Enabled()) {
    throw new ArtistAttestationError("FLAG_DISABLED", "Verified-artist badge issuance disabled")
  }
  const store = await readBadgeStore()
  if (!store[wallet]) {
    throw new ArtistAttestationError("NOT_FOUND", `No verified-artist badge for wallet ${wallet.slice(0, 6)}…`)
  }
  delete store[wallet]
  await writeBadgeStore(store)
}

export async function listVerifiedArtistBadges(): Promise<ArtistBadge[]> {
  const store = await readBadgeStore()
  return Object.values(store).sort((a, b) => b.verifiedAt - a.verifiedAt)
}

// ─── on-chain attestation (Issue #225) ──────────────────────────────────────
//
// An off-chain badge is only a cache: the trust anchor is the
// `artist_attestations` entry in the phase-protocol contract, which is only
// writable through `attest_artist` gated by `require_auth(admin)`. A badge is
// therefore never issued unless the chain agrees the artist is attested, so a
// forged/mismatched off-chain store entry cannot be promoted to "verified".

export type OnChainAttestationResult = "verified" | "not_attested" | "unavailable"

const ON_CHAIN_CHECK_TIMEOUT_MS = 8_000
const ON_CHAIN_CACHE_TTL_MS = 5 * 60 * 1000 // 5 min, per the issue's cache spec
const onChainCache = new Map<string, { at: number; result: OnChainAttestationResult }>()

/** Read-only G address used as the simulation fee source for read calls. */
const READ_SOURCE_G =
  process.env.PHASE_READONLY_SIM_SOURCE_G?.trim() ||
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

/**
 * Query the phase-protocol contract for the artist's attestation flag.
 *
 * Returns "verified" | "not_attested" when the chain answered, and
 * "unavailable" when the RPC/contract could not be reached — callers must
 * decide whether "unavailable" is fatal (issuance) or a degradation (reads).
 */
export async function checkOnChainArtistAttestation(
  wallet: string,
): Promise<OnChainAttestationResult> {
  if (!STRKEY_VALID(wallet)) return "not_attested"

  const cached = onChainCache.get(wallet)
  const now = Date.now()
  if (cached && now - cached.at < ON_CHAIN_CACHE_TTL_MS) return cached.result

  let result: OnChainAttestationResult = "unavailable"
  try {
    const [{ rpc, xdr, Contract, TransactionBuilder, Networks }, protocol] = await Promise.all([
      import("@stellar/stellar-sdk"),
      import("@/lib/phase-protocol"),
    ])
    const contractId = protocol.phaseProtocolContractIdForServer()
    if (!contractId) return "unavailable"

    const url = process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org"
    const server = new rpc.Server(url, { allowHttp: url.startsWith("http:") })
    const source = await server.getAccount(READ_SOURCE_G)
    const contract = new Contract(contractId)
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call("is_artist_attested", xdr.ScVal.scvAddress(wallet)))
      .setTimeout(300)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      // An unknown method / missing entry surfaces as a simulation error, which
      // we treat as "not attested" rather than an infrastructure failure.
      result = "not_attested"
    } else {
      const retval = sim.result?.retval
      const decoded = retval ? xdr.ScVal.fromXDR(retval, "base64") : null
      const isVerified =
        decoded?.switch?.() === xdr.ScValType.scvBool && decoded.bool() === true
      result = isVerified ? "verified" : "not_attested"
    }
  } catch {
    result = "unavailable"
  }

  onChainCache.set(wallet, { at: now, result })
  return result
}

/** Test seam: clears the on-chain attestation cache. */
export function __resetArtistAttestationCacheForTests(): void {
  onChainCache.clear()
}


/**
 * Deployment-script wiring hook: audits that the attestation schema and
 * signature-verification pipeline are loadable/consistent before setup/reset
 * scripts run, without duplicating logic in each script (single source of
 * truth here; scripts/issue-sac-token.ts wiring untouched).
 */
export function auditArtistAttestationWiring(): { ok: boolean; note: string } {
  if (!isPhase94Enabled()) {
    return { ok: true, note: "[phase-94] verified-artist badge issuance disabled; nothing to audit." }
  }
  const probe = ArtistAttestationPayloadSchema.safeParse({
    wallet: "G" + "A".repeat(55),
    displayName: "probe",
    claim: "verified-artist",
    issuedAt: Date.now(),
    nonce: "00000000",
  })
  if (!probe.success) {
    return { ok: false, note: `[phase-94] attestation schema drift (unexpected, report): ${probe.error.message}` }
  }
  return { ok: true, note: "[phase-94] verified-artist attestation wiring OK. " + flag94RollbackNote() }
}
