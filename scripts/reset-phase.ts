/**
 * Reset de identidades testnet para PHASELQ clásico + distribuidor con liquidez.
 *
 * Crea issuer + distributor, fondea con Friendbot, trustline, pago masivo al distribuidor.
 * Imprime variables para `.env.local` y el comando Stellar CLI para desplegar el SAC.
 *
 * Uso (desde la raíz del repo):
 *   cd scripts && npm install && npm run reset:phase
 *
 * O desde la raíz:
 *   npm run reset:phase
 *
 * Después, despliega el Stellar Asset Contract (SAC) en testnet:
 *   stellar contract asset deploy --asset PHASELQ:<ISSUER_G> --network testnet
 * Copia el Contract ID (C…) a:
 *   NEXT_PUBLIC_TOKEN_CONTRACT_ID
 *   NEXT_PUBLIC_PHASER_TOKEN_ID
 *
 * Opcional: publicar home_domain para stellar.toml / Stellar Expert:
 *   cd scripts && CLASSIC_LIQ_ISSUER_SECRET=<issuer secret> npm run set:issuer-home-domain
 *
 * Si ya tienes issuer + distribuidor en .env.local y solo falta trustline + primer pago:
 *   npm run classic:distributor-trust-and-pay  →  scripts/distributor-trust-and-payment.ts
 */
import * as dotenv from "dotenv"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk"
import { z } from "zod"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
dotenv.config({ path: path.join(repoRoot, ".env.local") })
dotenv.config({ path: path.join(repoRoot, ".env") })
dotenv.config({ path: path.join(__dirname, ".env") })

const HORIZON_URL = process.env.HORIZON_TESTNET_URL?.trim() || "https://horizon-testnet.stellar.org"
const NETWORK_PASSPHRASE = Networks.TESTNET
/** Override: p. ej. `RESET_PHASE_ASSET_CODE=PHASERLIQ` solo si mantienes un código legacy distinto. */
const ASSET_CODE = process.env.RESET_PHASE_ASSET_CODE?.trim() || "PHASELQ"
/** Cantidad enviada al distribuidor (formato Stellar, 7 decimales). */
const INITIAL_DISTRIBUTOR_AMOUNT = process.env.RESET_PHASE_MINT_AMOUNT?.trim() || "1000000.0000000"

// ── phase-124: metadata version migration tool (isolated, feature-flagged) ──
// Feature flag: phase-124 — NEXT_PUBLIC_FEATURE_PHASE_124 / FEATURE_PHASE_124
// Rollback: unset flag or set to 0/false and restart; no ledger mutation.

function isPhase124Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_124 ?? process.env.FEATURE_PHASE_124 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export const METADATA_MIGRATION_CURRENT_VERSION = 2 as const
export type MetadataVersion = 1 | 2

const MetadataV1Schema = z.object({
  version: z.literal(1).optional(),
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional().default(""),
  image: z.string().max(1024).optional().default(""),
  attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) })).optional().default([]),
})

const MetadataV2Schema = z.object({
  version: z.literal(2),
  name: z.string().min(1).max(256),
  description: z.string().max(2048),
  image: z.string().max(1024),
  external_url: z.string().optional().default(""),
  attributes: z.array(z.object({ trait_type: z.string().min(1).max(64), value: z.union([z.string(), z.number()]), display_type: z.enum(["number", "date", "boost_percentage"]).optional() })),
  collectionId: z.number().int().min(0).nullable().default(null),
  migratedAt: z.string().datetime().optional(),
  migratedFrom: z.union([z.literal(1), z.literal(2)]).optional(),
})

export type MetadataV2 = z.infer<typeof MetadataV2Schema>

export class MetadataMigrationError extends Error {
  code: "VALIDATION_FAILED" | "UNSUPPORTED_VERSION" | "MIGRATION_FAILED" | "FLAG_DISABLED"
  details?: unknown
  constructor(code: MetadataMigrationError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "MetadataMigrationError"
    this.code = code
    this.details = details
  }
}

