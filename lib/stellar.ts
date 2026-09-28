// @ts-nocheck
/**
 * Stellar clÃ¡sico (Horizon) â€” asset PHASELQ alineado con TrustlineButton / stellar.toml.
 * TrustlineButton usa el `asset` devuelto por GET /api/classic-liq; ese endpoint debe usar
 * la misma resoluciÃ³n que aquÃ­ cuando no hay CLASSIC_LIQ_ISSUER_SECRET.
 */

import { Asset, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk"
import {
  classicLiqAssetConfigFromPublicEnv,
  classicLiqCodeForStellarToml,
  classicLiqIssuerForStellarToml,
  readClassicWalletStatus,
  type ClassicLiqAsset,
} from "@/lib/classic-liq"

// â”€â”€ phase-122: off-chain metadata delta storage (isolated, flag-gated) â”€â”€
// Large metadata inflates contract storage rent. Keep full JSON off-chain,
// store only hash+stub on-chain. Thin re-export keeps stellar.ts as single import.
import { computeDeltaHash as _computeDeltaHash, buildOnChainStub as _buildOnChainStub } from "@/lib/offchain-delta"
export {
  computeDeltaHash,
  buildOnChainStub,
  parseOnChainStub,
  storeOffchainDelta,
  fetchOffchainDelta,
  isDeltaEnabled,
  deltaStorageStats,
  clearDeltaMemoryStore,
  OffchainDeltaManifestSchema,
} from "@/lib/offchain-delta"
export type { OffchainDeltaManifest, DeltaStoreResult, DeltaFetchResult } from "@/lib/offchain-delta"

// â”€â”€ phase-77: wash-trading detection heuristics for listings (isolated, flag-gated) â”€â”€
// Manipulated volume is indistinguishable from real without heuristics.
// Thin re-export keeps stellar.ts as single import for market verification routes;
// core logic lives in lib/wash-trading.ts (single source of truth).
export {
  analyzeWashTradingRisk,
  detectCircularTrades,
  detectRapidFlips,
  detectSelfTrading,
  isPhase77Enabled,
  flag77RollbackNote,
  auditWashTradingWiring,
  WashTradingDetectionError,
  TradeRecordSchema,
  WashTradeAnalysisRequestSchema,
  WashTradeRiskAssessmentSchema,
} from "@/lib/wash-trading"
export type { TradeRecord, WashTradeAnalysisRequest, WashTradeRiskAssessment, WashTradePattern } from "@/lib/wash-trading"

// â”€â”€ phase-92: push notifications for replies and mentions (isolated, flag-gated) â”€â”€
// Users missed engagement without active polling. Thin re-export keeps stellar.ts
// as single import for verification-adjacent routes; core logic lives in
// lib/push-notifications.ts (single source of truth).
export {
  subscribeToPush,
  unsubscribeFromPush,
  getPushSubscriptions,
  dispatchPushNotification,
  extractMentionedWallets,
  isPhase92Enabled,
  auditPushNotificationWiring,
  PushNotificationError,
  PushSubscriptionSchema,
} from "@/lib/push-notifications"
export type { PushSubscription, PushNotificationEvent, PushDeliveryResult } from "@/lib/push-notifications"

function isPhase122Enabled(): boolean {
  const v = (typeof process !== "undefined" ? (process.env.NEXT_PUBLIC_FEATURE_PHASE_122 ?? process.env.FEATURE_PHASE_122 ?? "") : "")?.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

/**
 * Reduce on-chain size by building a minimal stub for token_uri.
 * When flag off, returns original uri unchanged (zero regression).
 */
export function toOnChainDeltaStub(tokenId: number, fullMetadata: unknown): string {
  if (!isPhase122Enabled()) {
    // Legacy path: full JSON or ipfs:// (no delta)
    if (typeof fullMetadata === "string") return fullMetadata.slice(0, 256)
    try { return JSON.stringify(fullMetadata).slice(0, 256) } catch { return "" }
  }
  const hash = _computeDeltaHash(fullMetadata)
  return _buildOnChainStub(tokenId, hash)
}

/**
 * Activo clÃ¡sico para trustline / comprobaciones Horizon: si NEXT_PUBLIC_* estÃ¡ completo,
 * coincide con Freighter; si no, cae al mismo emisor por defecto que `stellar.toml` (GAXâ€¦ + PHASELQ).
 */
export function resolvePhaserLiqClassicAsset(): ClassicLiqAsset {
  const fromEnv = classicLiqAssetConfigFromPublicEnv()
  if (fromEnv) return fromEnv
  return {
    code: classicLiqCodeForStellarToml(),
    issuer: classicLiqIssuerForStellarToml(),
  }
}

/** Mismo par (code, issuer) que `Operation.changeTrust` en TrustlineButton cuando el API usa resolve. */
export function createPhaserLiqClassicSdkAsset(): Asset {
  const a = resolvePhaserLiqClassicAsset()
  return new Asset(a.code, a.issuer)
}

/**
 * El servidor no puede firmar changeTrust por el usuario; solo comprobar Horizon antes de un payment.
 * Usar en rutas que envÃ­an PHASELQ clÃ¡sico (p. ej. bootstrap issuer â†’ wallet).
 */
export async function ensureTrustlineBeforeClassicPayment(
  walletAddress: string,
  asset: ClassicLiqAsset = resolvePhaserLiqClassicAsset(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    return { ok: false, reason: "invalid_wallet" }
  }
  const st = await readClassicWalletStatus(walletAddress, asset)
  if (!st.accountExists) return { ok: false, reason: "account_missing" }
  if (!st.hasTrustline) return { ok: false, reason: "trustline_missing" }
  return { ok: true }
}

type Jsonish = Record<string, unknown>

/** Extrae `extras.result_codes` de errores tÃ­picos de `Horizon.Server#submitTransaction`. */
export function horizonSubmitErrorDetail(err: unknown): Jsonish | string {
  if (!err || typeof err !== "object") return String(err)
  const e = err as {
    message?: string
    response?: { data?: HorizonStyleTxFailed; status?: number; statusText?: string }
  }
  const data = e.response?.data
  if (data && typeof data === "object" && "extras" in data) {
    const ex = (data as HorizonStyleTxFailed).extras
    if (ex?.result_codes) {
      return {
        message: e.message,
        httpStatus: e.response?.status,
        result_codes: ex.result_codes,
        title: (data as { title?: string }).title,
        detail: (data as { detail?: string }).detail,
      }
    }
  }
  return e.message ?? JSON.stringify(err)
}

type HorizonStyleTxFailed = {
  extras?: { result_codes?: { transaction?: string; operations?: string[] } }
  title?: string
  detail?: string
}

export function logHorizonSubmitError(tag: string, err: unknown): void {
  console.error(`[${tag}] Horizon submitTransaction failed`, horizonSubmitErrorDetail(err))
}

export function logUnknownStellarError(tag: string, err: unknown): void {
  console.error(`[${tag}]`, err instanceof Error ? err.stack ?? err.message : err)
}

function safeScValNative(v: xdr.ScVal): string | null {
  try {
    const n = scValToNative(v)
    if (n === null || n === undefined) return null
    if (typeof n === "bigint") return n.toString()
    if (typeof n === "object") return JSON.stringify(n)
    return String(n)
  } catch {
    return null
  }
}

/** Texto breve para API cuando `getTransaction` devuelve FAILED (mint Soroban). */
export function summarizeSorobanFailedMint(st: rpc.Api.GetFailedTransactionResponse): string {
  const parts: string[] = [`ledger=${st.ledger}`]
  let ihfName: string | undefined
  try {
    const results = st.resultXdr?.result()?.results()
    const first = results?.[0]
    if (first) {
      const tr = first.tr()
      parts.push(`op=${tr.switch().name}`)
      if (tr.switch().name === "invokeHostFunction") {
        try {
          const ihr = tr.invokeHostFunctionResult()
          ihfName = ihr.switch().name
          parts.push(`ihf=${ihfName}`)
        } catch {
          parts.push("ihf=?")
        }
      }
    }
  } catch {
    parts.push("op=?")
  }

  const evs = st.diagnosticEventsXdr
  if (evs?.length) {
    const fragments: string[] = []
    const start = Math.max(0, evs.length - 14)
    for (let i = start; i < evs.length; i++) {
      try {
        const ce = evs[i]!.event()
        const body = ce.body().v0()
        const topics = body.topics()
        const tNat = topics.map((t) => safeScValNative(t)).filter(Boolean) as string[]
        const dNat = safeScValNative(body.data())
        const chunk = [...tNat, dNat].filter(Boolean).join("Â·")
        if (chunk) fragments.push(chunk)
      } catch {
        /* siguiente evento */
      }
    }
    const tail = fragments.slice(-5).join(" || ")
    if (tail) parts.push(`diag=${tail.slice(0, 480)}`)
  }

  if (ihfName === "invokeHostFunctionTrapped") {
    parts.push(
      "nota=ihf_trapped: el WASM del contrato abortÃ³ (p. ej. Unauthorized, lÃ­mite supply, panic). Verifica que ADMIN_SECRET_KEY sea el minter del TOKEN_ADDRESS desplegado y que el contrato coincida con testnet.",
    )
  }

  return parts.join(" Â· ")
}

export const PHASE_SETTLE_FUNCTION_NAME = "settle"

type SettleEventVerification = {
  ok: true
  ledger: number
  amountStroops: bigint
} | {
  ok: false
  code: string
  reason: string
  ledger?: number
}

type VerifySettleParams = {
  txHash: string
  contractId?: string
  expectedContractId?: string
  minAmountStroops?: bigint | number | string
  expectedMinAmountStroops?: bigint | number | string
  amountStroops?: bigint | number | string
  rpcUrl?: string
}

export async function verifyPhaseSettleTxOnChain(
  txHashOrParams: string | VerifySettleParams,
  maybeContractId?: string,
  maybeMinAmountStroops?: bigint | number | string,
  maybeRpcUrl?: string,
): Promise<SettleEventVerification> {
  const params: VerifySettleParams =
    typeof txHashOrParams === "string"
      ? {
          txHash: txHashOrParams,
          contractId: maybeContractId,
          minAmountStroops: maybeMinAmountStroops,
          rpcUrl: maybeRpcUrl,
        }
      : txHashOrParams

  const contractId = params.contractId ?? params.expectedContractId
  const minAmountStroops =
    params.minAmountStroops ?? params.expectedMinAmountStroops ?? params.amountStroops
  if (!contractId || minAmountStroops === undefined) {
    return { ok: false, code: "BAD_PARAMS", reason: "contractId and minAmountStroops are required" }
  }

  const rpcUrl =
    params.rpcUrl ??
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
    process.env.SOROBAN_RPC_URL ??
    "https://soroban-testnet.stellar.org"
  const server = new rpc.Server(rpcUrl)
  const tx = await server.getTransaction(params.txHash)

  if (tx.status === "NOT_FOUND") {
    return { ok: false, code: "TX_NOT_FOUND", reason: "settlement transaction not found on chain" }
  }
  if (tx.status === "FAILED") {
    return { ok: false, code: "TX_FAILED", reason: "settlement transaction failed on chain", ledger: tx.ledger }
  }
  if (typeof tx.ledger !== "number") {
    return { ok: false, code: "META_MISSING", reason: "settlement transaction ledger missing" }
  }
  if (!tx.resultMetaXdr) {
    return { ok: false, code: "META_MISSING", reason: "settlement transaction result meta missing" }
  }

  const expectedRaw = decodeContractId(contractId)
  if (!expectedRaw) {
    return { ok: false, code: "BAD_CONTRACT_ID", reason: "expected contract id is not a valid Stellar contract address" }
  }
  const minAmount = BigInt(minAmountStroops)
  const events = sorobanEventsFromTransactionMeta(tx.resultMetaXdr)

  for (const event of events) {
    const parsed = parseSettleEvent(event)
    if (!parsed) continue
    if (!parsed.contractId.equals(expectedRaw)) continue
    if (parsed.amount < minAmount) continue
    return { ok: true, ledger: tx.ledger, amountStroops: parsed.amount }
  }

  return { ok: false, code: "SETTLE_EVENT_NOT_FOUND", reason: "no valid settle event with required payment on chain", ledger: tx.ledger }
}

function decodeContractId(contractId: string): Buffer | null {
  try {
    return Buffer.from(StrKey.decodeContract(contractId))
  } catch {
    return null
  }
}

function sorobanEventsFromTransactionMeta(meta: xdr.TransactionMeta): xdr.ContractEvent[] {
  try {
    const sorobanMeta = meta.v3().sorobanMeta()
    if (sorobanMeta) return sorobanMeta.events()
  } catch {
    // Try older meta version below.
  }
  try {
    const sorobanMeta = meta.v1().sorobanMeta()
    if (sorobanMeta) return sorobanMeta.events()
  } catch {
    // No Soroban events available.
  }
  return []
}

type ParsedSettleEvent = {
  contractId: Buffer
  amount: bigint
}

function parseSettleEvent(event: xdr.ContractEvent): ParsedSettleEvent | null {
  try {
    const v0 = event.body().v0()
    const topics = v0.topics()
    if (topics.length === 0) return null
    const functionName = scValToNative(topics[0]!)
    if (functionName !== PHASE_SETTLE_FUNCTION_NAME) return null
    let amount = scValToEventAmount(v0.data())
    if (amount === null) {
      for (const topic of topics.slice(1)) {
        amount = scValToEventAmount(topic)
        if (amount !== null) break
      }
    }
    if (amount === null) return null
    const contractId = Buffer.from(v0.contractId() as unknown as Uint8Array)
    return { contractId, amount }
  } catch {
    return null
  }
}

function scValToEventAmount(data: xdr.ScVal): bigint | null {
  try {
    const native = scValToNative(data)
    if (typeof native === "bigint") return native
    if (typeof native === "number" && Number.isInteger(native) && native >= 0) return BigInt(native)
    if (typeof native === "string" && /^[0-9]+$/.test(native)) return BigInt(native)
    if (native && typeof native === "object") {
      const record = native as Record<string, unknown>
      for (const key of ["amount", "value", "amount_stroops", "stroops"]) {
        const candidate = record[key]
        if (typeof candidate === "bigint") return candidate
        if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) return BigInt(candidate)
        if (typeof candidate === "string" && /^[0-9]+$/.test(candidate)) return BigInt(candidate)
      }
    }
  } catch {
    // Ignore unparsable values.
  }
  return null
}

