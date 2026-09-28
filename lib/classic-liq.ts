import {
  Account,
  Asset,
  BASE_FEE,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk"
import { DEFAULT_LIQUIDITY_ASSET_CODE } from "@/lib/phase-contract-defaults"
import { HORIZON_URL } from "@/lib/phase-protocol"
import { isFeatureEnabled } from "@/lib/feature-flags"

export type ClassicLiqAsset = {
  code: string
  issuer: string
}

export type ClassicLiqWalletStatus = {
  accountExists: boolean
  hasTrustline: boolean
  balance: string | null
}

type HorizonBalance = {
  balance?: string
  asset_type?: string
  asset_code?: string
  asset_issuer?: string
}

type HorizonAccountResponse = {
  sequence?: string
  balances?: HorizonBalance[]
}

/** Cuerpo JSON de `GET /accounts/:id` en Horizon testnet (secuencia + balances). */
export type TestnetHorizonAccountJson = HorizonAccountResponse

export function nativeXlmBalanceFromHorizonAccount(data: TestnetHorizonAccountJson): number {
  const native = (data.balances ?? []).find((b) => b.asset_type === "native")
  const parsed = Number.parseFloat(native?.balance ?? "0")
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Una sola lectura de cuenta antes de armar changeTrust + firmar (menos awaits → mejor para Albedo, xBull, etc.).
 */
export async function fetchTestnetHorizonAccountJson(walletAddress: string): Promise<TestnetHorizonAccountJson> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    throw new Error("Invalid wallet address.")
  }
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(walletAddress)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (res.status === 404) {
    throw new Error("Account not found on testnet. Fund with test XLM first.")
  }
  if (!res.ok) {
    throw new Error(`Could not read account (${res.status}).`)
  }
  return (await res.json()) as TestnetHorizonAccountJson
}

/** Arma el XDR de changeTrust cuando ya tenés la secuencia (p. ej. tras un único fetch Horizon). */
export function buildClassicTrustlineXdrFromSequence(
  walletAddress: string,
  asset: ClassicLiqAsset,
  sequence: string,
): string {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    throw new Error("Invalid wallet address.")
  }
  const seq = sequence.trim()
  if (!seq) throw new Error("Missing account sequence.")

  const source = new Account(walletAddress, seq)
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: createClassicAsset(asset),
      }),
    )
    .setTimeout(120)
    .build()

  return tx.toXDR()
}

/** Emisor clásico PHASELQ en testnet (Stellar Expert: PHASELQ-GD7V…). */
export const DEFAULT_CLASSIC_PHASER_LIQ_ISSUER =
  "GD7VAD4VDVHASKZIJPRORMXLML4RSVLRANYNRCCBWLO5ACOSYQZBSUFI"

/** Emisor del asset clásico **PHASERLIQ** (código legacy; distinto de PHASELQ). */
export const LEGACY_PHASERLIQ_ISSUER =
  "GAXRPE5JXPY7RJONMCEWFXELVWDW3CSA7H6LAGYKTOYLFQQDJ5DT4GNS"

/** Para `stellar.toml`: siempre un issuer G válido para que wallets enlacen trustline ↔ fila CURRENCIES ↔ image. */
export function classicLiqIssuerForStellarToml(): string {
  const fromEnv = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER?.trim() ?? ""
  if (fromEnv && StrKey.isValidEd25519PublicKey(fromEnv)) return fromEnv
  return DEFAULT_CLASSIC_PHASER_LIQ_ISSUER
}

export function classicLiqCodeForStellarToml(): string {
  return process.env.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE?.trim() || DEFAULT_LIQUIDITY_ASSET_CODE
}

export function classicLiqAssetConfigFromPublicEnv(): ClassicLiqAsset | null {
  const code = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE?.trim() ?? ""
  const issuer = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER?.trim() ?? ""
  if (!code || !issuer) return null
  if (!StrKey.isValidEd25519PublicKey(issuer)) return null
  return { code, issuer }
}

/**
 * Contract ID Soroban (C…) del Stellar Asset Contract que envuelve el par clásico (code + issuer).
 * Debe ser el mismo que `NEXT_PUBLIC_TOKEN_CONTRACT_ID` / `TOKEN_CONTRACT_ID` si usas ese asset como PHASELQ.
 * Compruébalo en Stellar Expert: cuenta emisora → sección Assets → enlace «Contract ID».
 */
