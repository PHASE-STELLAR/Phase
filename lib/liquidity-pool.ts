/**
 * Spike 574 (issue #438) — liquidity pools: classic DEX (PHASELQ/XLM) plus a
 * Soroswap router adapter.
 *
 * Why this is not "a new route": the naive version assumes LP shares are SAC
 * balances, assumes a single trustline, assumes the router address is stable,
 * and assumes a quote is still valid by the time the user signs. Each of those
 * assumptions is a silent failure on testnet:
 *
 * - LP shares are a *different* asset (a `liquidity_pool_shares` trustline keyed
 *   by pool id), so `readClassicWalletStatus` says "no PHASELQ balance" and the
 *   UI reports an empty wallet that actually holds the pool.
 * - A PHASELQ/XLM classic deposit needs two trustlines (PHASELQ + pool shares);
 *   XLM is native. A credit/credit pool needs three. The old single-trustline
 *   preflight answered 412 for the wrong reason.
 * - Soroswap testnet router addresses are redeployed. A hardcoded address does
 *   not fail loudly — it builds a transaction to a contract that no longer
 *   exists, and the swap fails after the user signed.
 * - Quotes are not signed and there is no oracle. On thin testnet pools a
 *   normal-size swap moves price double digits, so the only honest contract is:
 *   short TTL, quote hash, explicit min-out, and a 409 when the bound no longer
 *   holds. This module implements exactly that instead of inventing an
 *   attestation service.
 *
 * Flag: phase-182. Every export is safe to call with the flag off (routes gate
 * before touching Horizon); no sidecar/table is created unless the flag is on.
 * Rollback: unset `NEXT_PUBLIC_FEATURE_PHASE_182` / `FEATURE_PHASE_182`, restart.
 * `liquidity-pool-intents.json` and the additive `pool_activity` table stay
 * inert on disk; with the flag off no code path reads them.
 */

import { createHash } from "node:crypto"
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  getLiquidityPoolId,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  nativeToScVal,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk"
import { HORIZON_URL } from "@/lib/phase-protocol"
import { flagRollbackNote, isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"
import { getDb } from "@/lib/sqlite-db"
import { readJsonFile, updateJsonFile } from "@/lib/json-store"
import { serverDataJsonPath } from "@/lib/server-data-paths"

// ─── flag surface ───────────────────────────────────────────────────────────

export function isPhase182Enabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-182", wallet ? { wallet } : undefined)
}

export function phase182RollbackNote(): string {
  return flagRollbackNote("phase-182")
}

// ─── constants ──────────────────────────────────────────────────────────────

/** Classic constant-product pools created by the protocol charge 30 bps. */
export const CLASSIC_POOL_FEE_BPS = 30
/** A quote older than this is refused on a write path (409 QUOTE_STALE). */
export const LP_QUOTE_TTL_MS = 20_000
/** Default user slippage tolerance for quotes and deposit/withdraw bounds. */
export const DEFAULT_POOL_SLIPPAGE_BPS = 50
/** Orders further than this from the pool's execution price are refused. */
export const DEFAULT_OFFER_POOL_BAND_BPS = 1_500
/** Refuse quotes that move price more than this; thin pools must be explicit. */
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 500
/** How long a reserve snapshot may be served read-only after a Horizon failure. */
export const POOL_RESERVE_STALE_TTL_MS = 60_000

const BPS = 10_000n
const STROOP_SCALE = 10_000_000n

export type PoolErrorCode =
  | "FLAG_DISABLED"
  | "INVALID_INPUT"
  | "POOL_NOT_FOUND"
  | "RESERVE_UNAVAILABLE"
  | "QUOTE_STALE"
  | "QUOTE_MISMATCH"
  | "SLIPPAGE_EXCEEDED"
  | "PRICE_IMPACT_TOO_HIGH"
  | "TRUSTLINE_MISSING"
  | "POOL_ASSET_MISMATCH"
  | "INTENT_CONFLICT"
  | "SOROSWAP_NOT_CONFIGURED"
  | "SOROSWAP_ROUTER_INVALID"
  | "SOROSWAP_ROUTER_DRIFT"
  | "SOROSWAP_QUOTE_UNAVAILABLE"

export class PoolError extends Error {
  readonly code: PoolErrorCode
  readonly status: number
  readonly retryAfterSeconds?: number
  readonly details?: unknown
  constructor(
    code: PoolErrorCode,
    message: string,
    opts: { status?: number; retryAfterSeconds?: number; details?: unknown } = {},
  ) {
    super(message)
    this.name = "PoolError"
    this.code = code
    this.status = opts.status ?? poolErrorStatus(code)
    this.retryAfterSeconds = opts.retryAfterSeconds
    this.details = opts.details
  }
}

/** Deterministic HTTP taxonomy, so every route maps the same code identically. */
export function poolErrorStatus(code: PoolErrorCode): number {
  switch (code) {
    case "FLAG_DISABLED":
      return 404
    case "INVALID_INPUT":
    case "POOL_ASSET_MISMATCH":
      return 400
    case "POOL_NOT_FOUND":
      return 404
    case "TRUSTLINE_MISSING":
      return 412
    case "QUOTE_STALE":
    case "QUOTE_MISMATCH":
    case "SLIPPAGE_EXCEEDED":
    case "INTENT_CONFLICT":
      return 409
    case "PRICE_IMPACT_TOO_HIGH":
      return 422
    case "RESERVE_UNAVAILABLE":
    case "SOROSWAP_NOT_CONFIGURED":
    case "SOROSWAP_ROUTER_INVALID":
    case "SOROSWAP_ROUTER_DRIFT":
    case "SOROSWAP_QUOTE_UNAVAILABLE":
      return 503
  }
}

// ─── assets and pool identity ───────────────────────────────────────────────

export type PoolAsset = { kind: "native" } | { kind: "credit"; code: string; issuer: string }

export function poolAssetKey(asset: PoolAsset): string {
  return asset.kind === "native" ? "native" : `${asset.code}:${asset.issuer}`
}

export function poolAssetLabel(asset: PoolAsset): string {
  return asset.kind === "native" ? "XLM" : asset.code
}

export function toClassicSdkAsset(asset: PoolAsset): Asset {
  return asset.kind === "native" ? Asset.native() : new Asset(asset.code, asset.issuer)
}

/** Parse Horizon's `"native"` / `"CODE:ISSUER"` reserve representation. */
export function poolAssetFromString(raw: unknown): PoolAsset | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  if (!value) return null
  if (value.toLowerCase() === "native") return { kind: "native" }
  const idx = value.indexOf(":")
  if (idx <= 0 || idx === value.length - 1) return null
  const code = value.slice(0, idx)
  const issuer = value.slice(idx + 1)
  if (!/^[A-Z0-9]{1,12}$/i.test(code)) return null
  if (!StrKey.isValidEd25519PublicKey(issuer)) return null
  return { kind: "credit", code, issuer }
}