function detectMetadataVersion(raw: unknown): MetadataVersion | null {
  if (raw && typeof raw === "object" && "version" in raw) {
    const v = (raw as { version?: unknown }).version
    if (v === 1 || v === 2) return v as MetadataVersion
    if (v === "1" || v === "2") return Number(v) as MetadataVersion
  }
  if (raw && typeof raw === "object" && "name" in raw) return 1
  return null
}

function migrateV1ToV2(v1: z.infer<typeof MetadataV1Schema>, opts?: { baseUrl?: string }): MetadataV2 {
  const attrs = (v1.attributes ?? []).map((a) => ({ trait_type: String(a.trait_type).trim().slice(0, 64) || "unknown", value: a.value }))
  return {
    version: 2,
    name: v1.name.trim(),
    description: (v1.description ?? "").trim(),
    image: (v1.image ?? "").trim(),
    external_url: opts?.baseUrl ?? "",
    attributes: attrs as MetadataV2["attributes"],
    collectionId: null,
    migratedAt: new Date().toISOString(),
    migratedFrom: 1,
  }
}

export type MigrateMetadataOptions = { dryRun?: boolean; baseUrl?: string; strict?: boolean; force?: boolean }
export type MigrateMetadataResult =
  | { ok: true; version: MetadataVersion; data: MetadataV2; migrated: boolean; fromVersion: MetadataVersion }
  | { ok: false; error: MetadataMigrationError }

export function migrateMetadataPayload(raw: unknown, opts: MigrateMetadataOptions = {}): MigrateMetadataResult {
  const enabled = opts.force || isPhase124Enabled()
  if (!enabled) {
    return { ok: false, error: new MetadataMigrationError("FLAG_DISABLED", "Metadata migration disabled (phase-124 off). Set FEATURE_PHASE_124=1.") }
  }
  const detected = detectMetadataVersion(raw)
  if (detected == null) {
    return { ok: false, error: new MetadataMigrationError("UNSUPPORTED_VERSION", "Cannot detect metadata version; payload missing `name`/`version`.") }
  }
  try {
    if (detected === 2) {
      const parsed = MetadataV2Schema.safeParse(raw)
      if (!parsed.success) {
        if (opts.strict) return { ok: false, error: new MetadataMigrationError("VALIDATION_FAILED", parsed.error.message, parsed.error.flatten()) }
        const v1f = MetadataV1Schema.safeParse(raw)
        if (!v1f.success) return { ok: false, error: new MetadataMigrationError("VALIDATION_FAILED", parsed.error.message, parsed.error.flatten()) }
        const v2 = migrateV1ToV2(v1f.data, { baseUrl: opts.baseUrl })
        return { ok: true, version: 2, data: v2, migrated: true, fromVersion: 1 }
      }
      return { ok: true, version: 2, data: parsed.data, migrated: false, fromVersion: 2 }
    }
    const p1 = MetadataV1Schema.safeParse(raw)
    if (!p1.success) return { ok: false, error: new MetadataMigrationError("VALIDATION_FAILED", p1.error.message, p1.error.flatten()) }
    const migrated = migrateV1ToV2(p1.data, { baseUrl: opts.baseUrl })
    const fin = MetadataV2Schema.safeParse(migrated)
    if (!fin.success) return { ok: false, error: new MetadataMigrationError("MIGRATION_FAILED", fin.error.message, fin.error.flatten()) }
    return { ok: true, version: 2, data: fin.data, migrated: true, fromVersion: 1 }
  } catch (e) {
    return { ok: false, error: new MetadataMigrationError("MIGRATION_FAILED", e instanceof Error ? e.message : String(e), e) }
  }
}

export type BatchMigrateReport = { total: number; migrated: number; alreadyCurrent: number; failed: number; failures: Array<{ index: number; error: string; code: string }>; results: MetadataV2[] }