export function expectedClassicPhaserLiqSorobanContractId(): string {
  return new Asset(classicLiqCodeForStellarToml(), classicLiqIssuerForStellarToml()).contractId(Networks.TESTNET)
}

/** Una fila [[CURRENCIES]] en stellar.toml (SAC distinto por emisor). */
export type StellarTomlPhaserLiqCurrencyRow = {
  code: string
  issuer: string
  script: string
}

/**
 * Filas `[[CURRENCIES]]` para stellar.toml: cada par **(code, issuer)** correcto.
 * Antes se repetía el código PHASELQ para todos los emisores; GAXR emitió **PHASERLIQ**, no PHASELQ → Stellar Expert no enlazaba metadata.
 *
 * Stellar Expert solo muestra TOML si la cuenta emisora tiene `home_domain` apuntando al host donde está `/.well-known/stellar.toml`.
 */
export function stellarTomlPhaserLiqCurrencyRows(): StellarTomlPhaserLiqCurrencyRow[] {
  const rows: StellarTomlPhaserLiqCurrencyRow[] = []
  const seen = new Set<string>()

  const pushPair = (assetCode: string, issuerG: string) => {
    const iss = issuerG.trim()
    const c = assetCode.trim()
    if (!c || !StrKey.isValidEd25519PublicKey(iss)) return
    const key = `${c}|${iss}`
    if (seen.has(key)) return
    seen.add(key)
    try {
      const asset = new Asset(c, iss)
      rows.push({
        code: c,
        issuer: iss,
        script: asset.contractId(Networks.TESTNET),
      })
    } catch {
      /* combinación inválida para Asset */
    }
  }

  const primaryIssuer = classicLiqIssuerForStellarToml()
  const primaryCode = classicLiqCodeForStellarToml()

  pushPair(primaryCode, primaryIssuer)
  pushPair("PHASERLIQ", LEGACY_PHASERLIQ_ISSUER)

  const defaultIssuer = DEFAULT_CLASSIC_PHASER_LIQ_ISSUER
  const defaultCode = DEFAULT_LIQUIDITY_ASSET_CODE
  if (defaultIssuer !== primaryIssuer || defaultCode !== primaryCode) {
    pushPair(defaultCode, defaultIssuer)
  }

  return rows
}

export function isClassicLiqEnabledPublic(): boolean {
  return classicLiqAssetConfigFromPublicEnv() != null
}

export function createClassicAsset(asset: ClassicLiqAsset) {
  return new Asset(asset.code, asset.issuer)
}

export async function readClassicWalletStatus(
  walletAddress: string,
  asset: ClassicLiqAsset,
): Promise<ClassicLiqWalletStatus> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    return { accountExists: false, hasTrustline: false, balance: null }
  }
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(walletAddress)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (res.status === 404) {
    return { accountExists: false, hasTrustline: false, balance: null }
  }
  if (!res.ok) {
    throw new Error(`Horizon account lookup failed (${res.status})`)
  }
  const data = (await res.json()) as HorizonAccountResponse
  const balances = Array.isArray(data.balances) ? data.balances : []
  const line = balances.find(
    (b) => b.asset_type !== "native" && b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  )
  return {
    accountExists: true,
    hasTrustline: Boolean(line),
    balance: typeof line?.balance === "string" ? line.balance : null,
  }
}

/**
 * Read native XLM balance from Horizon
 */
export async function readNativeXlmBalance(walletAddress: string): Promise<number | null> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    return null
  }
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(walletAddress)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) {
    return null
  }
  const data = (await res.json()) as HorizonAccountResponse
  return nativeXlmBalanceFromHorizonAccount(data)
}

export async function buildClassicTrustlineTransactionXdr(
  walletAddress: string,
  asset: ClassicLiqAsset,
): Promise<string> {
  const accountJson = await fetchTestnetHorizonAccountJson(walletAddress)
  const sequence = accountJson.sequence?.trim()
  if (!sequence) throw new Error("Missing account sequence.")
  return buildClassicTrustlineXdrFromSequence(walletAddress, asset, sequence)
}