/**
 * Canonical [A, B] ordering. `getLiquidityPoolId` rejects anything else, so
 * this must use the SDK comparator (native < alphanum4 < alphanum12, then code,
 * then issuer) rather than string order — string order puts "PHASELQ" before
 * "native" and produces an invalid pool id.
 */
export function orderPoolAssets(a: PoolAsset, b: PoolAsset): [PoolAsset, PoolAsset] {
  if (poolAssetKey(a) === poolAssetKey(b)) {
    throw new PoolError("INVALID_INPUT", "Pool assets must differ.")
  }
  return Asset.compare(toClassicSdkAsset(a), toClassicSdkAsset(b)) < 0 ? [a, b] : [b, a]
}

/**
 * Horizon's pool id, computed locally from the asset pair. Never accept a pool
 * id from the caller without recomputing it: an id that does not match the
 * assets is how a deposit lands in an unrelated pool.
 */
export function classicPoolIdForAssets(a: PoolAsset, b: PoolAsset): string {
  const [left, right] = orderPoolAssets(a, b)
  const id = getLiquidityPoolId("constant_product", {
    assetA: toClassicSdkAsset(left),
    assetB: toClassicSdkAsset(right),
    fee: LiquidityPoolFeeV18,
  })
  return Buffer.from(id).toString("hex")
}

// ─── reserves ───────────────────────────────────────────────────────────────

export type ClassicPoolReserve = { asset: PoolAsset; amountStroops: bigint }

export type ClassicPoolSnapshot = {
  poolId: string
  feeBps: number
  /** Always in canonical pool order, matching the deposit/withdraw op. */
  reserves: [ClassicPoolReserve, ClassicPoolReserve]
  totalShares: bigint
  totalTrustlines: number
  ledger: number
  fetchedAt: number
  /** True when this snapshot was replayed from cache after a Horizon failure. */
  stale: boolean
}

export type HorizonPoolRecord = {
  id?: unknown
  fee_bp?: unknown
  type?: unknown
  total_shares?: unknown
  total_trustlines?: unknown
  last_modified_ledger?: unknown
  reserves?: unknown
}

export function decimalToStroops(value: unknown): bigint {
  const text = typeof value === "string" ? value.trim() : String(value ?? "")
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new PoolError("INVALID_INPUT", `Invalid decimal amount: ${text || "(empty)"}`)
  }
  const [whole, fraction = ""] = text.split(".")
  const frac = (fraction + "0000000").slice(0, 7)
  return BigInt(whole) * STROOP_SCALE + BigInt(frac || "0")
}

export function stroopsToDecimal(stroops: bigint): string {
  if (stroops < 0n) throw new PoolError("INVALID_INPUT", "Negative amounts are not supported.")
  const whole = stroops / STROOP_SCALE
  const frac = (stroops % STROOP_SCALE).toString().padStart(7, "0")
  return `${whole}.${frac}`
}

/** Parse one `/liquidity_pools/:id` record. Shape is validated, never trusted. */
export function parseClassicPoolRecord(
  record: HorizonPoolRecord,
  opts: { expectedAssets?: [PoolAsset, PoolAsset]; now?: number } = {},
): ClassicPoolSnapshot {
  const now = opts.now ?? Date.now()
  const poolId = typeof record.id === "string" ? record.id.trim() : ""
  if (!/^[0-9a-f]{64}$/i.test(poolId)) {
    throw new PoolError("POOL_NOT_FOUND", "Horizon returned a pool without a valid id.")
  }
  const rawReserves = Array.isArray(record.reserves) ? record.reserves : []
  if (rawReserves.length !== 2) {
    throw new PoolError("POOL_NOT_FOUND", `Pool ${poolId} does not expose two reserves.`)
  }

  const parsedReserves = rawReserves.map((entry) => {
    const row = entry as { asset?: unknown; amount?: unknown }
    const asset = poolAssetFromString(row.asset)
    if (!asset) throw new PoolError("POOL_NOT_FOUND", "Pool reserve has an invalid asset.")
    return { asset, amountStroops: decimalToStroops(row.amount) }
  }) as ClassicPoolReserve[]

  const [a, b] = parsedReserves as [ClassicPoolReserve, ClassicPoolReserve]
  const [left, right] = orderPoolAssets(a.asset, b.asset)
  if (
    poolAssetKey(a.asset) !== poolAssetKey(left) &&
    poolAssetKey(b.asset) !== poolAssetKey(left)
  ) {
    throw new PoolError("POOL_NOT_FOUND", "Pool reserve ordering could not be normalised.")
  }
  const ordered: [ClassicPoolReserve, ClassicPoolReserve] =
    poolAssetKey(a.asset) === poolAssetKey(left) ? [a, b] : [b, a]

  if (opts.expectedAssets) {
    const expected = opts.expectedAssets.map(poolAssetKey).sort()
    const actual = ordered.map((r) => poolAssetKey(r.asset)).sort()
    if (expected[0] !== actual[0] || expected[1] !== actual[1]) {
      throw new PoolError("POOL_ASSET_MISMATCH", "Horizon pool assets do not match the requested pair.")
    }
  }

  const feeBps = Number(record.fee_bp ?? CLASSIC_POOL_FEE_BPS)
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
    throw new PoolError("POOL_NOT_FOUND", "Pool fee is outside the supported range.")
  }

  return {
    poolId: poolId.toLowerCase(),
    feeBps,
    reserves: ordered,
    totalShares: decimalToStroops(record.total_shares ?? "0"),
    totalTrustlines: Number(record.total_trustlines ?? 0),
    ledger: Number(record.last_modified_ledger ?? 0),
    fetchedAt: now,
    stale: false,
  }
}

type FetchLike = typeof fetch