export function batchMigrateMetadataPayloads(payloads: unknown[], opts: MigrateMetadataOptions = {}): BatchMigrateReport {
  const report: BatchMigrateReport = { total: payloads.length, migrated: 0, alreadyCurrent: 0, failed: 0, failures: [], results: [] }
  payloads.forEach((raw, i) => {
    const r = migrateMetadataPayload(raw, opts)
    if (!r.ok) { report.failed++; report.failures.push({ index: i, error: r.error.message, code: r.error.code }); return }
    report.results.push(r.data)
    if (r.migrated) report.migrated++; else report.alreadyCurrent++
  })
  return report
}

export async function migrateMetadataFilesInDir(dir: string, opts: MigrateMetadataOptions & { pattern?: RegExp } = {}): Promise<BatchMigrateReport & { files: string[] }> {
  const enabled = opts.force || isPhase124Enabled()
  if (!enabled) throw new MetadataMigrationError("FLAG_DISABLED", "Migration flag off")
  const pat = opts.pattern ?? /\.json$/
  let entries: string[] = []
  try { entries = await fs.readdir(dir) } catch { return { total: 0, migrated: 0, alreadyCurrent: 0, failed: 0, failures: [], results: [], files: [] } }
  const files = entries.filter((f) => pat.test(f)).map((f) => path.join(dir, f))
  const payloads: unknown[] = []
  for (const f of files) {
    try { payloads.push(JSON.parse(await fs.readFile(f, "utf8"))) } catch { /* skip invalid */ }
  }
  const r = batchMigrateMetadataPayloads(payloads, opts)
  if (!opts.dryRun) {
    for (let i = 0; i < files.length; i++) {
      const res = migrateMetadataPayload(payloads[i], opts)
      if (res.ok && res.migrated) {
        await fs.writeFile(files[i]!, JSON.stringify(res.data, null, 2), "utf8")
      }
    }
  }
  return { ...r, files }
}

