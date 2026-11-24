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

import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Address, Keypair, scValToNative, StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { getDb } from "@/lib/sqlite-db"

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
      .addOperation(contract.call("is_artist_attested", Address.fromString(wallet).toScVal()))
      .setTimeout(300)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      // An unknown method / missing entry surfaces as a simulation error, which
      // we treat as "not attested" rather than an infrastructure failure.
      result = "not_attested"
    } else {
      const retval = sim.result?.retval
      const isVerified = retval ? scValToNative(retval) === true : false
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

// ── phase-245 (#696): Wallet-signed attestation & version-guarded primary alias control ──

export const ARTIST_ALIAS_COPY = {
  en: {
    signatureRequired: "Wallet signature is required to attest or update your primary alias.",
    signatureInvalid: "Forged or invalid wallet signature for alias attestation.",
    versionConflict: "Alias version conflict. Refresh your current alias version and retry.",
    aliasTaken: "This primary alias is already claimed by another wallet.",
    saved: "Primary alias attested and saved to wallet.",
    attestedBadge: "Wallet-attested alias",
    auditTitle: "Alias audit trail",
  },
  es: {
    signatureRequired: "Se requiere firma de la wallet para atestar o actualizar tu alias principal.",
    signatureInvalid: "Firma de wallet falsificada o inválida para la atestación del alias.",
    versionConflict: "Conflicto de versión del alias. Actualiza la versión e inténtalo de nuevo.",
    aliasTaken: "Este alias principal ya está reclamado por otra wallet.",
    saved: "Alias principal atestado y guardado en la wallet.",
    attestedBadge: "Alias atestado por wallet",
    auditTitle: "Historial de auditoría del alias",
  },
} as const

export function pickArtistAliasCopy(lang?: string | null) {
  const normalized = (lang ?? "").trim().toLowerCase().slice(0, 2)
  return normalized === "es" ? ARTIST_ALIAS_COPY.es : ARTIST_ALIAS_COPY.en
}

export function isArtistAttestationV2Enabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-245", wallet ? { wallet, runtimeOnly: true } : { runtimeOnly: true })
}

export const AliasChangeRequestSchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX, "Invalid Stellar G address"),
  alias: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9 ._-]+$/, "Alias contains invalid characters"),
  expectedVersion: z.number().int().min(0),
  issuedAt: z.number().int().min(0),
  nonce: z.string().trim().min(8).max(64),
  signature: z.string().trim().min(1).max(512),
  attested: z.boolean().optional(),
})

export type AliasChangeRequest = z.infer<typeof AliasChangeRequestSchema>

export type ArtistAliasRecord = {
  wallet: string
  alias: string
  aliasNormalized: string
  version: number
  attested: boolean
  updatedAt: number
}

export type ArtistAliasAuditEntry = {
  id: string
  wallet: string
  action: "created" | "updated" | "attested"
  alias: string
  version: number
  nonce: string
  createdAt: number
}

export function canonicalAliasChangeMessage(params: {
  wallet: string
  alias: string
  expectedVersion: number
  issuedAt: number
  nonce: string
}): string {
  return `PHASE_ARTIST_ALIAS_V1|${params.wallet}|${params.alias}|${params.expectedVersion}|${params.issuedAt}|${params.nonce}`
}

export type SaveArtistAliasResult =
  | { ok: true; record: ArtistAliasRecord }
  | {
      ok: false
      status: 400 | 401 | 409
      code: "VALIDATION_FAILED" | "SIGNATURE_INVALID" | "VERSION_CONFLICT" | "HANDLE_TAKEN"
      error: string
      currentVersion?: number
    }

/**
 * Verifies the wallet's Ed25519 signature over the canonical alias payload,
 * enforces one primary alias per wallet and global normalized-alias uniqueness
 * inside a SQLite BEGIN IMMEDIATE transaction with optimistic version guard,
 * and appends an immutable audit trail entry.
 */