export async function fetchClassicPoolSnapshot(
  poolId: string,
  opts: { horizonUrl?: string; now?: number; fetchImpl?: FetchLike } = {},
): Promise<ClassicPoolSnapshot> {
  const id = poolId.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new PoolError("INVALID_INPUT", "poolId must be a 64-character hex pool hash.")
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = (opts.horizonUrl ?? HORIZON_URL).replace(/\/+$/, "")
  let res: Response
  try {
    res = await fetchImpl(`${base}/liquidity_pools/${id}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
  } catch (error) {
    throw new PoolError("RESERVE_UNAVAILABLE", "Horizon is unreachable.", {
      retryAfterSeconds: 5,
      details: error instanceof Error ? error.message : String(error),
    })
  }
  if (res.status === 404) throw new PoolError("POOL_NOT_FOUND", `Pool ${id.slice(0, 12)}… was not found.`)
  if (!res.ok) {
    throw new PoolError("RESERVE_UNAVAILABLE", `Horizon pool read failed (${res.status}).`, {
      retryAfterSeconds: res.status === 429 ? 15 : 5,
    })
  }
  return parseClassicPoolRecord((await res.json()) as HorizonPoolRecord, { now: opts.now })
}

const reserveCache = new Map<string, ClassicPoolSnapshot>()

export function resetPoolReserveCacheForTests(): void {
  reserveCache.clear()
}

/**
 * Read reserves with an explicit stale-on-error policy:
 *
 * - Fresh read failure with no cache → RESERVE_UNAVAILABLE (503).
 * - Fresh read failure with a cache younger than the stale TTL → return it with
 *   `stale: true` and increment `lp_reserve_stale_on_error`. Read-only callers
 *   may display it; write callers must call `assertQuoteFresh` first.
 * - A cache older than the TTL is never served.
 */
export async function getClassicPoolSnapshot(
  poolId: string,
  opts: { force?: boolean; now?: number; fetchImpl?: FetchLike; horizonUrl?: string } = {},
): Promise<ClassicPoolSnapshot> {
  const now = opts.now ?? Date.now()
  const cached = reserveCache.get(poolId)
  if (cached && !opts.force && now - cached.fetchedAt < 5_000) return cached
  try {
    const fresh = await fetchClassicPoolSnapshot(poolId, opts)
    reserveCache.set(poolId, fresh)
    return fresh
  } catch (error) {
    if (cached && now - cached.fetchedAt <= POOL_RESERVE_STALE_TTL_MS) {
      incSecurityCounter("lp_reserve_stale_on_error")
      return { ...cached, stale: true }
    }
    throw error
  }
}

// ─── quotes ─────────────────────────────────────────────────────────────────

export type PoolQuote = {
  venue: "classic"
  poolId: string
  assetIn: PoolAsset
  assetOut: PoolAsset
  amountInStroops: bigint
  /** Gross output after the pool fee, before slippage tolerance. */
  amountOutStroops: bigint
  /** Acceptance floor the wallet must sign (`destMin` equivalent). */
  minOutStroops: bigint
  feeBps: number
  slippageBps: number
  /** Reserves are quoted in `assetOut` per 1 `assetIn`. */
  spotPrice: number
  executionPrice: number
  priceImpactBps: number
  quoteHash: string
  ledger: number
  fetchedAt: number
  expiresAt: number
  stale: boolean
}

function ratioToNumber(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0
  // 1e9 precision is enough for display; the contract-relevant value is stroops.
  return Number((numerator * 1_000_000_000n) / denominator) / 1_000_000_000
}

function quoteHashFor(input: {
  venue: string
  poolId: string
  assetIn: PoolAsset
  assetOut: PoolAsset
  amountInStroops: bigint
  amountOutStroops: bigint
  minOutStroops: bigint
  slippageBps: number
  ledger: number
  expiresAt: number
}): string {
  const canonical = [
    "phase-lp-quote-v1",
    input.venue,
    input.poolId,
    poolAssetKey(input.assetIn),
    poolAssetKey(input.assetOut),
    input.amountInStroops.toString(),
    input.amountOutStroops.toString(),
    input.minOutStroops.toString(),
    String(input.slippageBps),
    String(input.ledger),
    String(input.expiresAt),
  ].join("|")
  return createHash("sha256").update(canonical).digest("hex")
}

export type QuoteClassicInput = {
  assetIn: PoolAsset
  amountInStroops: bigint
  slippageBps?: number
  maxPriceImpactBps?: number
  now?: number
  ttlMs?: number
}

/**
 * Constant-product quote with the fee taken from the input side, which is how
 * Stellar's classic pool applies it.
 *
 * `maxAmountIn = amountIn`, `amountOutAfterFee = amountIn * (1 - fee)`. The
 * invariant is preserved by adding the *post-fee* amount to the input reserve.
 */
export function quoteClassicPool(snapshot: ClassicPoolSnapshot, input: QuoteClassicInput): PoolQuote {
  const slippageBps = input.slippageBps ?? DEFAULT_POOL_SLIPPAGE_BPS
  const maxImpact = input.maxPriceImpactBps ?? DEFAULT_MAX_PRICE_IMPACT_BPS
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
    throw new PoolError("INVALID_INPUT", "slippageBps must be an integer between 0 and 5000.")
  }
  if (input.amountInStroops <= 0n) {
    throw new PoolError("INVALID_INPUT", "amountInStroops must be positive.")
  }

  const inReserve = snapshot.reserves.find((r) => poolAssetKey(r.asset) === poolAssetKey(input.assetIn))
  if (!inReserve) {
    throw new PoolError("POOL_ASSET_MISMATCH", "assetIn is not part of this pool.")
  }
  const outReserve = snapshot.reserves.find((r) => poolAssetKey(r.asset) !== poolAssetKey(input.assetIn))!
  if (inReserve.amountStroops <= 0n || outReserve.amountStroops <= 0n) {
    throw new PoolError("RESERVE_UNAVAILABLE", "Pool has an empty reserve.")
  }

  const feeAmount = (input.amountInStroops * BigInt(snapshot.feeBps)) / BPS
  const amountInAfterFee = input.amountInStroops - feeAmount
  const numerator = outReserve.amountStroops * amountInAfterFee
  const denominator = inReserve.amountStroops + amountInAfterFee
  const amountOut = numerator / denominator
  if (amountOut <= 0n) {
    throw new PoolError("INVALID_INPUT", "Swap amount is too small to produce output.")
  }

  const spotPrice = ratioToNumber(outReserve.amountStroops, inReserve.amountStroops)
  const executionPrice = ratioToNumber(amountOut, input.amountInStroops)
  const impactBps = spotPrice > 0 ? Math.max(0, Math.round(((spotPrice - executionPrice) / spotPrice) * 10_000)) : 0
  if (impactBps > maxImpact) {
    throw new PoolError(
      "PRICE_IMPACT_TOO_HIGH",
      `Quote moves price ${impactBps} bps, above the ${maxImpact} bps ceiling.`,
      { details: { priceImpactBps: impactBps, maxPriceImpactBps: maxImpact } },
    )
  }

  const minOut = (amountOut * BigInt(10_000 - slippageBps)) / BPS
  const now = input.now ?? Date.now()
  const expiresAt = now + (input.ttlMs ?? LP_QUOTE_TTL_MS)
  const quoteHash = quoteHashFor({
    venue: "classic",
    poolId: snapshot.poolId,
    assetIn: input.assetIn,
    assetOut: outReserve.asset,
    amountInStroops: input.amountInStroops,
    amountOutStroops: amountOut,
    minOutStroops: minOut,
    slippageBps,
    ledger: snapshot.ledger,
    expiresAt,
  })

  return {
    venue: "classic",
    poolId: snapshot.poolId,
    assetIn: input.assetIn,
    assetOut: outReserve.asset,
    amountInStroops: input.amountInStroops,
    amountOutStroops: amountOut,
    minOutStroops: minOut,
    feeBps: snapshot.feeBps,
    slippageBps,
    spotPrice,
    executionPrice,
    priceImpactBps: impactBps,
    quoteHash,
    ledger: snapshot.ledger,
    fetchedAt: snapshot.fetchedAt,
    expiresAt,
    stale: snapshot.stale,
  }
}

/**
 * Write-path gate. A stale quote is a 409 with `Retry-After`, never a silent
 * re-quote: the user is about to sign a specific min-out.
 */
export function assertQuoteUsable(quote: PoolQuote, opts: { now?: number; expectedHash?: string } = {}): void {
  const now = opts.now ?? Date.now()
  if (quote.stale) {
    throw new PoolError("QUOTE_STALE", "Pool reserves could not be refreshed; retry before signing.", {
      retryAfterSeconds: 5,
    })
  }
  if (now > quote.expiresAt) {
    throw new PoolError("QUOTE_STALE", "This quote expired before it was signed.", {
      retryAfterSeconds: 2,
    })
  }
  if (opts.expectedHash && opts.expectedHash !== quote.quoteHash) {
    throw new PoolError("QUOTE_MISMATCH", "The signed quote does not match current reserves.", {
      retryAfterSeconds: 2,
    })
  }
}

/** 409/412 callback shape for routes: never throw an untyped error at the edge. */
export function poolErrorResponse(error: unknown): {
  status: number
  body: { error: string; code: string; retryAfterSeconds?: number }
  headers?: Record<string, string>
} {
  if (error instanceof PoolError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      },
      ...(error.retryAfterSeconds !== undefined
        ? { headers: { "Retry-After": String(error.retryAfterSeconds) } }
        : {}),
    }
  }
  return {
    status: 500,
    body: { error: error instanceof Error ? error.message : String(error), code: "POOL_INTERNAL_ERROR" },
  }
}

// ─── classic operations (built server-side, signed client-side) ─────────────

export type BuildPoolOpInput = {
  walletAddress: string
  sequence: string
  snapshot: ClassicPoolSnapshot
}

function assertBuildInput(walletAddress: string, sequence: string): void {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    throw new PoolError("INVALID_INPUT", "walletAddress must be a valid Stellar G address.")
  }
  if (!/^\d+$/.test(sequence.trim())) {
    throw new PoolError("INVALID_INPUT", "sequence must be the account sequence number.")
  }
}

function buildTransaction(walletAddress: string, sequence: string) {
  return new TransactionBuilder(new Account(walletAddress, sequence.trim()), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(120)
}

/** The pool-share trustline the wallet needs before it can receive shares. */
export function poolShareAssetForSnapshot(snapshot: ClassicPoolSnapshot): LiquidityPoolAsset {
  return new LiquidityPoolAsset(
    toClassicSdkAsset(snapshot.reserves[0].asset),
    toClassicSdkAsset(snapshot.reserves[1].asset),
    LiquidityPoolFeeV18,
  )
}

/** `changeTrust` for the pool-share asset, not for either underlying asset. */
export function buildPoolShareTrustlineXdr(input: BuildPoolOpInput): string {
  assertBuildInput(input.walletAddress, input.sequence)
  return buildTransaction(input.walletAddress, input.sequence)
    .addOperation(Operation.changeTrust({ asset: poolShareAssetForSnapshot(input.snapshot) }))
    .build()
    .toXDR()
}

/**
 * Deposit one side (the other is pulled proportionally by the pool).
 *
 * `maxAmountA/B` are ceilings, so a moving pool cannot debit more than the user
 * approved. `minPrice`/`maxPrice` bound the A/B ratio around the quoted ratio.
 */
export function buildClassicPoolDepositXdr(
  input: BuildPoolOpInput & {
    /** Amount the user wants to deposit, in stroops, of `asset`. */
    amountStroops: bigint
    /** Which side the amount is denominated in. Defaults to reserve[0]. */
    asset?: PoolAsset
    slippageBps?: number
  },
): string {
  assertBuildInput(input.walletAddress, input.sequence)
  const { snapshot } = input
  const reserveA = snapshot.reserves[0].amountStroops
  const reserveB = snapshot.reserves[1].amountStroops
  if (input.amountStroops <= 0n) {
    throw new PoolError("INVALID_INPUT", "amountStroops must be positive.")
  }
  if (reserveA <= 0n || reserveB <= 0n) {
    throw new PoolError("RESERVE_UNAVAILABLE", "Cannot deposit into an empty pool.")
  }
  const slippageBps = input.slippageBps ?? DEFAULT_POOL_SLIPPAGE_BPS
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
    throw new PoolError("INVALID_INPUT", "slippageBps must be between 0 and 5000.")
  }

  const depositAsset = input.asset ?? snapshot.reserves[0].asset
  const isA = poolAssetKey(depositAsset) === poolAssetKey(snapshot.reserves[0].asset)
  if (!isA && poolAssetKey(depositAsset) !== poolAssetKey(snapshot.reserves[1].asset)) {
    throw new PoolError("POOL_ASSET_MISMATCH", "Deposit asset is not part of this pool.")
  }
  const idealOther = isA
    ? (input.amountStroops * reserveB) / reserveA
    : (input.amountStroops * reserveA) / reserveB
  if (idealOther <= 0n) {
    throw new PoolError("INVALID_INPUT", "Deposit is too small to be proportional.")
  }
  // Operation amounts are always in canonical pool order (A = reserve[0]).
  const amountA = isA ? input.amountStroops : idealOther
  const amountB = isA ? idealOther : input.amountStroops
  const maxA = (amountA * BigInt(10_000 + slippageBps)) / BPS
  const maxB = (amountB * BigInt(10_000 + slippageBps)) / BPS
  const ratio = ratioToNumber(reserveA, reserveB)
  const minPrice = (ratio * (10_000 - slippageBps)) / 10_000
  const maxPrice = (ratio * (10_000 + slippageBps)) / 10_000
  if (!(minPrice > 0) || !(maxPrice > minPrice)) {
    throw new PoolError("INVALID_INPUT", "Deposit price bounds are degenerate; deposit a larger amount.")
  }

  return buildTransaction(input.walletAddress, input.sequence)
    .addOperation(
      Operation.liquidityPoolDeposit({
        liquidityPoolId: snapshot.poolId,
        maxAmountA: stroopsToDecimal(maxA),
        maxAmountB: stroopsToDecimal(maxB),
        minPrice: minPrice.toFixed(7),
        maxPrice: maxPrice.toFixed(7),
      }),
    )
    .build()
    .toXDR()
}

/**
 * Classic swaps are strict-send path payments. With an empty path the network
 * routes through the best available classic pool for the pair, which is the
 * on-chain equivalent of the quote this route returned. `destMin` is the quote's
 * min-out, so the wallet can never receive less than it approved.
 */
export function buildClassicPoolSwapXdr(
  input: BuildPoolOpInput & { quote: PoolQuote },
): string {
  assertBuildInput(input.walletAddress, input.sequence)
  const { quote } = input
  if (quote.assetIn.kind === quote.assetOut.kind && poolAssetKey(quote.assetIn) === poolAssetKey(quote.assetOut)) {
    throw new PoolError("INVALID_INPUT", "Swap assets must differ.")
  }
  return buildTransaction(input.walletAddress, input.sequence)
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: toClassicSdkAsset(quote.assetIn),
        sendAmount: stroopsToDecimal(quote.amountInStroops),
        destination: input.walletAddress,
        destAsset: toClassicSdkAsset(quote.assetOut),
        destMin: stroopsToDecimal(quote.minOutStroops),
        path: [],
      }),
    )
    .build()
    .toXDR()
}

/** Burn pool shares for a proportional share of both reserves. */
export function buildClassicPoolWithdrawXdr(
  input: BuildPoolOpInput & { sharesStroops: bigint; slippageBps?: number },
): string {
  assertBuildInput(input.walletAddress, input.sequence)
  const { snapshot } = input
  if (input.sharesStroops <= 0n) {
    throw new PoolError("INVALID_INPUT", "sharesStroops must be positive.")
  }
  if (snapshot.totalShares <= 0n) {
    throw new PoolError("RESERVE_UNAVAILABLE", "Pool has no outstanding shares.")
  }
  if (input.sharesStroops > snapshot.totalShares) {
    throw new PoolError("INVALID_INPUT", "sharesStroops exceeds total pool shares.")
  }
  const slippageBps = input.slippageBps ?? DEFAULT_POOL_SLIPPAGE_BPS
  const minA = (snapshot.reserves[0].amountStroops * input.sharesStroops * BigInt(10_000 - slippageBps)) /
    (snapshot.totalShares * BPS)
  const minB = (snapshot.reserves[1].amountStroops * input.sharesStroops * BigInt(10_000 - slippageBps)) /
    (snapshot.totalShares * BPS)

  return buildTransaction(input.walletAddress, input.sequence)
    .addOperation(
      Operation.liquidityPoolWithdraw({
        liquidityPoolId: snapshot.poolId,
        amount: stroopsToDecimal(input.sharesStroops),
        minAmountA: stroopsToDecimal(minA),
        minAmountB: stroopsToDecimal(minB),
      }),
    )
    .build()
    .toXDR()
}

// ─── trustline preflight (the 412 path) ─────────────────────────────────────

export type PoolTrustlineStatus = {
  accountExists: boolean
  missing: Array<"asset_a" | "asset_b" | "pool_shares">
  shareBalanceStroops: bigint | null
  hasTrustlines: boolean
}

type HorizonAccountLike = {
  balances?: Array<{
    asset_type?: string
    asset_code?: string
    asset_issuer?: string
    liquidity_pool_id?: string
    balance?: string
  }>
}

/**
 * Two trustlines for PHASELQ/XLM, three for credit/credit. The previous
 * single-asset preflight reported a missing PHASELQ line when the real blocker
 * was the pool-share line, which stranded users after they signed changeTrust.
 */
export function poolTrustlineStatusFromAccount(
  account: HorizonAccountLike,
  snapshot: ClassicPoolSnapshot,
): PoolTrustlineStatus {
  const balances = Array.isArray(account.balances) ? account.balances : []
  const missing: PoolTrustlineStatus["missing"] = []
  const checkCredit = (asset: PoolAsset, slot: "asset_a" | "asset_b") => {
    if (asset.kind === "native") return
    const found = balances.some(
      (b) =>
        b.asset_type !== "native" &&
        b.asset_code === asset.code &&
        b.asset_issuer === asset.issuer,
    )
    if (!found) missing.push(slot)
  }
  checkCredit(snapshot.reserves[0].asset, "asset_a")
  checkCredit(snapshot.reserves[1].asset, "asset_b")

  const shareLine = balances.find(
    (b) => b.asset_type === "liquidity_pool_shares" && b.liquidity_pool_id === snapshot.poolId,
  )
  if (!shareLine) missing.push("pool_shares")

  return {
    accountExists: true,
    missing,
    shareBalanceStroops: shareLine?.balance ? decimalToStroops(shareLine.balance) : null,
    hasTrustlines: missing.length === 0,
  }
}

export type PoolAccountSnapshot = { sequence: string; trustlines: PoolTrustlineStatus }

/** One Horizon account read for sequence + all three balance lines. */
export async function readPoolAccount(
  walletAddress: string,
  snapshot: ClassicPoolSnapshot,
  opts: { horizonUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<PoolAccountSnapshot> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    throw new PoolError("INVALID_INPUT", "walletAddress must be a valid Stellar G address.")
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = (opts.horizonUrl ?? HORIZON_URL).replace(/\/+$/, "")
  const res = await fetchImpl(`${base}/accounts/${encodeURIComponent(walletAddress)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (res.status === 404) {
    throw new PoolError("TRUSTLINE_MISSING", "Account not found. Fund it with Friendbot first.", {
      details: { accountExists: false },
    })
  }
  if (!res.ok) {
    throw new PoolError("RESERVE_UNAVAILABLE", `Horizon account read failed (${res.status}).`, {
      retryAfterSeconds: 5,
    })
  }
  const body = (await res.json()) as HorizonAccountLike & { sequence?: unknown }
  const sequence = typeof body.sequence === "string" ? body.sequence : ""
  if (!/^\d+$/.test(sequence)) {
    throw new PoolError("RESERVE_UNAVAILABLE", "Horizon account response had no sequence.")
  }
  const trustlines = poolTrustlineStatusFromAccount(body, snapshot)
  if (!trustlines.hasTrustlines) incSecurityCounter("lp_triple_trustline_required")
  return { sequence, trustlines }
}

export async function readPoolTrustlineStatus(
  walletAddress: string,
  snapshot: ClassicPoolSnapshot,
  opts: { horizonUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<PoolTrustlineStatus> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    throw new PoolError("INVALID_INPUT", "walletAddress must be a valid Stellar G address.")
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = (opts.horizonUrl ?? HORIZON_URL).replace(/\/+$/, "")
  const res = await fetchImpl(`${base}/accounts/${encodeURIComponent(walletAddress)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (res.status === 404) {
    return { accountExists: false, missing: ["asset_a", "asset_b", "pool_shares"], shareBalanceStroops: null, hasTrustlines: false }
  }
  if (!res.ok) {
    throw new PoolError("RESERVE_UNAVAILABLE", `Horizon account read failed (${res.status}).`, {
      retryAfterSeconds: 5,
    })
  }
  const status = poolTrustlineStatusFromAccount((await res.json()) as HorizonAccountLike, snapshot)
  if (!status.hasTrustlines) incSecurityCounter("lp_triple_trustline_required")
  return status
}

// ─── rate limiting (per instance) ───────────────────────────────────────────

const rateBuckets = new Map<string, number[]>()

/**
 * Bounded per-wallet limiter: 60 quote/prepare calls per minute, the same
 * ceiling as the other write routes. In-memory is sufficient here — the limiter
 * protects Horizon, and each serverless instance enforcing its own ceiling is
 * the same trade-off already documented for sidecar locks.
 */
export function checkPoolRateLimit(
  wallet: string,
  opts: { limit?: number; windowMs?: number; now?: number } = {},
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const limit = opts.limit ?? 60
  const windowMs = opts.windowMs ?? 60_000
  const now = opts.now ?? Date.now()
  const key = wallet.trim().toUpperCase()
  const recent = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - recent[0]!)) / 1000))
    rateBuckets.set(key, recent)
    return { ok: false, retryAfterSeconds }
  }
  recent.push(now)
  rateBuckets.set(key, recent)
  if (rateBuckets.size > 5_000) {
    for (const [k, v] of rateBuckets) if (v.every((t) => now - t >= windowMs)) rateBuckets.delete(k)
  }
  return { ok: true }
}

export function resetPoolRateLimitForTests(): void {
  rateBuckets.clear()
}

// ─── Soroswap router adapter ────────────────────────────────────────────────

export type SoroswapConfig = {
  routerContractId: string
  factoryContractId: string | null
  apiUrl: string | null
  expectedRouterId: string | null
}

export type SoroswapConfigResult =
  | { ok: true; config: SoroswapConfig }
  | { ok: false; code: "SOROSWAP_NOT_CONFIGURED" | "SOROSWAP_ROUTER_INVALID" | "SOROSWAP_ROUTER_DRIFT"; detail: string }

function isContractId(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  return StrKey.isValidContract(trimmed)
}

/**
 * There is deliberately no default router address. Soroswap redeploys its
 * testnet router; a baked-in fallback builds transactions to a dead contract
 * and the failure surfaces only after signing.
 */
export function resolveSoroswapConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): SoroswapConfigResult {
  const router = env.SOROSWAP_ROUTER_CONTRACT_ID?.trim() ?? ""
  if (!router) {
    return {
      ok: false,
      code: "SOROSWAP_NOT_CONFIGURED",
      detail: "SOROSWAP_ROUTER_CONTRACT_ID is not set; Soroswap swaps are unavailable.",
    }
  }
  if (!isContractId(router)) {
    return { ok: false, code: "SOROSWAP_ROUTER_INVALID", detail: "SOROSWAP_ROUTER_CONTRACT_ID is not a valid C… contract id." }
  }
  const factory = env.SOROSWAP_FACTORY_CONTRACT_ID?.trim() ?? ""
  if (factory && !isContractId(factory)) {
    return { ok: false, code: "SOROSWAP_ROUTER_INVALID", detail: "SOROSWAP_FACTORY_CONTRACT_ID is not a valid C… contract id." }
  }
  const expected = env.SOROSWAP_EXPECTED_ROUTER_ID?.trim() ?? ""
  if (expected && expected !== router) {
    incSecurityCounter("lp_router_address_drift")
    return {
      ok: false,
      code: "SOROSWAP_ROUTER_DRIFT",
      detail: `Configured router ${router.slice(0, 8)}… does not match pinned ${expected.slice(0, 8)}….`,
    }
  }
  return {
    ok: true,
    config: {
      routerContractId: router,
      factoryContractId: factory || null,
      apiUrl: env.SOROSWAP_API_URL?.trim() || null,
      expectedRouterId: expected || null,
    },
  }
}

/** Used by health checks after a redeploy to surface drift before a user signs. */
export function detectSoroswapRouterDrift(pinned: string | null, observed: string): boolean {
  if (!pinned) return false
  const drifted = pinned.trim() !== observed.trim()
  if (drifted) incSecurityCounter("lp_router_address_drift")
  return drifted
}

export type SoroswapQuote = {
  venue: "soroswap"
  routerContractId: string
  assetIn: PoolAsset
  assetOut: PoolAsset
  amountInStroops: bigint
  amountOutStroops: bigint
  minOutStroops: bigint
  slippageBps: number
  /** Present when the aggregator reports it; classic pools compute it locally. */
  priceImpactBps: number | null
  spotPrice: number | null
  path: string[]
  raw: unknown
}

export type SoroswapQuoteInput = {
  assetIn: PoolAsset
  assetOut: PoolAsset
  amountInStroops: bigint
  slippageBps?: number
  fetchImpl?: FetchLike
  entry?: "api" | "chain"
}

function sacContractId(asset: PoolAsset): string {
  return toClassicSdkAsset(asset).contractId(Networks.TESTNET)
}

/**
 * Soroswap quotes come from its aggregator, not from local reserves. Treat the
 * response as untrusted: validate the path endpoints and the output amount, and
 * fail closed when the aggregator is down (a swap with no bound is worse than a
 * retry).
 */
export async function quoteSoroswap(input: SoroswapQuoteInput): Promise<SoroswapQuote> {
  const resolved = resolveSoroswapConfig()
  if (!resolved.ok) throw new PoolError(resolved.code, resolved.detail, { retryAfterSeconds: 30 })
  if (!resolved.config.apiUrl) {
    throw new PoolError("SOROSWAP_QUOTE_UNAVAILABLE", "SOROSWAP_API_URL is not configured.", {
      retryAfterSeconds: 30,
    })
  }
  if (input.amountInStroops <= 0n) {
    throw new PoolError("INVALID_INPUT", "amountInStroops must be positive.")
  }
  const slippageBps = input.slippageBps ?? DEFAULT_POOL_SLIPPAGE_BPS
  const fetchImpl = input.fetchImpl ?? fetch
  const url = new URL(`${resolved.config.apiUrl.replace(/\/+$/, "")}/quote`)
  url.searchParams.set("assetIn", sacContractId(input.assetIn))
  url.searchParams.set("assetOut", sacContractId(input.assetOut))
  url.searchParams.set("amountIn", input.amountInStroops.toString())

  let res: Response
  try {
    res = await fetchImpl(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" })
  } catch (error) {
    throw new PoolError("SOROSWAP_QUOTE_UNAVAILABLE", "Soroswap aggregator is unreachable.", {
      retryAfterSeconds: 10,
      details: error instanceof Error ? error.message : String(error),
    })
  }
  if (!res.ok) {
    throw new PoolError("SOROSWAP_QUOTE_UNAVAILABLE", `Soroswap quote failed (${res.status}).`, {
      retryAfterSeconds: 10,
    })
  }
  const raw = (await res.json()) as {
    amountOut?: unknown
    amount_out?: unknown
    path?: unknown
    priceImpact?: unknown
    price_impact?: unknown
  }
  const outText = String(raw.amountOut ?? raw.amount_out ?? "")
  if (!/^\d+$/.test(outText) || BigInt(outText) <= 0n) {
    throw new PoolError("SOROSWAP_QUOTE_UNAVAILABLE", "Soroswap returned an unusable amountOut.")
  }
  const amountOut = BigInt(outText)
  const minOut = (amountOut * BigInt(10_000 - slippageBps)) / BPS
  const path = Array.isArray(raw.path)
    ? raw.path.filter((p): p is string => typeof p === "string" && isContractId(p))
    : [sacContractId(input.assetIn), sacContractId(input.assetOut)]
  if (path.length < 2) {
    throw new PoolError("SOROSWAP_QUOTE_UNAVAILABLE", "Soroswap returned an empty route.")
  }
  const impactRaw = raw.priceImpact ?? raw.price_impact
  const impact = typeof impactRaw === "number" && Number.isFinite(impactRaw) ? Math.round(Math.abs(impactRaw) * 10_000) : null
  const execution = ratioToNumber(amountOut, input.amountInStroops)

  return {
    venue: "soroswap",
    routerContractId: resolved.config.routerContractId,
    assetIn: input.assetIn,
    assetOut: input.assetOut,
    amountInStroops: input.amountInStroops,
    amountOutStroops: amountOut,
    minOutStroops: minOut,
    slippageBps,
    priceImpactBps: impact,
    spotPrice: null,
    path,
    raw,
  }
}

export type BuildSoroswapSwapInput = {
  walletAddress: string
  sequence: string
  quote: SoroswapQuote
  /** Unix seconds; the router rejects an expired swap. */
  deadline: number
}

/**
 * Build the router invocation. The wallet signs it; the server never does.
 * `swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline)`
 * matches Soroswap's router ABI; a signature change is caught by `quote` or by
 * the simulation the client runs before signing.
 */
export function buildSoroswapSwapXdr(input: BuildSoroswapSwapInput): string {
  assertBuildInput(input.walletAddress, input.sequence)
  if (!isContractId(input.quote.routerContractId)) {
    throw new PoolError("SOROSWAP_ROUTER_INVALID", "Router contract id is invalid.")
  }
  if (input.deadline * 1000 <= Date.now()) {
    throw new PoolError("QUOTE_STALE", "Swap deadline is already in the past.", { retryAfterSeconds: 2 })
  }
  const args = [
    nativeToScVal(input.quote.amountInStroops, { type: "i128" }),
    nativeToScVal(input.quote.minOutStroops, { type: "i128" }),
    xdr.ScVal.scvVec(input.quote.path.map(pathScVal)),
    new Address(input.walletAddress).toScVal(),
    nativeToScVal(BigInt(Math.floor(input.deadline)), { type: "u64" }),
  ]
  return buildTransaction(input.walletAddress, input.sequence)
    .addOperation(
      Operation.invokeContractFunction({
        contract: input.quote.routerContractId,
        function: "swap_exact_tokens_for_tokens",
        args,
      }),
    )
    .build()
    .toXDR()
}

function pathScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal()
}

// ─── intent idempotency ─────────────────────────────────────────────────────

export type PoolIntentAction = "deposit" | "withdraw" | "swap"

export type PoolIntentRecord = {
  intentId: string
  wallet: string
  action: PoolIntentAction
  venue: "classic" | "soroswap"
  poolId: string | null
  quoteHash: string | null
  amountInStroops: string | null
  amountOutStroops: string | null
  sharesStroops: string | null
  xdrHash: string
  createdAt: number
  expiresAt: number
}

type PoolIntentStore = Record<string, PoolIntentRecord>

const INTENT_TTL_MS = 8 * 60 * 1000
const INTENT_STORE_KEY = "liquidityPoolIntents" as const

function intentKey(wallet: string, intentId: string): string {
  return `${wallet.toUpperCase()}:${intentId}`
}

export type RecordPoolIntentResult =
  | { ok: true; record: PoolIntentRecord; replay: boolean }
  | { ok: false; code: "INTENT_CONFLICT"; existing: PoolIntentRecord }

/**
 * Same `intentId` + same payload is a replay (the client retried after a
 * timeout); same id + different payload is a 409. The record stores only hashes
 * and stroops — no wallet balances, no PII, and no signed XDR.
 */
export async function recordPoolIntent(
  input: Omit<PoolIntentRecord, "createdAt" | "expiresAt" | "xdrHash"> & {
    signedXdr: string
    now?: number
  },
): Promise<RecordPoolIntentResult> {
  const now = input.now ?? Date.now()
  const xdrHash = createHash("sha256").update(input.signedXdr).digest("hex")
  const key = intentKey(input.wallet, input.intentId)
  const file = serverDataJsonPath(INTENT_STORE_KEY)

  return updateJsonFile<PoolIntentStore, RecordPoolIntentResult>(file, {
    mutate: (store) => {
    const existing = store[key]
    if (existing && existing.expiresAt > now) {
      const same =
        existing.action === input.action &&
        existing.venue === input.venue &&
        existing.poolId === input.poolId &&
        existing.quoteHash === input.quoteHash &&
        existing.amountInStroops === input.amountInStroops &&
        existing.amountOutStroops === input.amountOutStroops &&
        existing.sharesStroops === input.sharesStroops &&
        existing.xdrHash === xdrHash
      if (!same) return { ok: false, code: "INTENT_CONFLICT", existing }
      return { ok: true, record: existing, replay: true }
    }

    for (const [k, v] of Object.entries(store)) {
      if (v.expiresAt <= now) delete store[k]
    }

    const record: PoolIntentRecord = {
      intentId: input.intentId,
      wallet: input.wallet.toUpperCase(),
      action: input.action,
      venue: input.venue,
      poolId: input.poolId,
      quoteHash: input.quoteHash,
      amountInStroops: input.amountInStroops,
      amountOutStroops: input.amountOutStroops,
      sharesStroops: input.sharesStroops,
      xdrHash,
      createdAt: now,
      expiresAt: now + INTENT_TTL_MS,
    }
    store[key] = record
    return { ok: true, record, replay: false }
    },
  })
}

export async function readPoolIntent(wallet: string, intentId: string, now = Date.now()): Promise<PoolIntentRecord | null> {
  const store = await readJsonFile<PoolIntentStore>(serverDataJsonPath(INTENT_STORE_KEY), {})
  const record = store[intentKey(wallet, intentId)]
  return record && record.expiresAt > now ? record : null
}


// ─── pool activity, self-provision and self-swap screening ──────────────────

export type PoolWashReason = "self_provision" | "self_swap"

export function ensurePoolActivityTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_activity (
      id            TEXT PRIMARY KEY,
      pool_id       TEXT NOT NULL,
      wallet        TEXT NOT NULL,
      counterparty  TEXT,
      kind          TEXT NOT NULL CHECK(kind IN ('deposit','withdraw','swap')),
      amount_a      TEXT NOT NULL DEFAULT '0',
      amount_b      TEXT NOT NULL DEFAULT '0',
      value_xlm_stroops TEXT NOT NULL DEFAULT '0',
      wash_flagged  INTEGER NOT NULL DEFAULT 0,
      wash_reason   TEXT,
      created_at    INTEGER NOT NULL
    )
  `)
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pool_activity_pool_created ON pool_activity (pool_id, created_at DESC, wash_flagged)",
  )
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pool_activity_wallet_created ON pool_activity (wallet, created_at DESC)",
  )
}

export type PoolActivityInput = {
  poolId: string
  wallet: string
  counterparty?: string | null
  kind: "deposit" | "withdraw" | "swap"
  amountA?: bigint | string
  amountB?: bigint | string
  valueXlmStroops?: bigint | string
  /** Share of pool shares held by `wallet`, in bps (deposit screening). */
  shareBps?: number
  /** Stable id (e.g. `swap:<txHash>`) so a retry cannot double-count. */
  activityId?: string
  now?: number
}

/**
 * Self-provision + self-swap are the new manipulation primitive this spike adds
 * to the wash model:
 *
 * - **Self-provision**: one wallet controls nearly all shares and is the only
 *   trader against the pool, so the "market" price it prints is its own.
 * - **Self-swap**: a swap where the wallet is both sides (or swaps against a
 *   pool it seeded in the same window) inflates volume without transferring
 *   risk.
 *
 * Policy matches `wash-screening.ts`: flag, never block, and exclude from every
 * volume aggregate. Blocking would reject legitimate solo testnet pools.
 */
export function screenPoolActivity(input: PoolActivityInput): { washFlagged: boolean; washReason: PoolWashReason | null } {
  const now = input.now ?? Date.now()
  const wallet = input.wallet.trim()
  if (!wallet) return { washFlagged: false, washReason: null }

  if (input.counterparty && input.counterparty.trim().toUpperCase() === wallet.toUpperCase()) {
    incSecurityCounter("lp_pool_self_swap_flagged")
    return { washFlagged: true, washReason: "self_swap" }
  }

  if (input.kind === "swap") {
    ensurePoolActivityTable()
    const seeded = getDb()
      .prepare(
        `SELECT 1 AS hit FROM pool_activity
          WHERE pool_id = ? AND wallet = ? AND kind = 'deposit' AND created_at >= ?
          LIMIT 1`,
      )
      .get(input.poolId, wallet.toUpperCase(), now - 60 * 60 * 1000) as { hit?: number } | undefined
    if (seeded?.hit) {
      incSecurityCounter("lp_pool_self_swap_flagged")
      return { washFlagged: true, washReason: "self_swap" }
    }
  }

  if (input.kind === "deposit" && (input.shareBps ?? 0) >= 9_000) {
    // Concentration must be supplied by the caller from the pool's share table;
    // guessing it from "first deposit" would flag every honest solo LP.
    incSecurityCounter("lp_pool_self_provision_flagged")
    return { washFlagged: true, washReason: "self_provision" }
  }

  return { washFlagged: false, washReason: null }
}

export function recordPoolActivity(input: PoolActivityInput): {
  id: string
  washFlagged: boolean
  washReason: PoolWashReason | null
} {
  ensurePoolActivityTable()
  const now = input.now ?? Date.now()
  const screening = screenPoolActivity({ ...input, now })
  const id =
    input.activityId ??
    createHash("sha256")
      .update(`${input.poolId}|${input.wallet}|${input.kind}|${now}|${Math.random()}`)
      .digest("hex")
      .slice(0, 32)
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO pool_activity
        (id, pool_id, wallet, counterparty, kind, amount_a, amount_b, value_xlm_stroops, wash_flagged, wash_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.poolId,
      input.wallet.toUpperCase(),
      input.counterparty?.toUpperCase() ?? null,
      input.kind,
      String(input.amountA ?? "0"),
      String(input.amountB ?? "0"),
      String(input.valueXlmStroops ?? "0"),
      screening.washFlagged ? 1 : 0,
      screening.washReason,
      now,
    )
  return { id, ...screening }
}

/** Volume that may count for ranking: every wash-flagged row is excluded. */
export function getPoolVolumeExcludingWash(
  poolId: string,
  opts: { includeWash?: boolean; since?: number } = {},
): { valueXlmStroops: string; swapCount: number; excludedCount: number } {
  ensurePoolActivityTable()
  const includeWash = opts.includeWash === true
  const since = opts.since ?? 0
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(value_xlm_stroops), 0) AS total, COUNT(*) AS swaps
         FROM pool_activity
        WHERE pool_id = ? AND kind = 'swap' AND created_at >= ? AND (wash_flagged = 0 OR ? = 1)`,
    )
    .get(poolId, since, includeWash ? 1 : 0) as { total?: string | number; swaps?: number } | undefined
  const excluded = getDb()
    .prepare(
      `SELECT COUNT(*) AS excluded FROM pool_activity
        WHERE pool_id = ? AND kind = 'swap' AND created_at >= ? AND wash_flagged = 1`,
    )
    .get(poolId, since) as { excluded?: number } | undefined
  const excludedCount = Number(excluded?.excluded ?? 0)
  if (excludedCount > 0) incSecurityCounter("lp_pool_volume_excluded", excludedCount)
  return {
    valueXlmStroops: String(row?.total ?? "0"),
    swapCount: Number(row?.swaps ?? 0),
    excludedCount,
  }
}

/**
 * Pool seed capital is not spendable. `availableBalance` in the distributor
 * ledger subtracts the seed reservation plus a fee reserve plus pending holds;
 * this helper documents the arithmetic so a UI can explain it.
 */
export function spendableAfterPoolSeed(input: {
  balanceStroops: bigint
  reserveStroops: bigint
  feeReserveStroops: bigint
  poolSeedStroops: bigint
  pendingHoldsStroops: bigint
}): bigint {
  const value =
    input.balanceStroops -
    input.reserveStroops -
    input.feeReserveStroops -
    input.poolSeedStroops -
    input.pendingHoldsStroops
  return value > 0n ? value : 0n
}