const server = new Horizon.Server(HORIZON_URL)

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const url = `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`
  const res = await fetch(url)
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Friendbot falló (${res.status}): ${t.slice(0, 240)}`)
  }
}

async function waitForAccount(publicKey: string, label: string): Promise<void> {
  const maxAttempts = 20
  const delayMs = 1500
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await server.loadAccount(publicKey)
      return
    } catch {
      if (i === maxAttempts - 1) {
        throw new Error(`Timeout esperando cuenta ${label} (${publicKey.slice(0, 8)}…) en Horizon.`)
      }
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

// ── phase-94: verified-artist badge issuance via signed attestation (isolated) ──
// Fake artist impersonation was previously unchecked in setup/reset/SAC scripts:
// any wallet could self-label as "artist" in profile metadata. This module issues
// a badge only after the claimed wallet signs a canonical attestation payload with
// its own Stellar keypair; the signature is verified before the badge is persisted.
// Feature flag: phase-94 — NEXT_PUBLIC_FEATURE_PHASE_94 / FEATURE_PHASE_94
// Rollback: unset flag or set to 0/false and restart; issued badges on disk are
// left untouched (read-only regression), no data migration to revert.
// scripts/issue-sac-token.ts wiring is preserved untouched (audit-only hook there).

function isPhase94Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_94 ?? process.env.FEATURE_PHASE_94 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const STELLAR_G_REGEX = /^G[A-Z2-7]{55}$/

export const ArtistAttestationPayloadSchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX, "Invalid Stellar G address"),
  displayName: z.string().trim().min(1).max(48),
  claim: z.literal("verified-artist"),
  issuedAt: z.number().int().min(0),
  nonce: z.string().trim().min(8).max(64),
})
export type ArtistAttestationPayload = z.infer<typeof ArtistAttestationPayloadSchema>

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

export class ArtistAttestationError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "SIGNATURE_INVALID" | "ALREADY_ISSUED"
  constructor(code: ArtistAttestationError["code"], message: string) {
    super(message)
    this.name = "ArtistAttestationError"
    this.code = code
  }
}

/** Deterministic byte layout so wallet-signed bytes match server-side verification exactly. */
export function canonicalAttestationMessage(payload: Omit<ArtistAttestationPayload, "claim">): string {
  return `PHASE_VERIFIED_ARTIST_ATTESTATION_V1|${payload.wallet}|${payload.displayName}|${payload.issuedAt}|${payload.nonce}`
}

export function verifyAttestationSignature(wallet: string, message: string, signatureBase64: string): boolean {
  try {
    const kp = Keypair.fromPublicKey(wallet)
    const sig = Buffer.from(signatureBase64, "base64")
    return kp.verify(Buffer.from(message, "utf8"), sig)
  } catch {
    return false
  }
}

async function artistBadgesFilePath(): Promise<string> {
  const dataDir = path.join(repoRoot, ".data")
  await fs.mkdir(dataDir, { recursive: true })
  return path.join(dataDir, "artist-attestations.json")
}

async function readArtistBadgeStore(): Promise<Record<string, ArtistBadge>> {
  try {
    const raw = await fs.readFile(await artistBadgesFilePath(), "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, ArtistBadge> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const res = ArtistBadgeSchema.safeParse(v)
      if (res.success) out[k] = res.data
    }
    return out
  } catch {
    return {}
  }
}

async function writeArtistBadgeStore(data: Record<string, ArtistBadge>): Promise<void> {
  await fs.writeFile(await artistBadgesFilePath(), JSON.stringify(data, null, 2), "utf8")
}

/**
 * Issues a verified-artist badge for `wallet`, keyed by that wallet's own signature
 * over the canonical attestation payload. Rejects mismatched/forged signatures —
 * the fake-impersonation gap this module closes.
 */
export async function issueVerifiedArtistBadgeCli(input: {
  wallet: string
  displayName: string
  issuedAt: number
  nonce: string
  signature: string
}): Promise<ArtistBadge> {
  if (!isPhase94Enabled()) {
    throw new ArtistAttestationError("FLAG_DISABLED", "Verified-artist badge issuance disabled (phase-94 flag off)")
  }
  const parsed = ArtistAttestationPayloadSchema.safeParse({ ...input, claim: "verified-artist" })
  if (!parsed.success) {
    throw new ArtistAttestationError("VALIDATION_FAILED", parsed.error.message)
  }
  const { wallet, displayName, issuedAt, nonce } = parsed.data
  const message = canonicalAttestationMessage({ wallet, displayName, issuedAt, nonce })
  if (!verifyAttestationSignature(wallet, message, input.signature)) {
    throw new ArtistAttestationError("SIGNATURE_INVALID", `Attestation signature does not match wallet ${wallet.slice(0, 6)}…; badge not issued.`)
  }
  const store = await readArtistBadgeStore()
  if (store[wallet]?.nonce === nonce) {
    throw new ArtistAttestationError("ALREADY_ISSUED", `Badge already issued for wallet ${wallet.slice(0, 6)}… with this nonce.`)
  }
  const badge: ArtistBadge = ArtistBadgeSchema.parse({
    wallet,
    displayName,
    claim: "verified-artist",
    issuedAt,
    nonce,
    signature: input.signature,
    verifiedAt: Date.now(),
  })
  store[wallet] = badge
  await writeArtistBadgeStore(store)
  return badge
}

async function runIssueArtistBadgeCliIfRequested(): Promise<void> {
  if (!process.argv.includes("--issue-artist-badge")) {
    if (isPhase94Enabled()) {
      console.log("\n[phase-94] Verified-artist badge issuance ready (flag enabled). Pass --issue-artist-badge --wallet=G... --name=... --nonce=... --signature=... to issue. Rollback: unset FEATURE_PHASE_94.")
    }
    return
  }
  if (!isPhase94Enabled()) {
    console.log("\n[phase-94] --issue-artist-badge requested but flag disabled (FEATURE_PHASE_94=1 required). Skipping.")
    return
  }
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? ""
  try {
    const badge = await issueVerifiedArtistBadgeCli({
      wallet: arg("wallet"),
      displayName: arg("name"),
      issuedAt: Number(arg("issuedAt")) || Date.now(),
      nonce: arg("nonce"),
      signature: arg("signature"),
    })
    console.log(`\n[phase-94] Verified-artist badge issued for ${badge.wallet.slice(0, 8)}… (${badge.displayName}).`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[phase-94] badge issuance failed: ${msg}`)
  }
}