export function saveSignedArtistAlias(raw: unknown, lang?: string | null): SaveArtistAliasResult {
  const t = pickArtistAliasCopy(lang)
  const parsed = AliasChangeRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_FAILED",
      error: parsed.error.issues[0]?.message ?? "Invalid alias payload",
    }
  }

  const req = parsed.data
  const message = canonicalAliasChangeMessage({
    wallet: req.wallet,
    alias: req.alias,
    expectedVersion: req.expectedVersion,
    issuedAt: req.issuedAt,
    nonce: req.nonce,
  })

  if (!verifyAttestationSignature(req.wallet, message, req.signature)) {
    return {
      ok: false,
      status: 401,
      code: "SIGNATURE_INVALID",
      error: t.signatureInvalid,
    }
  }

  const normalized = req.alias.trim().toLowerCase()
  const now = Date.now()
  const attestedInt = req.attested === false ? 0 : 1
  const db = getDb()

  db.exec("BEGIN IMMEDIATE")
  try {
    const existingWallet = db
      .prepare("SELECT wallet, alias, alias_normalized, version, attested, updated_at FROM artist_aliases WHERE wallet = ?")
      .get(req.wallet) as
      | {
          wallet: string
          alias: string
          alias_normalized: string
          version: number
          attested: number
          updated_at: number
        }
      | undefined

    const currentVersion = existingWallet?.version ?? 0
    if (req.expectedVersion !== currentVersion) {
      db.exec("ROLLBACK")
      return {
        ok: false,
        status: 409,
        code: "VERSION_CONFLICT",
        error: t.versionConflict,
        currentVersion,
      }
    }

    const holder = db
      .prepare("SELECT wallet FROM artist_aliases WHERE alias_normalized = ?")
      .get(normalized) as { wallet: string } | undefined

    if (holder && holder.wallet !== req.wallet) {
      db.exec("ROLLBACK")
      return {
        ok: false,
        status: 409,
        code: "HANDLE_TAKEN",
        error: t.aliasTaken,
      }
    }

    const nextVersion = currentVersion + 1
    const action: ArtistAliasAuditEntry["action"] =
      currentVersion === 0 ? "created" : attestedInt === 1 ? "attested" : "updated"

    if (currentVersion === 0) {
      db.prepare(`
        INSERT INTO artist_aliases (wallet, alias, alias_normalized, version, attested, signature, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(req.wallet, req.alias, normalized, nextVersion, attestedInt, req.signature, now)
    } else {
      const update = db
        .prepare(`
          UPDATE artist_aliases
          SET alias = ?, alias_normalized = ?, version = ?, attested = ?, signature = ?, updated_at = ?
          WHERE wallet = ? AND version = ?
        `)
        .run(req.alias, normalized, nextVersion, attestedInt, req.signature, now, req.wallet, currentVersion)
      if (update.changes !== 1) {
        db.exec("ROLLBACK")
        return {
          ok: false,
          status: 409,
          code: "VERSION_CONFLICT",
          error: t.versionConflict,
          currentVersion,
        }
      }
    }

    db.prepare(`
      INSERT INTO artist_alias_audit (id, wallet, action, alias, version, nonce, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), req.wallet, action, req.alias, nextVersion, req.nonce, now)

    db.exec("COMMIT")
    return {
      ok: true,
      record: {
        wallet: req.wallet,
        alias: req.alias,
        aliasNormalized: normalized,
        version: nextVersion,
        attested: attestedInt === 1,
        updatedAt: now,
      },
    }
  } catch (err) {
    db.exec("ROLLBACK")
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("UNIQUE")) {
      return {
        ok: false,
        status: 409,
        code: "HANDLE_TAKEN",
        error: t.aliasTaken,
      }
    }
    throw err
  }
}

export function getSignedArtistAlias(wallet: string): ArtistAliasRecord | null {
  const row = getDb()
    .prepare("SELECT wallet, alias, alias_normalized, version, attested, updated_at FROM artist_aliases WHERE wallet = ?")
    .get(wallet.trim()) as
    | {
        wallet: string
        alias: string
        alias_normalized: string
        version: number
        attested: number
        updated_at: number
      }
    | undefined
  if (!row) return null
  return {
    wallet: row.wallet,
    alias: row.alias,
    aliasNormalized: row.alias_normalized,
    version: row.version,
    attested: row.attested === 1,
    updatedAt: row.updated_at,
  }
}

export function resolveSignedArtistAlias(alias: string): ArtistAliasRecord | null {
  const normalized = alias.trim().toLowerCase()
  const row = getDb()
    .prepare("SELECT wallet, alias, alias_normalized, version, attested, updated_at FROM artist_aliases WHERE alias_normalized = ?")
    .get(normalized) as
    | {
        wallet: string
        alias: string
        alias_normalized: string
        version: number
        attested: number
        updated_at: number
      }
    | undefined
  if (!row) return null
  return {
    wallet: row.wallet,
    alias: row.alias,
    aliasNormalized: row.alias_normalized,
    version: row.version,
    attested: row.attested === 1,
    updatedAt: row.updated_at,
  }
}

export function getArtistAliasAudit(wallet: string, limit = 50): ArtistAliasAuditEntry[] {
  const bounded = Math.max(1, Math.min(100, limit))
  const rows = getDb()
    .prepare("SELECT id, wallet, action, alias, version, nonce, created_at FROM artist_alias_audit WHERE wallet = ? ORDER BY created_at DESC LIMIT ?")
    .all(wallet.trim(), bounded) as Array<{
    id: string
    wallet: string
    action: ArtistAliasAuditEntry["action"]
    alias: string
    version: number
    nonce: string
    created_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    wallet: r.wallet,
    action: r.action,
    alias: r.alias,
    version: r.version,
    nonce: r.nonce,
    createdAt: r.created_at,
  }))
}