export function parseSignedTxXdr(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const r = result as { signedTxXdr?: string; signedTransaction?: string }
  return r.signedTxXdr || r.signedTransaction || null
}

import { z } from "zod"

// ─── phase-119: CID content-addressing cache with integrity checks ──────────
// Isolated, flag-gated. Re-pinned content is now verified for tampering before
// cache-write and before trustline flows. When flag off, helpers are no-ops
// and trustline path has zero extra latency.
// Rollback: unset phase-119 → cache disabled, verification skipped.
// NOTE: static re-export removed to avoid bundling node:fs into client (forge).
// Use dynamic import("@/lib/cid-cache") on server when needed; type exports
// below are erased at build time.

export type { CidCacheEntry, CidIntegrityCheck } from "@/lib/cid-cache"

// ─── phase-144 (Module #44): x402 dead-letter quarantine ────────────────────
// Malformed x402 invoices / trustline payloads previously failed silently with
// no audit trail. When phase-144 is on, the trustline route quarantines the
// rejected payload into a review queue instead of dropping it.
// NOTE: type-only re-export — the store imports node:fs and must NOT be bundled
// into the client (trustline-button imports from this file). Server code uses
// dynamic import("@/lib/x402-dead-letter").
export type {
  X402Invoice,
  X402DeadLetterEntry,
  DeadLetterReason,
  DeadLetterStatus,
  InvoiceClassification,
  QuarantineResult,
} from "@/lib/x402-dead-letter"

/**
 * Trustline + CID integrity contract:
 * When pinning metadata for the liq asset (e.g., NFT image refreshed after
 * re-pin), the caller can provide the expected CID and optional sha256.
 * This helper validates and caches the content before returning wallet status.
 */
export const TrustlineCidVerificationSchema = z.object({
  walletAddress: z.string().length(56).regex(/^G[A-Z2-7]{55}$/),
  cid: z.string().min(4).max(128).regex(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+|bafk[a-z0-9]+).*$/).optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
})

export type TrustlineCidVerification = z.infer<typeof TrustlineCidVerificationSchema>

/**
 * Verifies re-pinned CID bytes against expected hash before allowing trustline
 * status to be considered "verified". Returns structured result for API.
 * Server-only path uses node:crypto; client short-circuits without import to
 * avoid bundling node:fs (phase-119 build fix).
 */
export async function verifyRePinnedCidIntegrity(
  cid: string,
  bytes: Uint8Array | Buffer | ArrayBuffer,
  expectedSha256?: string | null,
): Promise<{ ok: true; sha256: string; cid: string } | { ok: false; error: string; code: string }> {
  // Client short-circuit — never verify on browser (no node:fs)
  if (typeof window !== "undefined") return { ok: true, sha256: "", cid }
  const flagOn = (() => {
    try {
      const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_119 ?? process.env.FEATURE_PHASE_119 ?? "").trim().toLowerCase()
      return v === "1" || v === "true" || v === "yes" || v === "on"
    } catch { return false }
  })()
  // Lightweight local sha256 without importing cid-cache (avoid node:fs chunk)
  const localSha256 = (b: Uint8Array | Buffer | ArrayBuffer): string => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createHash } = require("node:crypto") as typeof import("node:crypto")
      const buf = b instanceof ArrayBuffer ? Buffer.from(b) : Buffer.isBuffer(b) ? b : Buffer.from(b as Uint8Array)
      return createHash("sha256").update(buf).digest("hex")
    } catch { return "" }
  }
  const localValidate = (c: string) => /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+|bafk[a-z0-9]+|bafb[a-z0-9]+)$/.test(c.trim())
  const localVerify = (b: Uint8Array | Buffer | ArrayBuffer, expected: string) => {
    if (!/^[a-f0-9]{64}$/.test(expected)) return false
    const actual = localSha256(b)
    let diff = 0
    for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
    return diff === 0
  }
  if (!flagOn) {
    return { ok: true, sha256: localSha256(bytes), cid }
  }
  try {
    if (!localValidate(cid)) return { ok: false, error: `Invalid CID: ${cid.slice(0, 12)}…`, code: "CID_INVALID" }
    const sha = localSha256(bytes)
    if (expectedSha256 && !localVerify(bytes, expectedSha256)) {
      return { ok: false, error: `Checksum mismatch for CID ${cid.slice(0, 8)}…`, code: "HASH_MISMATCH" }
    }
    // Defer cache write to server module only when flag on and not in client
    try {
      const { setCachedCid } = await import("@/lib/cid-cache")
      await setCachedCid(cid, bytes, { expectedSha256: expectedSha256 ?? null })
    } catch {
      // cache best-effort, verification still ok
    }
    return { ok: true, sha256: sha, cid }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, code: "VERIFY_FAILED" }
  }
}