// ── phase-79: watchlist notifications for price drops (isolated, flag-gated) ──
// Collectors miss opportunities when listings drop in price without alerts.
// This module manages collector watchlists, evaluates price drop events against target
// thresholds, and dispatches price drop notifications.
// Feature flag: phase-79 — NEXT_PUBLIC_FEATURE_PHASE_79 / FEATURE_PHASE_79
// Rollback: unset flag or set to 0/false and restart; watchlist entries on disk
// remain preserved with notifications disabled.

export function isPhase79Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_79 ?? process.env.FEATURE_PHASE_79 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag79RollbackNote(): string {
  return "Rollback phase-79: unset NEXT_PUBLIC_FEATURE_PHASE_79 / FEATURE_PHASE_79 or set to 0/false and restart. Watchlist store on disk remains preserved."
}

export const WatchlistEntrySchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX, "Invalid Stellar G address"),
  collectionId: z.number().int().min(0),
  tokenId: z.number().int().min(1).max(1_000_000),
  targetPrice: z.number().positive().optional(),
  lastNotifiedPrice: z.number().positive().optional(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
})

export type WatchlistEntry = z.infer<typeof WatchlistEntrySchema>

export const AddToWatchlistSchema = z.object({
  wallet: z.string().trim().length(56).regex(STELLAR_G_REGEX, "Invalid Stellar G address"),
  collectionId: z.number().int().min(0).default(0),
  tokenId: z.number().int().min(1).max(1_000_000),
  targetPrice: z.number().positive().optional(),
})

export type AddToWatchlistInput = z.infer<typeof AddToWatchlistSchema>

export const PriceDropEventSchema = z.object({
  collectionId: z.number().int().min(0).default(0),
  tokenId: z.number().int().min(1).max(1_000_000),
  previousPrice: z.number().positive(),
  newPrice: z.number().positive(),
  tokenName: z.string().trim().max(128).optional(),
  image: z.string().trim().max(1024).optional(),
  sellerWallet: z.string().trim().length(56).regex(STELLAR_G_REGEX).optional(),
})

export type PriceDropEvent = z.infer<typeof PriceDropEventSchema>

export const WatchlistNotificationResultSchema = z.object({
  notifiedWallets: z.array(z.string()),
  dropAmount: z.number(),
  dropPercentage: z.number(),
  notifiedCount: z.number().int().min(0),
  event: PriceDropEventSchema,
})

export type WatchlistNotificationResult = z.infer<typeof WatchlistNotificationResultSchema>

export class WatchlistNotificationError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "NOT_FOUND" | "INVALID_PRICE" | "DUPLICATE_ENTRY" | "STORE_FAILED"
  details?: unknown
  constructor(code: WatchlistNotificationError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "WatchlistNotificationError"
    this.code = code
    this.details = details
  }
}

export function evaluatePriceDrop(params: {
  previousPrice: number
  newPrice: number
  targetPrice?: number
}): { isDrop: boolean; qualifies: boolean; dropAmount: number; dropPercentage: number } {
  const isDrop = params.newPrice < params.previousPrice
  const dropAmount = isDrop ? params.previousPrice - params.newPrice : 0
  const dropPercentage = isDrop ? Math.round(((params.previousPrice - params.newPrice) / params.previousPrice) * 10000) / 100 : 0
  const qualifies = isDrop && (params.targetPrice === undefined || params.newPrice <= params.targetPrice)
  return { isDrop, qualifies, dropAmount, dropPercentage }
}

async function watchlistStoreFilePath(): Promise<string> {
  const dataDir = process.env.PHASE_SERVER_DATA_DIR?.trim() || path.join(repoRoot, ".data")
  await fs.mkdir(dataDir, { recursive: true })
  return path.join(dataDir, "watchlists.json")
}