// ─── phase-134: rate-limit-aware batch trustline submission ─────────────────
// Each changeTrust submission previously hit Horizon individually and
// immediately; a burst of onboarding wallets (or a caller retrying after a
// 429) amplifies into cascading rate-limit failures. This module accepts one
// or many signed XDRs per call, submits them through a small bounded
// concurrency window, and retries 429/503 with exponential backoff + jitter.
// Feature flag: phase-134 (NEXT_PUBLIC_FEATURE_PHASE_134 / FEATURE_PHASE_134)
// Rollback: unset flag → each XDR submits immediately, sequentially, with no
// retry — identical to pre-phase-134 behavior.

export type TrustlineSubmitResult =
  | { signedXdr: string; ok: true; hash: string; attempts: number }
  | { signedXdr: string; ok: false; error: string; attempts: number; cause?: unknown }

export type TrustlineBatchSubmitOptions = {
  maxRetries?: number
  baseDelayMs?: number
  concurrency?: number
  /** Injectable for tests; defaults to a real Horizon submitTransaction call. */
  submit?: (signedXdr: string) => Promise<{ hash: string }>
}

function isPhase134Enabled(): boolean {
  return isFeatureEnabled("phase-134")
}

function isRetryableHorizonError(e: unknown): boolean {
  const status = (e as { response?: { status?: number } } | undefined)?.response?.status
  return status === 429 || status === 503
}

async function defaultHorizonTrustlineSubmit(signedXdr: string): Promise<{ hash: string }> {
  const { Horizon, Networks, TransactionBuilder } = await import("@stellar/stellar-sdk")
  const server = new Horizon.Server(HORIZON_URL)
  const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET)
  const submitted = await server.submitTransaction(tx)
  return { hash: submitted.hash }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function submitTrustlineWithRetry(
  signedXdr: string,
  submit: (xdr: string) => Promise<{ hash: string }>,
  maxRetries: number,
  baseDelayMs: number,
): Promise<TrustlineSubmitResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { hash } = await submit(signedXdr)
      return { signedXdr, ok: true, hash, attempts: attempt }
    } catch (e) {
      if (attempt > maxRetries || !isRetryableHorizonError(e)) {
        return { signedXdr, ok: false, error: e instanceof Error ? e.message : String(e), attempts: attempt, cause: e }
      }
      const jitterMs = Math.random() * baseDelayMs
      await sleep(baseDelayMs * 2 ** (attempt - 1) + jitterMs)
    }
  }
}

/**
 * Submits one or more signed changeTrust XDRs to Horizon. When phase-134 is
 * enabled, submissions run with bounded concurrency and exponential backoff
 * on 429/503; when disabled, each XDR submits immediately and sequentially
 * (legacy behavior, zero regression).
 */
export async function submitTrustlineBatch(
  signedXdrs: readonly string[],
  opts: TrustlineBatchSubmitOptions = {},
): Promise<TrustlineSubmitResult[]> {
  const submit = opts.submit ?? defaultHorizonTrustlineSubmit

  if (!isPhase134Enabled()) {
    const results: TrustlineSubmitResult[] = []
    for (const signedXdr of signedXdrs) {
      try {
        const { hash } = await submit(signedXdr)
        results.push({ signedXdr, ok: true, hash, attempts: 1 })
      } catch (e) {
        results.push({ signedXdr, ok: false, error: e instanceof Error ? e.message : String(e), attempts: 1, cause: e })
      }
    }
    return results
  }

  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 500
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, signedXdrs.length || 1))

  const results: TrustlineSubmitResult[] = new Array(signedXdrs.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= signedXdrs.length) return
      results[i] = await submitTrustlineWithRetry(signedXdrs[i]!, submit, maxRetries, baseDelayMs)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}