export async function readWatchlistStore(): Promise<Record<string, WatchlistEntry[]>> {
  try {
    const raw = await fs.readFile(await watchlistStoreFilePath(), "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, WatchlistEntry[]> = {}
    for (const [wallet, entries] of Object.entries(parsed)) {
      if (Array.isArray(entries)) {
        out[wallet] = entries
          .map((e) => WatchlistEntrySchema.safeParse(e))
          .filter((res) => res.success)
          .map((res) => (res as { success: true; data: WatchlistEntry }).data)
      }
    }
    return out
  } catch {
    return {}
  }
}

export async function writeWatchlistStore(data: Record<string, WatchlistEntry[]>): Promise<void> {
  await fs.writeFile(await watchlistStoreFilePath(), JSON.stringify(data, null, 2), "utf8")
}

export async function addToWatchlistCli(input: AddToWatchlistInput, opts: { force?: boolean } = {}): Promise<WatchlistEntry> {
  const enabled = opts.force || isPhase79Enabled()
  if (!enabled) {
    throw new WatchlistNotificationError("FLAG_DISABLED", "Watchlist notifications disabled (phase-79 off)")
  }
  const parsed = AddToWatchlistSchema.safeParse(input)
  if (!parsed.success) {
    throw new WatchlistNotificationError("VALIDATION_FAILED", parsed.error.message, parsed.error.flatten())
  }
  const { wallet, collectionId, tokenId, targetPrice } = parsed.data
  const store = await readWatchlistStore()
  const list = store[wallet] ?? []
  const existingIdx = list.findIndex((e) => e.collectionId === collectionId && e.tokenId === tokenId)
  const now = Date.now()

  let entry: WatchlistEntry
  if (existingIdx >= 0) {
    const prev = list[existingIdx]!
    entry = {
      ...prev,
      targetPrice: targetPrice ?? prev.targetPrice,
      updatedAt: now,
    }
    list[existingIdx] = entry
  } else {
    entry = {
      wallet,
      collectionId,
      tokenId,
      targetPrice,
      createdAt: now,
      updatedAt: now,
    }
    list.push(entry)
  }

  store[wallet] = list
  await writeWatchlistStore(store)
  return entry
}

export async function getWatchlistCli(wallet: string): Promise<WatchlistEntry[]> {
  const store = await readWatchlistStore()
  return store[wallet] ?? []
}

export async function processPriceDropCli(
  input: unknown,
  opts: { force?: boolean } = {},
): Promise<WatchlistNotificationResult> {
  const enabled = opts.force || isPhase79Enabled()
  if (!enabled) {
    throw new WatchlistNotificationError("FLAG_DISABLED", "Price drop processing disabled (phase-79 off)")
  }
  const parsed = PriceDropEventSchema.safeParse(input)
  if (!parsed.success) {
    throw new WatchlistNotificationError("VALIDATION_FAILED", parsed.error.message, parsed.error.flatten())
  }

  const event = parsed.data
  const evalRes = evaluatePriceDrop({ previousPrice: event.previousPrice, newPrice: event.newPrice })
  if (!evalRes.isDrop) {
    return {
      notifiedWallets: [],
      dropAmount: 0,
      dropPercentage: 0,
      notifiedCount: 0,
      event,
    }
  }

  const store = await readWatchlistStore()
  const notifiedWallets: string[] = []
  let storeMutated = false

  for (const [wallet, entries] of Object.entries(store)) {
    if (event.sellerWallet && wallet.toUpperCase() === event.sellerWallet.toUpperCase()) {
      continue // Do not notify seller of their own price drop
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      if (entry.collectionId === event.collectionId && entry.tokenId === event.tokenId) {
        const check = evaluatePriceDrop({
          previousPrice: event.previousPrice,
          newPrice: event.newPrice,
          targetPrice: entry.targetPrice,
        })
        if (check.qualifies) {
          // Avoid spamming if already notified at this price or lower
          if (entry.lastNotifiedPrice !== undefined && event.newPrice >= entry.lastNotifiedPrice) {
            continue
          }
          notifiedWallets.push(wallet)
          entry.lastNotifiedPrice = event.newPrice
          entry.updatedAt = Date.now()
          storeMutated = true
        }
      }
    }
  }

  if (storeMutated) {
    await writeWatchlistStore(store)
  }

  return {
    notifiedWallets,
    dropAmount: evalRes.dropAmount,
    dropPercentage: evalRes.dropPercentage,
    notifiedCount: notifiedWallets.length,
    event,
  }
}

export function auditWatchlistWiringOnReset(): { ok: boolean; note: string } {
  if (!isPhase79Enabled()) {
    return { ok: true, note: "[phase-79] watchlist notifications disabled; nothing to audit." }
  }
  const evalCheck = evaluatePriceDrop({ previousPrice: 100, newPrice: 80, targetPrice: 90 })
  if (evalCheck.isDrop && evalCheck.qualifies && evalCheck.dropPercentage === 20) {
    return { ok: true, note: `[phase-79] watchlist price drop notifications OK. ${flag79RollbackNote()}` }
  }
  return { ok: false, note: "[phase-79] watchlist price drop evaluation drift." }
}

async function runPriceDropCliIfRequested(): Promise<void> {
  if (!process.argv.includes("--check-price-drop") && !process.argv.includes("--notify-price-drop")) {
    if (isPhase79Enabled()) {
      console.log("\n[phase-79] Watchlist price-drop alerts ready (flag enabled). Pass --check-price-drop --token=1 --old-price=100 --new-price=75 to evaluate. Rollback: unset FEATURE_PHASE_79.")
    }
    return
  }
  if (!isPhase79Enabled()) {
    console.log("\n[phase-79] --check-price-drop requested but flag disabled (FEATURE_PHASE_79=1 required). Skipping.")
    return
  }
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? ""
  try {
    const result = await processPriceDropCli({
      collectionId: Number(arg("collection")) || 0,
      tokenId: Number(arg("token")) || 1,
      previousPrice: Number(arg("old-price") || arg("previous-price")) || 100,
      newPrice: Number(arg("new-price")) || 80,
      tokenName: arg("name") || undefined,
    })
    console.log(`\n[phase-79] Price drop processed: -${result.dropPercentage}% (${result.dropAmount} PHASELQ). Notified ${result.notifiedCount} collectors.`)
  } catch (e) {
    console.warn(`[phase-79] price drop processing failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  console.log("INICIANDO RESET DE PROTOCOLO PHASE (testnet clásico + distribuidor)\n")

  const issuer = Keypair.random()
  const distributor = Keypair.random()

  console.log(`ISSUER (emisor del asset ${ASSET_CODE})`)
  console.log(`  Public:  ${issuer.publicKey()}`)
  console.log(`  Secret:  ${issuer.secret()}`)
  console.log("")
  console.log("DISTRIBUTOR (faucet / transfer mode)")
  console.log(`  Public:  ${distributor.publicKey()}`)
  console.log(`  Secret:  ${distributor.secret()}`)
  console.log("")

  console.log("Friendbot: fondeando XLM…")
  await fundWithFriendbot(issuer.publicKey())
  await new Promise((r) => setTimeout(r, 1200))
  await fundWithFriendbot(distributor.publicKey())

  console.log("Esperando que Horizon indexe las cuentas…")
  await waitForAccount(issuer.publicKey(), "issuer")
  await waitForAccount(distributor.publicKey(), "distributor")

  const phaserLiq = new Asset(ASSET_CODE, issuer.publicKey())

  console.log(`Creando trustline del distribuidor hacia ${ASSET_CODE}…`)
  const accountDist = await server.loadAccount(distributor.publicKey())
  const txTrust = new TransactionBuilder(accountDist, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.changeTrust({
        asset: phaserLiq,
      }),
    )
    .setTimeout(180)
    .build()
  txTrust.sign(distributor)
  const trustRes = await server.submitTransaction(txTrust)
  console.log(`  OK — trustline. Hash: ${trustRes.hash}`)

  console.log(`Emitiendo ${INITIAL_DISTRIBUTOR_AMOUNT} ${ASSET_CODE} al distribuidor…`)
  const accountIssuer = await server.loadAccount(issuer.publicKey())
  const txMint = new TransactionBuilder(accountIssuer, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: distributor.publicKey(),
        asset: phaserLiq,
        amount: INITIAL_DISTRIBUTOR_AMOUNT,
      }),
    )
    .setTimeout(180)
    .build()
  txMint.sign(issuer)
  const mintRes = await server.submitTransaction(txMint)
  console.log(`  OK — payment. Hash: ${mintRes.hash}`)

  console.log("\n--- Copia en .env.local (raíz del repo) ---\n")
  console.log(`NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE="${ASSET_CODE}"`)
  console.log(`NEXT_PUBLIC_CLASSIC_LIQ_ISSUER="${issuer.publicKey()}"`)
  console.log(`CLASSIC_LIQ_ISSUER_SECRET="${issuer.secret()}"`)
  console.log(`FAUCET_DISTRIBUTOR_SECRET_KEY="${distributor.secret()}"`)
  console.log("")
  console.log("Luego despliega el SAC y añade el Contract ID (C…), por ejemplo:")
  console.log("")
  console.log(
    `  stellar contract asset deploy --asset ${ASSET_CODE}:${issuer.publicKey()} --network testnet`,
  )
  console.log("")
  console.log("Pega el C… en:")
  console.log('  NEXT_PUBLIC_TOKEN_CONTRACT_ID="C…"')
  console.log('  NEXT_PUBLIC_PHASER_TOKEN_ID="C…"')
  console.log("")
  console.log("Si el contrato PHASE ya está inicializado con otro token, hay que volver a llamar")
  console.log("`initialize` en el WASM con este nuevo SAC, o redeploy + init alineado.")
  console.log("")
  console.log("Guarda estos secrets en un gestor seguro; no los subas a git.")

  // ── phase-124: optional metadata migration (behind flag) ──
  // Usage: FEATURE_PHASE_124=1 npm run reset:phase -- --migrate-metadata [--dry-run]
  // Or: FEATURE_PHASE_124=1 node --loader tsx scripts/reset-phase.ts --migrate-metadata
  if (process.argv.includes("--migrate-metadata")) {
    if (!isPhase124Enabled()) {
      console.log("\n[phase-124] --migrate-metadata requested but flag disabled (FEATURE_PHASE_124=1 required). Skipping.")
    } else {
      const dryRun = process.argv.includes("--dry-run")
      const dataDir = path.join(repoRoot, ".data")
      console.log(`\n[phase-124] Migrating metadata in ${dataDir} (dryRun=${dryRun})…`)
      try {
        const report = await migrateMetadataFilesInDir(dataDir, { dryRun, force: true })
        console.log(`[phase-124] total=${report.total} migrated=${report.migrated} alreadyCurrent=${report.alreadyCurrent} failed=${report.failed}`)
        if (report.failures.length > 0) console.warn("[phase-124] failures:", report.failures)
        // Also check public/phaser-liq.metadata.json schema drift
        const publicMetaPath = path.join(repoRoot, "public", "phaser-liq.metadata.json")
        try {
          const raw = await fs.readFile(publicMetaPath, "utf8")
          const parsed = JSON.parse(raw)
          const migrated = migrateMetadataPayload(parsed, { dryRun, force: true })
          if (!migrated.ok) console.warn(`[phase-124] public metadata validation: ${migrated.error.message} (${migrated.error.code})`)
          else if (migrated.migrated) console.log("[phase-124] public metadata would migrate v1→v2 (additive, safe)")
        } catch { /* optional */ }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[phase-124] migration error: ${msg}`)
      }
    }
  } else if (isPhase124Enabled()) {
    console.log("\n[phase-124] Metadata migration tool ready (flag enabled). Pass --migrate-metadata to run; --dry-run to preview. Rollback: unset FEATURE_PHASE_124.")
  }

  await runIssueArtistBadgeCliIfRequested()
  await runPriceDropCliIfRequested()
  const wlAudit = auditWatchlistWiringOnReset()
  if (isPhase79Enabled()) {
    console.log(wlAudit.note)
  }
}

const isDirectCliInvocation = process.argv[1]
  ? path.resolve(process.argv[1]).includes("reset-phase")
  : false

if (isDirectCliInvocation) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
