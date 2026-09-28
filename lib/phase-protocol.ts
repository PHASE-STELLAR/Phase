/** Soroban / PHASE protocol — shared client helpers */

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  extractBaseAddress,
  FeeBumpTransaction,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk"
import { validatePhaseEnv, formatEnvValidationErrors } from "@/lib/env-validation"
import {
  DEFAULT_LIQUIDITY_ASSET_CODE,
  DEFAULT_LIQUIDITY_ISSUER,
  DEFAULT_PHASE_CONTRACT,
  DEFAULT_TOKEN_CONTRACT,
} from "@/lib/phase-contract-defaults"
import { getGatewayHealthSnapshot as _getGatewayHealthSnapshot, recordGatewayLatency as _recordGatewayLatency } from "@/lib/gateway-health"
import { withHorizonBulkhead } from "@/lib/horizon-bulkhead"

// ── phase-121: gateway health dashboard (isolated, flag-gated) ──
// Operators cannot see which gateway is slow. Scoring lives in @/lib/gateway-health;
// this re-export keeps phase-protocol as the single import for UI/API.
export { recordGatewayLatency, getGatewayHealthSnapshot, getGatewayRanking, resetGatewayHealth } from "@/lib/gateway-health"
export type { GatewayHealthEntry, GatewayHealthSnapshot } from "@/lib/gateway-health"

function isPhase121Enabled(): boolean {
  const v = (typeof process !== "undefined" ? (process.env.NEXT_PUBLIC_FEATURE_PHASE_121 ?? process.env.FEATURE_PHASE_121 ?? "") : "")?.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}
// Light wrapper for dashboard consumers (adds flag context, structured error)
export function getGatewayHealthDashboardSafe(): { enabled: boolean; snapshot: import("@/lib/gateway-health").GatewayHealthSnapshot | null; error: string | null } {
  if (!isPhase121Enabled()) return { enabled: false, snapshot: null, error: "phase-121 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_121=1)" }
  try {
    return { enabled: true, snapshot: _getGatewayHealthSnapshot(), error: null }
  } catch (e) {
    return { enabled: true, snapshot: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// Validación temprana de entorno en build/startup
if (typeof process !== "undefined" && process.env.NODE_ENV !== "test") {
  const validation = validatePhaseEnv()
  if (!validation.valid) {
    // En desarrollo, mostrar advertencias claras
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.warn(formatEnvValidationErrors(validation))
    }
  }
}

/**
 * Soroban contract IDs use strkey prefix **C** (56 chars). A **G** address is a classic *account*, not a contract —
 * using it in `Contract` or WASM fetch causes `Invalid contract ID: G…` from the SDK.
 */
function sorobanContractIdFromEnv(
  envKeys: (string | undefined)[],
  fallback: string,
  settingName: string,
): string {
  const raw = envKeys.map((k) => k?.trim()).find((v) => v && v.length > 0)
  const id = raw ?? fallback
  if (StrKey.isValidContract(id)) return id
  if (StrKey.isValidEd25519PublicKey(id)) {
    throw new Error(
      `[PHASE] ${settingName}: "${id.slice(0, 8)}…" is a Stellar account (G…), not a Soroban contract (C…). ` +
        `Remove it from env or paste the contract ID from \`stellar contract deploy\` / Stellar Expert (contract page).`,
    )
  }
  throw new Error(
    `[PHASE] ${settingName}: not a valid Soroban contract strkey (expected C…). Got: "${id.slice(0, 12)}…"`,
  )
}

export const CONTRACT_ID = (() => {
  const e = (typeof process !== "undefined" ? process.env : {}) as NodeJS.ProcessEnv
  // Solo NEXT_PUBLIC_*: PHASE_PROTOCOL_ID (sin prefijo) no existe en el bundle del cliente → hydration mismatch.
  return sorobanContractIdFromEnv(
    [e.NEXT_PUBLIC_PHASE_PROTOCOL_ID],
    DEFAULT_PHASE_CONTRACT,
    "PHASE protocol (NEXT_PUBLIC_PHASE_PROTOCOL_ID)",
  )
})()

/**
 * Rutas API / solo Node: permite `PHASE_PROTOCOL_ID` si aún no duplicaste el valor en `NEXT_PUBLIC_*`.
 * No uses esto en componentes cliente.
 */
export function phaseProtocolContractIdForServer(): string {
  const e = process.env
  return sorobanContractIdFromEnv(
    [e.NEXT_PUBLIC_PHASE_PROTOCOL_ID, e.PHASE_PROTOCOL_ID],
    DEFAULT_PHASE_CONTRACT,
    "PHASE protocol (server: NEXT_PUBLIC_PHASE_PROTOCOL_ID / PHASE_PROTOCOL_ID)",
  )
}

/** Contrato PHASE (NFT de utilidad) en Stellar Expert — testnet */
export function stellarExpertTestnetContractUrl(contractId: string = CONTRACT_ID) {
  return `https://stellar.expert/explorer/testnet/contract/${contractId}`
}

/**
 * PHASELQ en Stellar Expert (asset clásico testnet, emisor por defecto).
 */
export const PHASER_LIQ_STELLAR_EXPERT_DEFAULT =
  `https://stellar.expert/explorer/testnet/asset/${DEFAULT_LIQUIDITY_ASSET_CODE}-${DEFAULT_LIQUIDITY_ISSUER}`

/**
 * Enlace Stellar Expert (asset clásico PHASELQ).
 * Solo usa `NEXT_PUBLIC_*` (y fallback) para que SSR y el bundle del cliente coincidan;
 * `PHASER_LIQ_EXPERT_URL` sin prefijo es server-only en Next.js y provocaba hydration mismatch.
 */
export function stellarExpertPhaserLiqUrl(): string {
  const e = (typeof process !== "undefined" ? process.env : {}) as NodeJS.ProcessEnv
  const custom = e.NEXT_PUBLIC_PHASER_LIQ_EXPERT_URL?.trim()
  if (custom) return custom
  const code = e.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE?.trim() || DEFAULT_LIQUIDITY_ASSET_CODE
  const iss = e.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER?.trim()
  if (iss && StrKey.isValidEd25519PublicKey(iss)) {
    return `https://stellar.expert/explorer/testnet/asset/${code}-${iss}`
  }
  return PHASER_LIQ_STELLAR_EXPERT_DEFAULT
}

/** Certificado JSON tras verificar propiedad (`get_user_phase`) en el cliente. */
export function downloadPhaseUtilityCertificate(opts: {
  contractId: string
  tokenId: number
  ownerAddress: string
  collectionId: number
  collectionName?: string
  energyLevelBp: number
}) {
  if (typeof document === "undefined") return
  const body = JSON.stringify(
    {
      $schema: "phase.certificate/v1",
      network: "soroban-testnet",
      contractId: opts.contractId,
      utilityTokenId: opts.tokenId,
      owner: opts.ownerAddress,
      collectionId: opts.collectionId,
      collectionName: opts.collectionName ?? null,
      energyLevelBp: opts.energyLevelBp,
      issuedAt: new Date().toISOString(),
    },
    null,
    2,
  )
  const blob = new Blob([body], { type: "application/json;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `PHASE_certificate_token_${opts.tokenId}.json`
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export const RPC_URL = "https://soroban-testnet.stellar.org"

/**
 * Soroban RPC público no envía CORS; el navegador no puede llamarlo directamente.
 * En cliente: mismo origen → `/api/soroban-rpc`. Override opcional: `NEXT_PUBLIC_SOROBAN_RPC_PROXY_URL` (URL absoluta con CORS).
 * Si la app se sirve bajo subruta (p. ej. `https://host/PHASEPROTOCOL`), define `NEXT_PUBLIC_BASE_PATH=/PHASEPROTOCOL`
 * o deja que se infiera desde `<script src="…/_next/…">` (reverse proxy sin `basePath` en next.config).
 */
function inferClientBasePathFromNextScripts(): string {
  if (typeof document === "undefined") return ""
  const scripts = document.getElementsByTagName("script")
  for (let i = 0; i < scripts.length; i++) {
    const src = scripts[i]?.src
    if (!src) continue
    try {
      const u = new URL(src, window.location.href)
      if (u.origin !== window.location.origin) continue
      const idx = u.pathname.indexOf("/_next/")
      if (idx > 0) return u.pathname.slice(0, idx)
    } catch {
      /* ignore */
    }
  }
  return ""
}

function effectiveSorobanRpcUrl(): string {
  if (typeof window !== "undefined") {
    const pub = process.env.NEXT_PUBLIC_SOROBAN_RPC_PROXY_URL?.trim()
    if (pub && /^https?:\/\//i.test(pub)) return pub
    const envBase = (process.env.NEXT_PUBLIC_BASE_PATH?.trim() || "").replace(/\/$/, "").replace(/^\/+/, "")
    const inferred = inferClientBasePathFromNextScripts().replace(/\/$/, "").replace(/^\/+/, "")
    const base = envBase || inferred
    const prefix = base ? `/${base}` : ""
    return `${window.location.origin}${prefix}/api/soroban-rpc`
  }
  return process.env.STELLAR_RPC_URL?.trim() || RPC_URL
}
/** Classic accounts (G…): sequence comes from Horizon; Soroban RPC does not implement `getAccount`. */
export const HORIZON_URL = "https://horizon-testnet.stellar.org"
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"

/**
 * `TransactionBuilder#setTimeout(n)` fija `max_time` = epoch actual + **n segundos** (no ledgers).
 * 30s en txs firmadas en wallet provoca `txTooLate` si Freighter tarda en mostrar/firmar.
 */
const SIMULATE_TX_TIMEBOUND_SEC = 30
const WALLET_SIGN_TX_TIMEBOUND_SEC = 600

/** Cuenta clásica G… (56 chars) válida para Freighter / transferencias. */
export function isValidClassicStellarAddress(addr: string): boolean {
  const t = addr.trim()
  if (!t.startsWith("G") || t.length !== 56) return false
  return StrKey.isValidEd25519PublicKey(t)
}

/**
 * SAC (Stellar Asset Contract) de PHASELQ para issuer por defecto (testnet).
 * Coincide con `DEFAULT_TOKEN_CONTRACT` en `lib/phase-contract-defaults.ts`.
 */
export function expectedDefaultPhaserLiqSACContractId(): string {
  return DEFAULT_TOKEN_CONTRACT
}

/** Contrato del token de liquidez del protocolo (Soroban). */
export const TOKEN_ADDRESS = (() => {
  const e = (typeof process !== "undefined" ? process.env : {}) as NodeJS.ProcessEnv
  // Solo NEXT_PUBLIC_* (+ MOCK en servidor de tests); nunca TOKEN_CONTRACT_ID solo-server en UI compartida.
  return sorobanContractIdFromEnv(
    [e.NEXT_PUBLIC_PHASER_TOKEN_ID, e.NEXT_PUBLIC_TOKEN_CONTRACT_ID, e.MOCK_TOKEN_ID],
    DEFAULT_TOKEN_CONTRACT,
    "PHASELQ token (NEXT_PUBLIC_PHASER_TOKEN_ID / NEXT_PUBLIC_TOKEN_CONTRACT_ID / MOCK_TOKEN_ID)",
  )
})()

/**
 * Rutas API / solo Node: incluye `PHASER_TOKEN_ID`, `TOKEN_CONTRACT_ID` sin prefijo público.
 * No uses esto en componentes cliente.
 */
export function tokenContractIdForServer(): string {
  const e = process.env
  return sorobanContractIdFromEnv(
    [
      e.NEXT_PUBLIC_PHASER_TOKEN_ID,
      e.PHASER_TOKEN_ID,
      e.NEXT_PUBLIC_TOKEN_CONTRACT_ID,
      e.TOKEN_CONTRACT_ID,
      e.MOCK_TOKEN_ID,
    ],
    DEFAULT_TOKEN_CONTRACT,
    "PHASELQ token (server: NEXT_PUBLIC_* / PHASER_TOKEN_ID / TOKEN_CONTRACT_ID / MOCK_TOKEN_ID)",
  )
}

/** Marca oficial del combustible x402 en UI (7 decimales; código clásico PHASELQ). */
export const PHASER_LIQ_SYMBOL = DEFAULT_LIQUIDITY_ASSET_CODE

/**
 * Normaliza símbolo on-chain / Horizon / `.env` legacy a la marca UI **PHASELQ**.
 * Incluye mayúsculas, `PHASER_LIQ`, bytes nulos de XDR, etc.
 */
export function displayPhaserLiqSymbol(onChainSymbol: string | null | undefined): string {
  const s = (onChainSymbol ?? "")
    .trim()
    .replace(/\0/g, "")
    .trim()
  if (!s) return PHASER_LIQ_SYMBOL
  const compact = s.replace(/_/g, "").toUpperCase()
  if (compact === "PHASERLIQ") return PHASER_LIQ_SYMBOL
  if (s.toUpperCase() === "PHASER") return PHASER_LIQ_SYMBOL
  if (compact === "PHASELQ") return PHASER_LIQ_SYMBOL
  return s
}
export const PHASER_LIQ_NAME = "Phase Liquidity Token"
export const PHASER_LIQ_DECIMALS = 7
export const PHASER_LIQ_ICON_PUBLIC_PATH = "/phaser-liq-token.png"

/** Por debajo de 1.00 PHASELQ el monitor puede ofrecer el faucet. */
export const PHASER_FAUCET_THRESHOLD_STROOPS = "10000000"

/** Cantidad que emite el faucet por solicitud (10.00 PHASELQ). */
export const PHASER_FAUCET_MINT_STROOPS = "100000000"

/** Precio x402 colección 0 (pool protocolo PHASE) — unidades mínimas PHASELQ */
export const REQUIRED_AMOUNT = "10000000"

export function balanceBelowFaucetThreshold(balanceStroops: string): boolean {
  try {
    return BigInt(balanceStroops || "0") < BigInt(PHASER_FAUCET_THRESHOLD_STROOPS)
  } catch {
    return parseInt(balanceStroops, 10) < parseInt(PHASER_FAUCET_THRESHOLD_STROOPS, 10)
  }
}

/**
 * Cuenta G en testnet con XLM (fee source mínimo para armar tx de simulación).
 * Si `NEXT_PUBLIC_SOROBAN_SIM_ACCOUNT` apunta a una G **sin** cuenta en testnet, se usa este fallback.
 */
export const DEFAULT_READONLY_SIM_SOURCE_G =
  "GAVLW5IKB7VFBRJ3EHBE4BRZ5OX3AOW3ICMLMB6KVKCQDO6WJ2SPHDN3"

/**
 * Cuenta G en testnet con fondos, solo como fee source en simulaciones de lectura
 * (`get_collection`, `token_uri`, …). Override: `NEXT_PUBLIC_SOROBAN_SIM_ACCOUNT` (debe existir en testnet).
 */
export const READONLY_SIM_SOURCE_G =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_SOROBAN_SIM_ACCOUNT?.trim()
    ? process.env.NEXT_PUBLIC_SOROBAN_SIM_ACCOUNT.trim()
    : DEFAULT_READONLY_SIM_SOURCE_G

/** El SDK rechaza URLs `http://` (p. ej. `http://localhost:3000/api/soroban-rpc`) sin este flag. */
function newRpcServerForUrl(url: string): rpc.Server {
  const allowHttp = url.toLowerCase().startsWith("http://")
  return new rpc.Server(url, allowHttp ? { allowHttp: true } : undefined)
}

let _rpcServer: rpc.Server | null = null
let _cachedRpcUrl: string | null = null
function getRpc(): rpc.Server {
  const url = effectiveSorobanRpcUrl()
  if (_rpcServer && _cachedRpcUrl === url) return _rpcServer
  _cachedRpcUrl = url
  _rpcServer = newRpcServerForUrl(url)
  return _rpcServer
}

function numLikeToNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === "bigint") return Number(v)
  if (typeof v === "string") return parseInt(v, 10) || 0
  return 0
}

function addressLikeToString(v: unknown): string {
  if (typeof v === "string") return v
  if (v != null && typeof v === "object" && "toString" in v) return String((v as { toString: () => string }).toString())
  return ""
}

let warnedSimFeeSourceFallback = false

class HorizonAccountNotFoundError extends Error {
  constructor() {
    super("HORIZON_ACCOUNT_NOT_FOUND")
    this.name = "HorizonAccountNotFoundError"
  }
}

/** Secuencia de cuenta clásica (G…) vía Horizon — tolera fallos del RPC al resolver ledger entries. */
async function loadClassicAccountFromHorizon(publicKey: string): Promise<Account> {
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(publicKey)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (res.status === 404) {
    throw new HorizonAccountNotFoundError()
  }
  if (!res.ok) {
    throw new Error(`Horizon HTTP ${res.status} al leer cuenta ${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`)
  }
  const data = (await res.json()) as { sequence?: string }
  const seq = data.sequence
  if (seq == null || seq === "") {
    throw new Error("Horizon devolvió cuenta sin sequence.")
  }
  return new Account(publicKey, String(seq))
}

/**
 * El SDK a veces lanza el `error` JSON-RPC como objeto `{ code, message }` (no `Error`).
 * Axios lanza `Error` con "Request failed with status code 503" sin el cuerpo JSON-RPC.
 */
function normalizeSorobanSdkError(err: unknown): Error {
  if (err instanceof Error) {
    const m = err.message || ""
    const m503 = m.match(/status code (\d{3})/)
    const st = m503 ? parseInt(m503[1], 10) : NaN
    if (st >= 502 && st <= 504) {
      return new Error(
        `El RPC Soroban no respondió (HTTP ${st}). Reintenta en unos segundos; si persiste, define ` +
          `STELLAR_RPC_FALLBACK_URLS o sube SOROBAN_PROXY_FETCH_TIMEOUT_MS en .env.local.`,
      )
    }
    return err
  }
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>
    const msg = o.message
    if (typeof msg === "string" && msg.trim() && typeof o.code === "number") {
      return new Error(msg.trim())
    }
    const res = o.response as { status?: number; data?: unknown } | undefined
    if (res && typeof res.status === "number" && res.status >= 502 && res.status <= 504) {
      const data = res.data
      if (data && typeof data === "object") {
        const inner = (data as { error?: { message?: string } }).error?.message
        if (typeof inner === "string" && inner.trim()) return new Error(inner.trim())
      }
      return new Error(
        `El proxy Soroban devolvió HTTP ${res.status}. Reintenta; configura STELLAR_RPC_FALLBACK_URLS o un RPC dedicado.`,
      )
    }
  }
  if (typeof err === "string") return new Error(err)
  return new Error(String(err))
}

function sleepRpcMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Backoff exponencial entre intentos: 1s, 2s, 4s, … tras cada fallo transitorio.
 * `failureIndex` 0 = primer reintento, 1 = segundo, etc.
 */
function sorobanExponentialBackoffMs(failureIndex: number): number {
  const i = Math.max(0, Math.min(failureIndex, 8))
  return 1000 * 2 ** i
}

function isTransientRpcFailure(err: unknown): boolean {
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>
    if (o.code === -32603) return true
    const res = o.response as { status?: number } | undefined
    if (res?.status != null && res.status >= 502 && res.status <= 504) return true
    if (res?.status === 429) return true
  }
  if (err instanceof Error) {
    const m = err.message
    if (/Request failed with status code (50[234]|429)/i.test(m)) return true
    if (
      /timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|fetch failed|bad gateway|service unavailable|socket hang up/i.test(
        m,
      )
    ) {
      return true
    }
    if (/Soroban RPC no disponible|no disponible tras reintentos|upstream|El RPC Soroban no respondió|El proxy Soroban devolvió/i.test(m)) {
      return true
    }
  }
  return false
}

async function withSorobanRpcRetries<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleepRpcMs(sorobanExponentialBackoffMs(i - 1))
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!isTransientRpcFailure(e)) {
        throw normalizeSorobanSdkError(e)
      }
      if (i === attempts - 1) break
    }
  }
  throw normalizeSorobanSdkError(last)
}

async function prepareTransactionWithRetry(server: rpc.Server, tx: Transaction): Promise<Transaction> {
  return withSorobanRpcRetries(() => server.prepareTransaction(tx))
}

/**
 * Cualquier G válida sirve como fee source **solo** para armar el envelope de simulación;
 * si esa cuenta no existe en testnet (env mal puesto o wallet sin fondear), usamos una G conocida con XLM.
 */
async function rpcGetAccountForSimulation(
  server: rpc.Server,
  preferredG: string,
): Promise<Awaited<ReturnType<typeof server.getAccount>>> {
  try {
    return await withSorobanRpcRetries(() => server.getAccount(preferredG))
  } catch (rpcErr) {
    if (!StrKey.isValidEd25519PublicKey(preferredG) || preferredG === DEFAULT_READONLY_SIM_SOURCE_G) {
      throw rpcErr
    }
    try {
      return await loadClassicAccountFromHorizon(preferredG)
    } catch (hzErr) {
      if (hzErr instanceof HorizonAccountNotFoundError) {
        if (!warnedSimFeeSourceFallback) {
          warnedSimFeeSourceFallback = true
          // eslint-disable-next-line no-console
          console.warn(
            `[PHASE] Soroban sim fee source ${preferredG.slice(0, 8)}… not on testnet (unset NEXT_PUBLIC_SOROBAN_SIM_ACCOUNT or fund it). Using built-in sim account.`,
          )
        }
        return await withSorobanRpcRetries(() => server.getAccount(DEFAULT_READONLY_SIM_SOURCE_G))
      }
      throw rpcErr
    }
  }
}

/**
 * Cuenta **fuente** de una tx que firma el usuario: debe existir en testnet con secuencia válida.
 * El RPC a veces falla (proxy 404, red) y el SDK puede etiquetarlo como “Account not found”; Horizon confirma si la cuenta existe.
 */
async function rpcGetUserSourceAccount(
  server: rpc.Server,
  userGAddress: string,
): Promise<Awaited<ReturnType<typeof server.getAccount>>> {
  const g = userGAddress.trim()
  if (!StrKey.isValidEd25519PublicKey(g)) {
    throw new Error("Dirección Stellar inválida: se espera una clave pública G… de 56 caracteres.")
  }
  try {
    return await withSorobanRpcRetries(() => server.getAccount(g))
  } catch (rpcErr) {
    try {
      return await loadClassicAccountFromHorizon(g)
    } catch (hzErr) {
      if (hzErr instanceof HorizonAccountNotFoundError) {
        throw new Error(
          `Tu cuenta aún no existe en Stellar testnet (hace falta XLM). Fondeala con Friendbot o el creador de cuentas del Laboratory antes de firmar. Wallet: ${g.slice(0, 6)}…${g.slice(-4)}`,
        )
      }
      const rpcMsg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
      const hzMsg = hzErr instanceof Error ? hzErr.message : String(hzErr)
      throw new Error(
        `No se pudo cargar tu cuenta para firmar. RPC: ${rpcMsg} · Horizon: ${hzMsg}. ` +
          `Si la app está bajo una subruta (p. ej. /PHASEPROTOCOL), define NEXT_PUBLIC_BASE_PATH con esa ruta y reinicia.`,
      )
    }
  }
}

/**
 * Simulación de solo lectura: cada llamada obtiene secuencia actual del fee source, arma un tx nuevo
 * y pide simulación al RPC (sin reutilizar footprint ni resultado de peticiones anteriores).
 */
async function simulateContractCall(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  feeSourceGAddress: string,
): Promise<unknown> {
  const server = getRpc()
  const acc = await rpcGetAccountForSimulation(server, feeSourceGAddress)
  const c = new Contract(contractId)
  const tx = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(c.call(method, ...args))
    .setTimeout(SIMULATE_TX_TIMEBOUND_SEC)
    .build()
  const sim = await withSorobanRpcRetries(() => server.simulateTransaction(tx))
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error)
  }
  if (!sim.result?.retval) return null
  return scValToNative(sim.result.retval)
}

/** Respuesta de `get_config` en el contrato PHASE (token autorizado + monto mínimo legado). */
export type PhaseProtocolChainConfig = {
  tokenAddress: string
  requiredAmount: string
}

let phaseProtocolConfigCache: { value: PhaseProtocolChainConfig; at: number } | null = null
const PHASE_PROTOCOL_CONFIG_TTL_MS = 60_000
/** Tras un fallo de RPC (p. ej. 503 en ráfaga), no repetir `get_config` al instante. */
let phaseProtocolConfigFetchFailedAt = 0
const PHASE_PROTOCOL_CONFIG_FAIL_COOLDOWN_MS = 15_000

function parsePhaseGetConfigNative(native: unknown): PhaseProtocolChainConfig | null {
  if (native == null) return null
  let tokenPart: unknown
  let amountPart: unknown
  if (Array.isArray(native) && native.length >= 2) {
    tokenPart = native[0]
    amountPart = native[1]
  } else if (native && typeof native === "object") {
    const o = native as Record<string, unknown>
    if ("0" in o && "1" in o) {
      tokenPart = o["0"]
      amountPart = o["1"]
    } else {
      return null
    }
  } else {
    return null
  }

  const tokenStr = addressLikeToString(tokenPart)
  if (!StrKey.isValidContract(tokenStr)) return null

  let requiredAmount = "0"
  if (typeof amountPart === "bigint") requiredAmount = amountPart.toString()
  else if (typeof amountPart === "number") requiredAmount = String(Math.trunc(amountPart))
  else if (amountPart != null) {
    try {
      requiredAmount = BigInt(String(amountPart)).toString()
    } catch {
      requiredAmount = "0"
    }
  }
  return { tokenAddress: tokenStr, requiredAmount }
}

/**
 * Lee del despliegue PHASE qué contrato SAC está autorizado (`initialize`).
 * Evita `UnauthorizedToken` (contract error #4) cuando `.env` apunta a otro C… que el registrado on-chain.
 */
export async function getPhaseProtocolConfigFromChain(): Promise<PhaseProtocolChainConfig | null> {
  const now = Date.now()
  if (phaseProtocolConfigCache && now - phaseProtocolConfigCache.at < PHASE_PROTOCOL_CONFIG_TTL_MS) {
    return phaseProtocolConfigCache.value
  }
  if (now - phaseProtocolConfigFetchFailedAt < PHASE_PROTOCOL_CONFIG_FAIL_COOLDOWN_MS) {
    return phaseProtocolConfigCache?.value ?? null
  }
  try {
    const native = await simulateContractCall(CONTRACT_ID, "get_config", [], READONLY_SIM_SOURCE_G)
    const parsed = parsePhaseGetConfigNative(native)
    phaseProtocolConfigFetchFailedAt = 0
    if (parsed) {
      phaseProtocolConfigCache = { value: parsed, at: now }
    }
    return parsed
  } catch {
    phaseProtocolConfigFetchFailedAt = now
    return phaseProtocolConfigCache?.value ?? null
  }
}

/** SAC que `initiate_phase` / `settle` aceptan para este `CONTRACT_ID` (fallback: env). */
export async function getPhaseProtocolAuthorizedTokenContractId(): Promise<string> {
  const cfg = await getPhaseProtocolConfigFromChain()
  return cfg?.tokenAddress ?? TOKEN_ADDRESS
}

/**
 * Saldo en el **mismo** contrato SAC que usa el protocolo en `settle` / `initiate_phase`
 * (lectura `balance` vía simulación). Puede ser 0 aunque Freighter muestre PHASELQ/PHASERLIQ de **otro** emisor o línea clásica distinta del SAC.
 */
export async function getProtocolSettleTokenBalance(address: string): Promise<string> {
  const g = address.trim()
  if (!StrKey.isValidEd25519PublicKey(g)) return "0"
  try {
    const cid = await getPhaseProtocolAuthorizedTokenContractId()
    const native = await simulateContractCall(
      cid,
      "balance",
      [Address.fromString(g).toScVal()],
      READONLY_SIM_SOURCE_G,
    )
    if (native == null) return "0"
    if (typeof native === "bigint") return native.toString()
    if (typeof native === "number") return String(Math.trunc(native))
    try {
      return BigInt(String(native)).toString()
    } catch {
      return "0"
    }
  } catch {
    return "0"
  }
}

function warnDevIfEnvTokenDiffersFromChain(liquidToken: string): void {
  if (typeof process === "undefined" || process.env.NODE_ENV !== "development") return
  if (liquidToken === TOKEN_ADDRESS) return
  // eslint-disable-next-line no-console
  console.warn(
    `[PHASE] NEXT_PUBLIC_TOKEN_CONTRACT_ID (${TOKEN_ADDRESS.slice(0, 8)}…) ≠ token autorizado on-chain (${liquidToken.slice(0, 8)}…). ` +
      `Usando el de la cadena para initiate_phase/settle.`,
  )
}

export type CollectionInfo = {
  collectionId: number
  creator: string
  name: string
  /** Unidades mínimas del token (string para i128) */
  price: string
  /** URL de arte en `token_uri` on-chain (puede estar vacío). */
  imageUri: string
}

/** Convierte cantidad LIQ humana (ej. 1 o 1.5) a stroops (7 decimales). */
export function liqToStroops(liq: string): string {
  const n = parseFloat(liq.replace(",", "."))
  if (Number.isNaN(n) || n <= 0) return "0"
  return Math.round(n * 10_000_000).toString()
}

export function stroopsToLiqDisplay(stroops: string): string {
  const v = parseInt(stroops, 10)
  if (Number.isNaN(v)) return "0.00"
  return (v / 10_000_000).toFixed(2)
}

export async function getAccountSequence(address: string): Promise<string> {
  const response = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(address)}`, {
    headers: { Accept: "application/json" },
  })
  if (response.status === 404) {
    throw new Error(
      "Account not found on Stellar testnet. Fund this address with test XLM (e.g. Friendbot) before signing transactions.",
    )
  }
  if (!response.ok) {
    const snippet = (await response.text()).slice(0, 240)
    throw new Error(`Horizon account lookup failed (${response.status}): ${snippet}`)
  }
  const data = (await response.json()) as { sequence?: string }
  if (data.sequence == null || data.sequence === "") {
    throw new Error("Horizon response missing account sequence.")
  }
  return data.sequence
}

function classicLiqCodeFromPublicEnv(): string {
  const e = (typeof process !== "undefined" ? process.env : {}) as NodeJS.ProcessEnv
  return e.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE?.trim() || DEFAULT_LIQUIDITY_ASSET_CODE
}

function classicLiqIssuerFromPublicEnv(): string {
  const e = (typeof process !== "undefined" ? process.env : {}) as NodeJS.ProcessEnv
  const g = e.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER?.trim() ?? ""
  if (g && StrKey.isValidEd25519PublicKey(g)) return g
  return DEFAULT_LIQUIDITY_ISSUER
}

/** Saldo trustline en Horizon → stroops (7 decimales), alineado a Freighter. */
const STROOPS_PER_LIQ_UNIT = BigInt(10_000_000)

function horizonBalanceStringToStroops(balance: string): bigint {
  const s = balance.trim()
  if (!s) return BigInt(0)
  const parts = s.split(".")
  const whole = BigInt(parts[0] || "0")
  const fracRaw = parts[1] ?? ""
  const frac7 = (fracRaw + "0000000").slice(0, 7)
  return whole * STROOPS_PER_LIQ_UNIT + BigInt(frac7 || "0")
}

/**
 * Suma trustlines Horizon con el mismo `asset_code` (p. ej. PHASELQ), cualquier emisor.
 * Así coincide con Freighter aunque `.env` apunte a un emisor y la wallet tenga el legado (u otro).
 */
async function horizonSumPhaserLiqByCodeStroops(walletG: string): Promise<bigint> {
  const code = classicLiqCodeFromPublicEnv()
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(walletG)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) return BigInt(0)
    const data = (await res.json()) as {
      balances?: Array<{ asset_type?: string; asset_code?: string; balance?: string }>
    }
    let total = BigInt(0)
    for (const b of data.balances ?? []) {
      if (!b.balance || b.asset_type === "native") continue
      if (b.asset_code !== code) continue
      total += horizonBalanceStringToStroops(b.balance)
    }
    return total
  } catch {
    return BigInt(0)
  }
}

function phaserLiqSorobanContractIdsForBalanceRead(): string[] {
  const code = classicLiqCodeFromPublicEnv()
  const pass = NETWORK_PASSPHRASE
  const ids = new Set<string>()
  ids.add(TOKEN_ADDRESS)
  for (const iss of [classicLiqIssuerFromPublicEnv(), DEFAULT_LIQUIDITY_ISSUER]) {
    if (StrKey.isValidEd25519PublicKey(iss)) {
      try {
        ids.add(new Asset(code, iss).contractId(pass))
      } catch {
        /* ignore */
      }
    }
  }
  return [...ids]
}

async function sorobanPhaserLiqBalanceMaxStroops(walletG: string): Promise<bigint> {
  const ids = new Set(phaserLiqSorobanContractIdsForBalanceRead())
  const chainCfg = await getPhaseProtocolConfigFromChain()
  if (chainCfg?.tokenAddress) ids.add(chainCfg.tokenAddress)

  let maxB = BigInt(0)
  for (const cid of ids) {
    try {
      const native = await simulateContractCall(
        cid,
        "balance",
        [Address.fromString(walletG).toScVal()],
        READONLY_SIM_SOURCE_G,
      )
      let s = BigInt(0)
      if (native == null) s = BigInt(0)
      else if (typeof native === "bigint") s = native
      else if (typeof native === "number") s = BigInt(Math.trunc(native))
      else {
        try {
          s = BigInt(String(native))
        } catch {
          s = BigInt(0)
        }
      }
      if (s > maxB) maxB = s
    } catch {
      /* siguiente contrato */
    }
  }
  return maxB
}

function maxStroopsString(a: string, b: string): string {
  try {
    const ba = BigInt(a || "0")
    const bb = BigInt(b || "0")
    return (ba > bb ? ba : bb).toString()
  } catch {
    return "0"
  }
}

/** Colapsa lecturas simultáneas del mismo G… (evita tormenta de simulaciones al re-renderizar el padre). */
const tokenBalanceInflight = new Map<string, Promise<string>>()

/**
 * Saldo PHASELQ (liquidez) que ve la UI: máximo entre lecturas SAC (env + emisores conocidos) y suma Horizon
 * de todas las trustlines con el mismo código (cualquier emisor).
 */
export async function getTokenBalance(address: string): Promise<string> {
  const g = address.trim()
  if (!StrKey.isValidEd25519PublicKey(g)) return "0"

  const existing = tokenBalanceInflight.get(g)
  if (existing) return existing

  const p = (async () => {
    const [sorobanBi, classicSumBi] = await Promise.all([
      sorobanPhaserLiqBalanceMaxStroops(g),
      horizonSumPhaserLiqByCodeStroops(g),
    ])
    return maxStroopsString(sorobanBi.toString(), classicSumBi.toString())
  })().finally(() => {
    tokenBalanceInflight.delete(g)
  })

  tokenBalanceInflight.set(g, p)
  return p
}

export async function buildInitiatePhaseTransaction(userAddress: string, collectionId: number = 0) {
  const server = getRpc()
  const account = await rpcGetUserSourceAccount(server, userAddress)
  const liquidToken = await getPhaseProtocolAuthorizedTokenContractId()
  warnDevIfEnvTokenDiffersFromChain(liquidToken)
  const c = new Contract(CONTRACT_ID)
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      c.call(
        "initiate_phase",
        Address.fromString(userAddress).toScVal(),
        Address.fromString(liquidToken).toScVal(),
        nativeToScVal(collectionId, { type: "u64" }),
      ),
    )
    .setTimeout(WALLET_SIGN_TX_TIMEBOUND_SEC)
    .build()
  // prepareTransaction ejecuta simulateTransaction internamente y sobrescribe el footprint en este tx.
  const prepared = await prepareTransactionWithRetry(server, tx)
  return prepared.toXDR()
}

export async function buildSettleTransaction(
  userAddress: string,
  amount: string,
  invoiceId: number,
  collectionId: number = 0,
) {
  const server = getRpc()
  const account = await rpcGetUserSourceAccount(server, userAddress)
  const liquidToken = await getPhaseProtocolAuthorizedTokenContractId()
  warnDevIfEnvTokenDiffersFromChain(liquidToken)
  const c = new Contract(CONTRACT_ID)
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      c.call(
        "settle",
        Address.fromString(userAddress).toScVal(),
        Address.fromString(liquidToken).toScVal(),
        nativeToScVal(BigInt(amount), { type: "i128" }),
        nativeToScVal(invoiceId, { type: "u32" }),
        nativeToScVal(collectionId, { type: "u64" }),
      ),
    )
    .setTimeout(WALLET_SIGN_TX_TIMEBOUND_SEC)
    .build()
  const prepared = await prepareTransactionWithRetry(server, tx)
  return prepared.toXDR()
}

/**
 * Transfiere el utility NFT **PHASE** (colección / `token_id` u64).
 * Usa el **contrato del protocolo** (`CONTRACT_ID` / NFT), no el SAC de PHASELQ (`TOKEN_ADDRESS`).
 *
 * Orden de prueba: `transfer` → `xfer` (estilo ejemplo Soroban) → `transfer_phase_nft` (nombre legado en algunos WASM).
 */
/**
 * G… del emisor PHASELQ expuesto al cliente (custodio típico del NFT si el mint quedó en esa cuenta).
 * Alineado con `classicLiqIssuerFromPublicEnv` / trustline.
 */
export function getPublicClassicLiqIssuerG(): string {
  return classicLiqIssuerFromPublicEnv()
}

export async function buildTransferPhaseNftTransaction(
  fromAddress: string,
  toAddress: string,
  tokenId: number,
  opts?: { transactionSourceAddress?: string; contractId?: string },
) {
  const server = getRpc()
  const sourceG = (opts?.transactionSourceAddress ?? fromAddress).trim()
  const account = await rpcGetUserSourceAccount(server, sourceG)
  const c = new Contract(opts?.contractId ?? CONTRACT_ID)
  const args = [
    Address.fromString(fromAddress).toScVal(),
    Address.fromString(toAddress).toScVal(),
    nativeToScVal(tokenId, { type: "u64" }),
  ] as const

  const build = (fn: string) =>
    new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(c.call(fn, ...args))
      .setTimeout(WALLET_SIGN_TX_TIMEBOUND_SEC)
      .build()

  const methods = ["transfer", "xfer", "transfer_phase_nft"] as const
  let lastError: unknown
  for (const fn of methods) {
    try {
      const prepared = await prepareTransactionWithRetry(server, build(fn))
      return prepared.toXDR()
    } catch (e) {
      lastError = e
    }
  }

  if (typeof console !== "undefined" && typeof console.log === "function") {
    console.log("[FORGE] Contract lacks transfer interface", lastError)
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * SEP-50 (borrador): `get_approved` → cuenta autorizada para `transfer_from` en este `token_id`, o `null` si no hay o expiró.
 * Requiere WASM con `get_approved`; no sustituye a `owner_of`.
 */
export async function simulateGetApproved(tokenId: number): Promise<string | null> {
  const native = await simulateContractCall(
    CONTRACT_ID,
    "get_approved",
    [nativeToScVal(tokenId, { type: "u64" })],
    READONLY_SIM_SOURCE_G,
  )
  return parseOptionalAddressRetval(native)
}

/** SEP-50: `is_approved_for_all(owner, operator)` (ledger de expiración on-chain). */
export async function simulateIsApprovedForAll(owner: string, operator: string): Promise<boolean> {
  const native = await simulateContractCall(
    CONTRACT_ID,
    "is_approved_for_all",
    [Address.fromString(owner).toScVal(), Address.fromString(operator).toScVal()],
    READONLY_SIM_SOURCE_G,
  )
  if (native === true || native === false) return native
  return Boolean(native)
}

/**
 * Enumeración on-chain (`token_of_owner_by_index`): el `index`-ésimo NFT del titular, o `null` si no existe.
 * Requiere WASM con `OwnerTokenList` (despliegues recientes).
 */
export async function simulateTokenOfOwnerByIndex(
  ownerAddress: string,
  index: number,
  contractId: string = CONTRACT_ID,
): Promise<number | null> {
  const native = await simulateContractCall(
    contractId,
    "token_of_owner_by_index",
    [Address.fromString(ownerAddress.trim()).toScVal(), nativeToScVal(index >>> 0, { type: "u32" })],
    READONLY_SIM_SOURCE_G,
  )
  return parseOptionalU64Retval(native)
}

/**
 * Lista todos los `token_id` del titular vía `balance` + `token_of_owner_by_index`.
 * Concurrencia por defecto 8; tope 1000 ítems.
 * Acepta `contractId` para usarse desde rutas API con el contrato correcto.
 */
export async function simulateListedTokenIdsForOwner(
  ownerAddress: string,
  contractId: string = CONTRACT_ID,
  concurrency = 8,
): Promise<number[]> {
  const balNative = await simulateContractCall(
    contractId,
    "balance",
    [Address.fromString(ownerAddress.trim()).toScVal()],
    READONLY_SIM_SOURCE_G,
  )
  let count = 0
  if (typeof balNative === "bigint") count = Number(balNative)
  else if (typeof balNative === "number") count = Math.max(0, Math.trunc(balNative))
  else if (balNative !== null && typeof balNative === "object" && "i128" in (balNative as object)) {
    const i = (balNative as { i128?: { lo?: number } | string }).i128
    if (typeof i === "string") count = Math.max(0, parseInt(i, 10) || 0)
    else if (i && typeof i === "object" && typeof i.lo === "number") count = Math.max(0, i.lo)
  }
  if (!Number.isFinite(count) || count <= 0) return []
  const max = Math.min(count, 1000)
  const conc = Math.max(1, Math.min(16, concurrency))
  const out: Array<number | null> = new Array(max).fill(null)
  let idx = 0
  async function worker() {
    for (;;) {
      const i = idx++
      if (i >= max) return
      out[i] = await simulateTokenOfOwnerByIndex(ownerAddress, i, contractId)
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, max) }, () => worker()))
  return out.filter((t): t is number => t != null).sort((a, b) => a - b)
}

/**
 * SEP-50: permiso puntual. `liveUntilLedger` 0 = revocar allowance para ese id.
 * Firma `approver` (dueño o operador con `approve_for_all` vigente).
 */
export async function buildApprovePhaseNftTransaction(
  approverAddress: string,
  approvedAddress: string,
  tokenId: number,
  liveUntilLedger: number,
  opts?: { transactionSourceAddress?: string },
) {
  const server = getRpc()
  const sourceG = (opts?.transactionSourceAddress ?? approverAddress).trim()
  const account = await rpcGetUserSourceAccount(server, sourceG)
  const c = new Contract(CONTRACT_ID)
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      c.call(
        "approve",
        Address.fromString(approverAddress).toScVal(),
        Address.fromString(approvedAddress).toScVal(),
        nativeToScVal(tokenId, { type: "u64" }),
        nativeToScVal(liveUntilLedger >>> 0, { type: "u32" }),
      ),
    )
    .setTimeout(WALLET_SIGN_TX_TIMEBOUND_SEC)
    .build()
  const prepared = await prepareTransactionWithRetry(server, tx)
  return prepared.toXDR()
}

/** SEP-50: operador global hasta ledger (0 = revocar par owner/operator). */
export async function buildApproveForAllPhaseNftTransaction(
  ownerAddress: string,
  operatorAddress: string,
  liveUntilLedger: number,
  opts?: { transactionSourceAddress?: string },
) {
  const server = getRpc()
  const sourceG = (opts?.transactionSourceAddress ?? ownerAddress).trim()
  const account = await rpcGetUserSourceAccount(server, sourceG)
  const c = new Contract(CONTRACT_ID)
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      c.call(
        "approve_for_all",
        Address.fromString(ownerAddress).toScVal(),
        Address.fromString(operatorAddress).toScVal(),
        nativeToScVal(liveUntilLedger >>> 0, { type: "u32" }),
      ),
    )
    .setTimeout(WALLET_SIGN_TX_TIMEBOUND_SEC)
    .build()
  const prepared = await prepareTransactionWithRetry(server, tx)
  return prepared.toXDR()
}

/** SEP-50: `spender` autorizado (`get_approved` o `approve_for_all`) mueve el NFT `from` → `to`. */
export async function buildTransferFromPhaseNftTransaction(
  spenderAddress: string,
  fromAddress: string,
  toAddress: string,
  tokenId: number,
  opts?: { transactionSourceAddress?: string },
) {
  const server = getRpc()
  const sourceG = (opts?.transactionSourceAddress ?? spenderAddress).trim()
  const account = await rpcGetUserSourceAccount(server, sourceG)
  const c = new Contract(CONTRACT_ID)
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      c.call(
        "transfer_from",
        Address.fromString(spenderAddress).toScVal(),
        Address.fromString(fromAddress).toScVal(),
        Address.fromString(toAddress).toScVal(),
        nativeToScVal(tokenId, { type: "u64" }),
      ),
    )
    .setTimeout(WALLET_SIGN_TX_TIMEBOUND_SEC)
    .build()
  const prepared = await prepareTransactionWithRetry(server, tx)
  return prepared.toXDR()
}

/** `Option<u64>` / u64 suelto desde simulación Soroban. */
function parseOptionalU64Retval(retval: unknown): number | null {
  const u = unwrapScVal(retval)
  if (u === null || u === undefined) return null
  if (typeof u === "bigint") return Number(u)
  if (typeof u === "number" && Number.isFinite(u)) return u
  if (typeof u === "object" && u !== null) {
    const o = u as Record<string, unknown>
    if (o.u64 != null) return Number(String(o.u64))
  }
  return null
}

/** Convierte `retval` de `get_approved` (`Option<Address>`) en strkey o `null`. */
function parseOptionalAddressRetval(retval: unknown): string | null {
  const u = unwrapScVal(retval)
  if (u === null || u === undefined) return null
  const direct = addressLikeToString(u)
  if (direct && (StrKey.isValidEd25519PublicKey(direct) || StrKey.isValidContract(direct))) return direct
  const fromObj = parseScAddress(u as unknown)
  if (fromObj && (StrKey.isValidEd25519PublicKey(fromObj) || StrKey.isValidContract(fromObj))) return fromObj
  return null
}

function logSorobanRpcResultForDebug(context: string, result: unknown): void {
  if (typeof console === "undefined" || typeof console.log !== "function") return
  try {
    console.log(context, JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)))
  } catch {
    console.log(context, result)
  }
}

export async function sendTransaction(signedXdr: string) {
  const server = getRpc()
  const parsed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET)
  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : (parsed as Transaction)
  let result: Awaited<ReturnType<typeof server.sendTransaction>> | undefined
  let lastSendErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleepRpcMs(sorobanExponentialBackoffMs(attempt - 1))
    try {
      result = await server.sendTransaction(tx)
      break
    } catch (e) {
      lastSendErr = e
      if (!isTransientRpcFailure(e) || attempt === 2) {
        throw normalizeSorobanSdkError(e)
      }
    }
  }
  if (result == null) {
    throw normalizeSorobanSdkError(lastSendErr)
  }
  if (result.status === "ERROR") {
    logSorobanRpcResultForDebug("[PHASE Soroban] sendTransaction ERROR (RPC result)", result)
    let raw = ""
    try {
      raw = JSON.stringify(result)
    } catch {
      /* ignore */
    }
    if (/txTooLate/i.test(raw)) {
      throw new Error(
        "Transacción expirada (txTooLate): pasó demasiado tiempo entre armar la tx y enviarla. " +
          "Vuelve a iniciar el paso y firma en Freighter en los próximos minutos.",
      )
    }
    throw new Error("sendTransaction rejected by RPC (see errorResult on server)")
  }
  return result
}

export async function getTransactionResult(txHash: string): Promise<unknown> {
  const server = getRpc()
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    let result: Awaited<ReturnType<typeof server.getTransaction>>
    try {
      result = await server.getTransaction(txHash)
    } catch (e) {
      if (i === 14) throw normalizeSorobanSdkError(e)
      continue
    }
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return result
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      logSorobanRpcResultForDebug("[PHASE Soroban] getTransaction FAILED (RPC result)", result)
      throw new Error("Transaction failed on ledger")
    }
  }
  throw new Error("Transaction timeout")
}

export type PhaseSettleEventInfo = {
  txHash: string
  contractId: string
  functionName: "settle"
  amountStroops: string
  invoiceId: number | null
  collectionId: number | null
}

export type PhaseSettleVerificationResult =
  | { ok: true; event: PhaseSettleEventInfo }
  | { ok: false; code: string; reason: string }

function phaseSettleFail(code: string, reason: string): PhaseSettleVerificationResult {
  return { ok: false, code, reason }
}

function parseTransactionMeta(result: unknown): xdr.TransactionMeta | null {
  const raw = result && typeof result === "object" ? (result as Record<string, unknown>).resultMetaXdr : null
  if (!raw) return null
  try {
    if (typeof raw === "string") return xdr.TransactionMeta.fromXDR(raw, "base64")
    if (raw instanceof xdr.TransactionMeta || typeof (raw as xdr.TransactionMeta).v1 === "function") {
      return raw as xdr.TransactionMeta
    }
  } catch {
    return null
  }
  return null
}

function collectSorobanContractEvents(meta: xdr.TransactionMeta): xdr.ContractEvent[] {
  const events: xdr.ContractEvent[] = []
  const push = (items: readonly unknown[]) => {
    for (const item of items) {
      if (item && typeof item === "object") events.push(item as xdr.ContractEvent)
    }
  }
  const anyMeta = meta as unknown as Record<string, () => unknown>
  for (const version of ["v0", "v1", "v2"] as const) {
    try {
      const txMeta = anyMeta[version]?.() as Record<string, unknown> | undefined
      if (!txMeta) continue
      const operations =
        typeof txMeta.operations === "function"
          ? (txMeta.operations as () => readonly unknown[])()
          : Array.isArray(txMeta.operations)
            ? txMeta.operations
            : []
      for (const op of operations) {
        const opRecord = op as Record<string, unknown>
        const opEvents =
          typeof opRecord.events === "function"
            ? (opRecord.events as () => readonly unknown[])()
            : Array.isArray(opRecord.events)
              ? opRecord.events
              : []
        push(opEvents)
      }
      if (typeof txMeta.events === "function") push((txMeta.events as () => readonly unknown[])())
      else if (Array.isArray(txMeta.events)) push(txMeta.events)
    } catch {
      // not this transaction meta version
    }
  }
  return events
}

function scvToNativeLoose(scv: unknown): unknown {
  try {
    return scValToNative(scv as xdr.ScVal)
  } catch {
    return null
  }
}

type PhaseSettleEventV0Like = {
  topics?: unknown
  data?: unknown
}

function phaseSettleEventV0(event: xdr.ContractEvent): PhaseSettleEventV0Like | null {
  try {
    const body = (event as unknown as { body?: () => { v0?: unknown; value?: unknown } }).body?.()
    if (!body) return null
    const v0 = typeof body.v0 === "function" ? body.v0() : body.v0
    if (v0 && typeof v0 === "object") return v0 as PhaseSettleEventV0Like
    const value = typeof body.value === "function" ? body.value() : body.value
    return value && typeof value === "object" ? (value as PhaseSettleEventV0Like) : null
  } catch {
    return null
  }
}

function eventContractId(event: xdr.ContractEvent): string | null {
  try {
    const raw = (event as unknown as { contractId?: () => unknown }).contractId?.()
    if (!raw) return null
    if (typeof raw === "string" && StrKey.isValidContract(raw)) return raw
    if (typeof raw === "string" && /^[0-9a-fA-F]{64}$/.test(raw)) {
      return StrKey.encodeContract(Buffer.from(raw, "hex"))
    }
    const buf = Buffer.from(raw as Uint8Array)
    return buf.byteLength === 32 ? StrKey.encodeContract(buf) : null
  } catch {
    return null
  }
}

function eventFunctionName(event: xdr.ContractEvent): string | null {
  const v0 = phaseSettleEventV0(event)
  if (!v0) return null
  const topics = typeof v0.topics === "function" ? v0.topics() : Array.isArray(v0.topics) ? v0.topics : []
  const names = Array.from(topics).map(scvToNativeLoose)
  return typeof names[0] === "string" ? names[0] : null
}

function eventDataValue(event: xdr.ContractEvent): unknown {
  const v0 = phaseSettleEventV0(event)
  if (!v0) return null
  return typeof v0.data === "function" ? scvToNativeLoose(v0.data()) : scvToNativeLoose(v0.data)
}

function bigintFromUnknown(value: unknown): bigint | null {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value.trim())
    } catch {
      return null
    }
  }
  return null
}

function firstNumericValue(obj: Record<string, unknown>, keys: string[]): bigint | null {
  for (const key of keys) {
    if (key in obj) {
      const n = bigintFromUnknown(obj[key])
      if (n != null) return n
    }
  }
  return null
}

function parseSettleEventData(data: unknown): {
  amountStroops: string | null
  invoiceId: number | null
  collectionId: number | null
} {
  const out: { amountStroops: string | null; invoiceId: number | null; collectionId: number | null } = {
    amountStroops: null,
    invoiceId: null,
    collectionId: null,
  }
  if (data == null) return out
  if (typeof data === "object" && !Array.isArray(data)) {
    const o = data as Record<string, unknown>
    const amount = firstNumericValue(o, ["amount", "amount_stroops", "amountStroops", "value", "price", "payment", "0"])
    if (amount != null) out.amountStroops = amount.toString()
    const invoice = firstNumericValue(o, ["invoice_id", "invoiceId", "invoice", "1"])
    if (invoice != null) out.invoiceId = Number(invoice)
    const collection = firstNumericValue(o, ["collection_id", "collectionId", "collection", "2"])
    if (collection != null) out.collectionId = Number(collection)
  } else if (Array.isArray(data)) {
    for (const item of data) {
      const n = bigintFromUnknown(item)
      if (n != null) {
        out.amountStroops = n.toString()
        break
      }
    }
  } else {
    const n = bigintFromUnknown(data)
    if (n != null) out.amountStroops = n.toString()
  }
  return out
}

export async function verifyPhaseSettleTxOnChain(
  txHash: string,
  options: {
    expectedContractId?: string
    minimumAmountStroops?: string
    expectedInvoiceId?: number
    expectedCollectionId?: number
  } = {},
): Promise<PhaseSettleVerificationResult> {
  const normalizedHash = txHash.trim()
  if (!normalizedHash) return phaseSettleFail("INVALID_TX_HASH", "Transaction hash is required.")
  const expectedContractId = options.expectedContractId?.trim() || phaseProtocolContractIdForServer()
  const minimumAmountStroops = options.minimumAmountStroops?.trim() || REQUIRED_AMOUNT

  let result: unknown
  try {
    result = await getTransactionResult(normalizedHash)
  } catch (e) {
    return phaseSettleFail("TX_FETCH_FAILED", e instanceof Error ? e.message : String(e))
  }

  const meta = parseTransactionMeta(result)
  if (!meta) return phaseSettleFail("META_MISSING", "Transaction result does not include parseable resultMetaXdr.")

  const events = collectSorobanContractEvents(meta)
  if (events.length === 0) return phaseSettleFail("NO_EVENTS", "Transaction did not emit Soroban contract events.")

  for (const event of events) {
    const emittedContractId = eventContractId(event)
    if (!emittedContractId || emittedContractId !== expectedContractId) continue
    if (eventFunctionName(event)?.toLowerCase() !== "settle") continue

    const parsed = parseSettleEventData(eventDataValue(event))
    if (parsed.amountStroops == null) {
      return phaseSettleFail("AMOUNT_MISSING", "Settle event did not include an amount.")
    }
    try {
      if (BigInt(parsed.amountStroops) < BigInt(minimumAmountStroops)) {
        return phaseSettleFail(
          "AMOUNT_TOO_LOW",
          `Settle payment ${parsed.amountStroops} stroops is below minimum ${minimumAmountStroops} stroops.`,
        )
      }
    } catch {
      return phaseSettleFail("AMOUNT_INVALID", `Settle amount "${parsed.amountStroops}" is not a valid integer.`)
    }
    if (
      options.expectedInvoiceId != null &&
      parsed.invoiceId != null &&
      parsed.invoiceId !== options.expectedInvoiceId
    ) {
      return phaseSettleFail(
        "INVOICE_MISMATCH",
        `Settle invoice id ${parsed.invoiceId} does not match expected ${options.expectedInvoiceId}.`,
      )
    }
    if (
      options.expectedCollectionId != null &&
      parsed.collectionId != null &&
      parsed.collectionId !== options.expectedCollectionId
    ) {
      return phaseSettleFail(
        "COLLECTION_MISMATCH",
        `Settle collection id ${parsed.collectionId} does not match expected ${options.expectedCollectionId}.`,
      )
    }
    return {
      ok: true,
      event: {
        txHash: normalizedHash,
        contractId: emittedContractId,
        functionName: "settle",
        amountStroops: parsed.amountStroops,
        invoiceId: parsed.invoiceId ?? null,
        collectionId: parsed.collectionId ?? null,
      },
    }
  }

  return phaseSettleFail("NOT_SETTLE", "No settle event from the expected contract was found.")
}
export type PhaseArtifact = {
  tokenId: number
  energyLevelBp: number
}

function phaseArtifactFromNative(native: unknown): PhaseArtifact | null {
  if (native == null || typeof native !== "object") return null
  const o = native as Record<string, unknown>
  const tokenId = numLikeToNumber(o.token_id ?? o.tokenId)
  if (tokenId <= 0) return null
  const eb = o.energy_level_bp ?? o.energyLevelBp ?? 10_000
  const energyLevelBp = numLikeToNumber(eb) || 10_000
  return { tokenId, energyLevelBp }
}

function collectionInfoFromNative(native: unknown): CollectionInfo | null {
  if (native == null || typeof native !== "object") return null
  const o = native as Record<string, unknown>
  const collectionId = numLikeToNumber(o.collection_id ?? o.collectionId)
  const creator = addressLikeToString(o.creator)
  const name = typeof o.name === "string" ? o.name : String(o.name ?? "")
  const pr = o.price
  let price = "0"
  if (typeof pr === "bigint") price = pr.toString()
  else if (typeof pr === "number") price = String(Math.trunc(pr))
  else if (typeof pr === "string") price = pr
  const imageUri = typeof o.image_uri === "string" ? o.image_uri : String(o.image_uri ?? "")
  if (collectionId <= 0 && !creator && !name) return null
  return { collectionId, creator, name, price, imageUri }
}

function normalizeSymbolKey(key: unknown): string {
  if (!key || typeof key !== "object") return ""
  const k = key as Record<string, unknown>
  if (typeof k.symbol === "string") return k.symbol
  return ""
}

function parseNumericScVal(val: unknown): number | undefined {
  if (!val || typeof val !== "object") return undefined
  const v = val as Record<string, unknown>
  if (v.u64 != null) return parseInt(String(v.u64), 10)
  if (v.u32 != null) return parseInt(String(v.u32), 10)
  if (v.i128 && typeof v.i128 === "object") {
    const i = v.i128 as Record<string, string>
    if (i.lo != null) return parseInt(i.lo, 10)
  }
  return undefined
}

/** Interpreta el `retval` de `get_user_phase` (`Option<PhaseState>` → map de ScVal). */
export function parsePhaseStateRetval(retval: unknown): PhaseArtifact | null {
  const un = unwrapScVal(retval)
  if (un == null || typeof un !== "object") return null
  const root = un as Record<string, unknown>
  let map = root.map
  if (!Array.isArray(map) && root.ok && typeof root.ok === "object") {
    map = (root.ok as Record<string, unknown>).map
  }
  if (!Array.isArray(map)) return null

  let tokenId = 0
  let energyLevelBp = 10_000

  for (const raw of map) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as Record<string, unknown>
    const sym = normalizeSymbolKey(entry.key).toLowerCase().replace(/_/g, "")
    const num = parseNumericScVal(entry.val)
    if (num == null || Number.isNaN(num)) continue

    if (sym === "tokenid" || sym === "phaseid") {
      tokenId = Math.max(tokenId, num)
    }
    if (sym === "energylevelbp" || sym === "energy") {
      energyLevelBp = num
    }
  }

  if (tokenId <= 0) {
    const legacy = map[0] as Record<string, unknown> | undefined
    const fallback = parseNumericScVal(legacy?.val ?? legacy)
    if (fallback != null && fallback > 0) {
      return { tokenId: fallback, energyLevelBp: 10_000 }
    }
    return null
  }

  return { tokenId, energyLevelBp }
}

function parseScString(val: unknown): string {
  if (typeof val === "string") return val
  if (!val || typeof val !== "object") return ""
  const v = val as Record<string, unknown>
  if (typeof v.string === "string") return v.string
  if (typeof v.str === "string") return v.str
  return ""
}

function parseScAddress(val: unknown): string {
  if (!val || typeof val !== "object") return ""
  const v = val as Record<string, unknown>
  if (typeof v.address === "string") return v.address
  return ""
}

function parseI128String(val: unknown): string {
  if (!val || typeof val !== "object") return "0"
  const v = val as Record<string, unknown>
  if (typeof v.i128 === "string") return v.i128
  if (v.i128 && typeof v.i128 === "object") {
    const i = v.i128 as Record<string, string>
    if (i.lo != null) return i.lo
  }
  return "0"
}

/** Desenveleva Option / envoltorios comunes del JSON-RPC de Soroban. */
function unwrapScVal(val: unknown, depth = 0): unknown {
  if (val == null || depth > 12) return val
  if (typeof val !== "object") return val
  const o = val as Record<string, unknown>
  if (Array.isArray(o.map)) return val
  if (o.ok !== undefined && o.ok !== null) return unwrapScVal(o.ok, depth + 1)
  if (o.some !== undefined && o.some !== null) return unwrapScVal(o.some, depth + 1)
  if (Array.isArray(o.vec) && o.vec.length === 1) return unwrapScVal(o.vec[0], depth + 1)
  if (o._value !== undefined) return unwrapScVal(o._value, depth + 1)
  return val
}

function findFirstStructMap(val: unknown, depth = 0): Array<Record<string, unknown>> | null {
  if (depth > 14 || val == null) return null
  const u = unwrapScVal(val)
  if (typeof u !== "object" || u == null) return null
  const o = u as Record<string, unknown>
  if (Array.isArray(o.map) && o.map.length > 0) {
    const first = o.map[0] as Record<string, unknown> | undefined
    const sym = normalizeSymbolKey(first?.key).toLowerCase().replace(/_/g, "")
    if (
      sym.includes("collection") ||
      sym.includes("creator") ||
      sym.includes("price") ||
      sym === "name" ||
      sym.includes("image")
    ) {
      return o.map as Array<Record<string, unknown>>
    }
  }
  for (const k of Object.keys(o)) {
    const inner = findFirstStructMap(o[k], depth + 1)
    if (inner) return inner
  }
  return null
}

/** Interpreta `get_collection` → `Option<CollectionSettings>`. */
export function parseCollectionSettingsRetval(retval: unknown): CollectionInfo | null {
  const u = unwrapScVal(retval)
  if (u === null || u === undefined) return null
  if (typeof u === "string" && u === "") return null
  const map = findFirstStructMap(u)
  if (!map) return null

  let collectionId = 0
  let creator = ""
  let name = ""
  let price = "0"
  let imageUri = ""

  for (const raw of map) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as Record<string, unknown>
    const sym = normalizeSymbolKey(entry.key).toLowerCase().replace(/_/g, "")
    const val = entry.val

    if (sym === "collectionid") {
      const n = parseNumericScVal(val)
      if (n != null) collectionId = n
    } else if (sym === "creator") {
      creator = parseScAddress(val)
    } else if (sym === "name") {
      name = parseScString(val)
    } else if (sym === "price") {
      price = parseI128String(val)
    } else if (sym === "imageuri" || sym === "image") {
      imageUri = parseScString(val)
    }
  }

  if (collectionId <= 0 && !creator && !name) return null
  return { collectionId, creator, name, price, imageUri }
}

/** Mensajes localizables para validación de URI de imagen on-chain. */
export type ImageUriValidationMessages = {
  maxLen: string
  control: string
  quotes: string
  mustHttpsOrIpfs: string
  ipfsCidShort: string
}

export const DEFAULT_IMAGE_URI_VALIDATION: ImageUriValidationMessages = {
  maxLen: "Image URL must be at most 256 characters.",
  control: "Image URL cannot contain control characters.",
  quotes: "Image URL cannot contain \" or \\ (on-chain JSON).",
  mustHttpsOrIpfs: "On-chain image must be https://… or ipfs://…",
  ipfsCidShort: "Invalid ipfs:// URI (CID too short).",
}

/** Coincide con validación on-chain: sin comillas, backslash ni control chars; longitud máx. */
export function validateCollectionImageUri(
  raw: string,
  msg: ImageUriValidationMessages = DEFAULT_IMAGE_URI_VALIDATION,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.trim()
  if (value.length > 256) return { ok: false, message: msg.maxLen }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 32) return { ok: false, message: msg.control }
    if (value[i] === '"' || value[i] === "\\") return { ok: false, message: msg.quotes }
  }
  return { ok: true, value }
}

/**
 * URI final para el contrato: vacío permitido; si no vacío debe ser `https://…` o `ipfs://…`
 * (tras pasar las reglas on-chain de `validateCollectionImageUri`).
 */
export function validateFinalContractImageUri(
  raw: string,
  msg: ImageUriValidationMessages = DEFAULT_IMAGE_URI_VALIDATION,
): { ok: true; value: string } | { ok: false; message: string } {
  const base = validateCollectionImageUri(raw, msg)
  if (!base.ok) return base
  if (base.value === "") return base
  const v = base.value
  const https = /^https:\/\//i.test(v)
  const ipfs = /^ipfs:\/\//i.test(v)
  if (!https && !ipfs) {
    return { ok: false, message: msg.mustHttpsOrIpfs }
  }
  if (ipfs) {
    const path = v.slice(7).replace(/^\/+/, "")
    if (path.length < 4) return { ok: false, message: msg.ipfsCidShort }
  }
  return base
}

const DEFAULT_IPFS_GATEWAY_BASES: readonly string[] = [
  "https://dweb.link/ipfs",
  "https://w3s.link/ipfs",
  "https://ipfs.io/ipfs",
]

function normalizeOptionalGatewayBase(raw: string): string {
  let t = raw.trim().replace(/\/+$/, "")
  if (!t || !/^https?:\/\//i.test(t)) return ""
  if (!/\/ipfs$/i.test(t)) t = `${t}/ipfs`
  return t.replace(/\/+$/, "")
}

function ipfsGatewayBasesOrdered(): string[] {
  const bases: string[] = []
  const env =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_PHASE_IPFS_GATEWAY?.trim() : undefined
  const primary = env ? normalizeOptionalGatewayBase(env) : ""
  if (primary) bases.push(primary)
  for (const b of DEFAULT_IPFS_GATEWAY_BASES) {
    if (!bases.includes(b)) bases.push(b)
  }
  return bases
}

/**
 * Subruta `CID/...` tras `ipfs://` o tras `/ipfs/` en una URL HTTPS de gateway.
 * Sirve para rehidratar URLs cuando un gateway público falla en el navegador.
 */
export function extractIpfsGatewaySubpath(uri: string): string | null {
  const t = uri.trim()
  if (!t) return null
  if (/^ipfs:\/\//i.test(t)) {
    const rest = t.replace(/^ipfs:\/\//i, "").replace(/^\/+/, "")
    return rest.length > 0 ? rest : null
  }
  const base = t.split("?")[0] ?? t
  const at = base.toLowerCase().indexOf("/ipfs/")
  if (at < 0) return null
  const sub = base.slice(at + "/ipfs/".length)
  return sub.length > 0 ? sub : null
}

/**
 * Lista de URLs HTTPS para `<img src>` (reintento gateway si la primera cae).
 * El proxy propio (`/api/ipfs`) va primero: hace fallback multi-gateway y health
 * scoring en el servidor, y cachea la respuesta. Los gateways públicos directos
 * quedan como red de seguridad si el proxy mismo no responde.
 */
export function ipfsHttpsGatewayUrls(uri: string): string[] {
  const t = uri.trim()
  if (!t) return []
  const ipfsPath = extractIpfsGatewaySubpath(t)
  if (ipfsPath) {
    const out: string[] = [`/api/ipfs/${ipfsPath}`]
    for (const b of ipfsGatewayBasesOrdered()) {
      const u = `${b}/${ipfsPath}`
      if (!out.includes(u)) out.push(u)
    }
    return out
  }
  return [t]
}

/** Primera URL de `ipfsHttpsGatewayUrls` (compat con llamadas existentes). */
export function ipfsOrHttpsDisplayUrl(uri: string): string {
  const list = ipfsHttpsGatewayUrls(uri)
  return list[0] ?? ""
}

export async function fetchTotalCollections(): Promise<number> {
  try {
    const native = await simulateContractCall(CONTRACT_ID, "get_total_collections", [], READONLY_SIM_SOURCE_G)
    const n = numLikeToNumber(native)
    return Math.max(0, n)
  } catch {
    return 0
  }
}

/** Debe coincidir con `get_collection_supply_cap` en el contrato PHASE (10_000). */
export const PHASE_COLLECTION_SUPPLY_CAP = 10_000

/**
 * `get_total_minted(collection_id)` + tope de escasez (`get_collection_supply_cap` o constante si el WASM aún no está actualizado).
 */
export async function fetchCollectionSupply(collectionId: number): Promise<{ minted: number; cap: number } | null> {
  if (collectionId < 0) return null
  try {
    const mintedNative = await simulateContractCall(
      CONTRACT_ID,
      "get_total_minted",
      [nativeToScVal(collectionId, { type: "u64" })],
      READONLY_SIM_SOURCE_G,
    )
    let cap = PHASE_COLLECTION_SUPPLY_CAP
    try {
      const capNative = await simulateContractCall(
        CONTRACT_ID,
        "get_collection_supply_cap",
        [nativeToScVal(collectionId, { type: "u64" })],
        READONLY_SIM_SOURCE_G,
      )
      const c = numLikeToNumber(capNative)
      if (c > 0) cap = c
    } catch {
      /* contrato sin getter: constante */
    }
    const minted = Math.max(0, numLikeToNumber(mintedNative))
    return { minted, cap }
  } catch {
    return null
  }
}

/** Colecciones `1..N` según `get_total_collections` (omite entradas vacías). */
export async function fetchCollectionsCatalog(): Promise<CollectionInfo[]> {
  const total = await fetchTotalCollections()
  const out: CollectionInfo[] = []
  for (let id = 1; id <= total; id++) {
    const info = await fetchCollectionInfo(id)
    if (info && info.collectionId > 0) out.push(info)
  }
  return out
}

export function parseTokenUriMetadata(json: string): { image?: string; name?: string } {
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    const image = typeof o.image === "string" ? o.image : undefined
    const name = typeof o.name === "string" ? o.name : undefined
    return { image, name }
  } catch {
    return {}
  }
}

function unwrapTokenUriReturn(native: unknown): string | null {
  if (native == null) return null
  if (typeof native === "string") {
    const s = native.trim()
    return s.length > 0 ? s : null
  }
  if (typeof native === "object" && native !== null && "ok" in native) {
    const inner = (native as { ok?: unknown }).ok
    if (typeof inner === "string" && inner.trim().length > 0) return inner.trim()
    return null
  }
  return null
}

/**
 * Si `token_uri` on-chain es una URL HTTPS, la resuelve (JSON tipo ERC-721/SEP).
 * Si es JSON incrustado (WASM antiguo), hace `parseTokenUriMetadata`.
 */
export async function fetchTokenMetadataDisplay(raw: string): Promise<{ image?: string; name?: string }> {
  const t = raw.trim()
  if (!t) return {}
  const lower = t.toLowerCase()
  if (lower.startsWith("https://") || lower.startsWith("http://")) {
    try {
      const res = await fetch(t, { cache: "no-store" })
      if (!res.ok) return {}
      const o = (await res.json()) as Record<string, unknown>
      return {
        image: typeof o.image === "string" ? o.image : undefined,
        name: typeof o.name === "string" ? o.name : undefined,
      }
    } catch {
      return {}
    }
  }
  return parseTokenUriMetadata(t)
}

export async function fetchTokenUriString(
  tokenId: number,
  protocolContractId: string = CONTRACT_ID,
): Promise<string | null> {
  if (tokenId <= 0) return null
  try {
    const native = await simulateContractCall(
      protocolContractId,
      "token_uri",
      [nativeToScVal(tokenId, { type: "u32" })],
      READONLY_SIM_SOURCE_G,
    )
    return unwrapTokenUriReturn(native)
  } catch {
    return null
  }
}

function tokenMetadataRecordFromNative(native: unknown): Record<string, string> | null {
  if (native == null || typeof native !== "object" || Array.isArray(native)) return null
  const o = native as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") out[k] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * `token_metadata(token_id)` → `Map<Symbol, String>` (SEP-0050 complement).
 * Devuelve `null` si el contrato no expone el método o la simulación falla.
 */
export async function fetchTokenMetadataMap(
  tokenId: number,
  protocolContractId: string = CONTRACT_ID,
): Promise<Record<string, string> | null> {
  if (tokenId <= 0) return null
  try {
    const native = await simulateContractCall(
      protocolContractId,
      "token_metadata",
      [nativeToScVal(tokenId, { type: "u32" })],
      READONLY_SIM_SOURCE_G,
    )
    return tokenMetadataRecordFromNative(native)
  } catch {
    return null
  }
}

/** `name()` en contrato NFT Soroban (SEP-0050 / Freighter). */
export async function fetchNftCollectionName(protocolContractId: string): Promise<string | null> {
  try {
    const native = await simulateContractCall(protocolContractId, "name", [], READONLY_SIM_SOURCE_G)
    if (typeof native === "string" && native.trim().length > 0) return native.trim()
  } catch {
    /* no name */
  }
  return null
}

/** `symbol()` en contrato NFT Soroban (SEP-0050 / Freighter). */
export async function fetchNftCollectionSymbol(protocolContractId: string): Promise<string | null> {
  try {
    const native = await simulateContractCall(protocolContractId, "symbol", [], READONLY_SIM_SOURCE_G)
    if (typeof native === "string" && native.trim().length > 0) return native.trim()
  } catch {
    /* no symbol */
  }
  return null
}

export async function fetchPhaseLevelForToken(
  tokenId: number,
  protocolContractId: string = CONTRACT_ID,
): Promise<string | null> {
  if (tokenId <= 0) return null
  try {
    const native = await simulateContractCall(
      protocolContractId,
      "get_phase_level",
      [nativeToScVal(tokenId, { type: "u64" })],
      READONLY_SIM_SOURCE_G,
    )
    if (typeof native === "string" && native.trim().length > 0) return native.trim()
    if (native && typeof native === "object" && "ok" in native) {
      const v = (native as { ok: unknown }).ok
      if (typeof v === "string" && v.trim().length > 0) return v.trim()
    }
    return null
  } catch {
    return null
  }
}

/**
 * `get_token_collection_id` on-chain; si el WASM aún no lo expone, escanea colecciones con `get_user_phase`.
 */
export async function fetchTokenCollectionIdForToken(
  tokenId: number,
  ownerAddress: string | null,
  protocolContractId: string = CONTRACT_ID,
): Promise<number | null> {
  if (tokenId <= 0) return null
  try {
    const native = await simulateContractCall(
      protocolContractId,
      "get_token_collection_id",
      [nativeToScVal(tokenId, { type: "u64" })],
      READONLY_SIM_SOURCE_G,
    )
    if (native != null) {
      const n = numLikeToNumber(native)
      if (Number.isFinite(n) && n >= 0) return n
    }
  } catch {
    /* contrato sin getter */
  }
  if (protocolContractId !== CONTRACT_ID) return null
  const o = ownerAddress?.trim()
  if (!o || !StrKey.isValidEd25519PublicKey(o)) return null
  const total = await fetchTotalCollections()
  for (let col = 0; col <= total; col++) {
    const art = await fetchUserPhaseArtifact(o, col)
    if (art && art.tokenId === tokenId) return col
  }
  return null
}

export async function fetchCreatorCollectionId(creatorAddress: string): Promise<number | null> {
  try {
    const native = await simulateContractCall(
      CONTRACT_ID,
      "get_creator_collection_id",
      [Address.fromString(creatorAddress).toScVal()],
      READONLY_SIM_SOURCE_G,
    )
    if (native == null) return null
    const n = numLikeToNumber(native)
    return n > 0 ? n : null
  } catch {
    return null
  }
}

/** Returns all collection IDs created by this address (may be multiple). */
export async function fetchCreatorCollectionIds(creatorAddress: string): Promise<number[]> {
  try {
    const native = await simulateContractCall(
      CONTRACT_ID,
      "get_creator_collection_ids",
      [Address.fromString(creatorAddress).toScVal()],
      READONLY_SIM_SOURCE_G,
    )
    if (!Array.isArray(native)) return []
    return (native as unknown[])
      .map((v) => numLikeToNumber(v))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

export async function fetchCollectionInfo(
  collectionId: number,
  protocolContractId: string = CONTRACT_ID,
): Promise<CollectionInfo | null> {
  if (collectionId <= 0) return null
  try {
    const native = await simulateContractCall(
      protocolContractId,
      "get_collection",
      [nativeToScVal(collectionId, { type: "u64" })],
      READONLY_SIM_SOURCE_G,
    )
    return collectionInfoFromNative(native)
  } catch {
    return null
  }
}

export async function buildCreateCollectionTransaction(
  creatorAddress: string,
  name: string,
  priceStroops: string,
  imageUri: string,
) {
  const server = getRpc()
  const account = await rpcGetUserSourceAccount(server, creatorAddress)
  const c = new Contract(CONTRACT_ID)
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      c.call(
        "create_collection",
        Address.fromString(creatorAddress).toScVal(),
        nativeToScVal(name, { type: "string" }),
        nativeToScVal(BigInt(priceStroops), { type: "i128" }),
        nativeToScVal(imageUri, { type: "string" }),
      ),
    )
    .setTimeout(WALLET_SIGN_TX_TIMEBOUND_SEC)
    .build()
  const prepared = await prepareTransactionWithRetry(server, tx)
  return prepared.toXDR()
}

export async function fetchUserPhaseArtifact(
  userAddress: string,
  collectionId: number = 0,
): Promise<PhaseArtifact | null> {
  try {
    const native = await simulateContractCall(
      CONTRACT_ID,
      "get_user_phase",
      [Address.fromString(userAddress).toScVal(), nativeToScVal(collectionId, { type: "u64" })],
      READONLY_SIM_SOURCE_G,
    )
    return phaseArtifactFromNative(native)
  } catch {
    return null
  }
}

export async function checkHasPhased(
  userAddress: string,
  collectionId: number = 0,
): Promise<{ phased: boolean; phaseId?: number; energyLevelBp?: number }> {
  const art = await fetchUserPhaseArtifact(userAddress, collectionId)
  if (!art || art.tokenId <= 0) return { phased: false }
  return { phased: true, phaseId: art.tokenId, energyLevelBp: art.energyLevelBp }
}

/**
 * Multi-claim guard for the custodian-release pipeline: custody alone (token held
 * by the PHASELQ issuer) is not authorization to release it to an arbitrary
 * wallet. This is authorized only when the requested tokenId matches the
 * on-chain phase artifact (`get_user_phase`) already resolved for the
 * requesting recipient — i.e. they are the wallet that actually phased/settled
 * this exact token.
 */
export function isCustodianReleaseAuthorized(
  recipientArtifact: { tokenId: number } | null,
  requestedTokenId: number,
): boolean {
  return recipientArtifact != null && recipientArtifact.tokenId === requestedTokenId
}

/**
 * Escaneo defensivo para detectar propiedad real de cualquier NFT PHASE,
 * incluso fuera de `collection_id=0` o de la colección creada por el usuario.
 */
/** `total_supply` on-chain (mayor id acuñado); 0 si falla la simulación. */
export async function fetchPhaseProtocolTotalSupply(
  protocolContractId: string = CONTRACT_ID,
): Promise<number> {
  try {
    const native = await simulateContractCall(
      protocolContractId,
      "total_supply",
      [],
      READONLY_SIM_SOURCE_G,
    )
    return Math.max(0, Math.floor(numLikeToNumber(native)))
  } catch {
    return 0
  }
}

/**
 * Lista ids de NFT PHASE cuyo `owner_of(id)` coincide con la wallet.
 * Fast path: usa `balance(owner)` + `token_of_owner_by_index` (O(owned), requiere WASM con OwnerTokenList).
 * Fallback: escaneo bruto `owner_of(1..total_supply)` si el fast path falla o devuelve vacío con supply > 0.
 */
export async function fetchOwnedPhaseTokenIdsForWallet(
  ownerG: string,
  opts?: { contractId?: string; maxTokenIdCap?: number; concurrency?: number },
): Promise<number[]> {
  const contractId = opts?.contractId ?? CONTRACT_ID
  const g = extractBaseAddress(ownerG).trim().toUpperCase()
  if (!StrKey.isValidEd25519PublicKey(g)) return []
  const conc = Math.max(1, Math.min(16, opts?.concurrency ?? 8))

  // ── Fast path: balance + token_of_owner_by_index ──
  try {
    const fast = await simulateListedTokenIdsForOwner(ownerG, contractId, conc)
    if (fast.length > 0) return fast
    // Si fast devuelve [], puede ser que el contrato no tenga OwnerTokenList.
    // Comprobamos total supply: si es > 0 y fast = [], el contrato puede no tener el método → fallback.
    const total = await fetchPhaseProtocolTotalSupply(contractId)
    if (total <= 0) return []
    // total > 0 y balance devolvió 0 → o el usuario no tiene NFTs, o el método no existe en el WASM.
    // Intentamos verificar al menos el token 1 con token_of_owner_by_index para distinguir los casos.
    const probe = await simulateTokenOfOwnerByIndex(ownerG, 0, contractId)
    if (probe === null) {
      // El método existe y devuelve None → el usuario genuinamente no tiene tokens.
      // (Si el método no existiera, simulateContractCall lanzaría, no devolvería null.)
      return []
    }
    // probe tiene un valor → hay al menos un token; fast debió haberlo encontrado. Continúa igual.
    return fast
  } catch {
    // El contrato no tiene balance/token_of_owner_by_index → fallback al escaneo bruto.
  }

  // ── Fallback: escaneo bruto owner_of(1..total_supply) ──
  const total = await fetchPhaseProtocolTotalSupply(contractId)
  if (total <= 0) return []

  const maxCap = opts?.maxTokenIdCap ?? 5000
  const cap = Math.min(total, Math.max(1, maxCap))

  const owned: number[] = []
  for (let start = 1; start <= cap; start += conc) {
    const batch: Promise<number | null>[] = []
    for (let j = 0; j < conc && start + j <= cap; j++) {
      const id = start + j
      batch.push(
        (async () => {
          const o = await fetchTokenOwnerAddress(contractId, id)
          if (!o) return null
          const og = extractBaseAddress(o).trim().toUpperCase()
          return og === g ? id : null
        })(),
      )
    }
    const results = await Promise.all(batch)
    for (const r of results) {
      if (r != null) owned.push(r)
    }
  }
  return owned.sort((a, b) => a - b)
}

export async function userOwnsAnyPhaseToken(userAddress: string, scanWindow: number = 400): Promise<boolean> {
  const normalized = extractBaseAddress(userAddress).trim().toUpperCase()
  if (!normalized) return false
  /** Evita cientos de RTT secuenciales (muy lento vía proxy o RPC remoto). */
  const CONCURRENCY = 14
  try {
    const total = await fetchPhaseProtocolTotalSupply(CONTRACT_ID)
    if (total <= 0) return false

    const from = Math.max(1, total - Math.max(1, scanWindow) + 1)
    const ids: number[] = []
    for (let tokenId = total; tokenId >= from; tokenId--) ids.push(tokenId)
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = ids.slice(i, i + CONCURRENCY)
      const hits = await Promise.all(
        chunk.map(async (tokenId) => {
          const owner = await fetchTokenOwnerAddress(CONTRACT_ID, tokenId)
          return Boolean(owner && extractBaseAddress(owner).trim().toUpperCase() === normalized)
        }),
      )
      if (hits.some(Boolean)) return true
    }
    return false
  } catch {
    return false
  }
}

function extractAccountGAddress(value: unknown, depth = 0): string | null {
  if (value == null || depth > 6) return null

  if (typeof value === "string") {
    const t = value.trim().toUpperCase()
    const direct = t.match(/\bG[A-Z2-7]{55}\b/)
    return direct ? direct[0] : null
  }

  if (value instanceof Uint8Array && value.byteLength === 32) {
    try {
      return StrKey.encodeEd25519PublicKey(Buffer.from(value))
    } catch {
      return null
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractAccountGAddress(item, depth + 1)
      if (found) return found
    }
    return null
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>

    // Common native shapes returned by Soroban SDK wrappers.
    const directKeys = ["address", "account", "accountId", "owner", "ownerAddress", "value"]
    for (const k of directKeys) {
      if (k in obj) {
        const found = extractAccountGAddress(obj[k], depth + 1)
        if (found) return found
      }
    }

    for (const v of Object.values(obj)) {
      const found = extractAccountGAddress(v, depth + 1)
      if (found) return found
    }

    if (typeof obj.toString === "function") {
      const fromToString = extractAccountGAddress(String(obj.toString()), depth + 1)
      if (fromToString) return fromToString
    }
  }

  return null
}

function parseOwnerOfReturn(native: unknown): string | null {
  return extractAccountGAddress(native)
}

/**
 * Cuenta de NFTs de utilidad PHASE en el **contrato del protocolo** (`CONTRACT_ID`): `balance(id)` (recuento i128).
 * No confundir con el saldo PHASELQ en el SAC (`TOKEN_ADDRESS`).
 */
export async function fetchPhaseUtilityNftCount(walletG: string): Promise<string> {
  const g = walletG.trim()
  if (!StrKey.isValidEd25519PublicKey(g)) return "0"
  try {
    const native = await simulateContractCall(
      CONTRACT_ID,
      "balance",
      [Address.fromString(g).toScVal()],
      READONLY_SIM_SOURCE_G,
    )
    if (native == null) return "0"
    if (typeof native === "bigint") return native.toString()
    if (typeof native === "number") return String(Math.max(0, Math.trunc(native)))
    try {
      return BigInt(String(native)).toString()
    } catch {
      return "0"
    }
  } catch {
    return "0"
  }
}

/** `owner_of` on-chain → dirección G o `null` si el token no existe / simulación falla. */
export async function fetchTokenOwnerAddress(
  contractId: string,
  tokenId: number,
): Promise<string | null> {
  if (!Number.isFinite(tokenId) || tokenId <= 0) return null
  const tryOwner = async (method: "owner_of" | "owner_of_u64", type: "u32" | "u64") => {
    const native = await withHorizonBulkhead(() => simulateContractCall(
      contractId,
      method,
      [nativeToScVal(tokenId, { type })],
      READONLY_SIM_SOURCE_G,
    ))
    return parseOwnerOfReturn(native)
  }
  try {
    return await tryOwner("owner_of", "u32")
  } catch {
    /* fallback para contratos legacy que exponen owner_of(u64) */
  }
  try {
    return await tryOwner("owner_of_u64", "u64")
  } catch {
    return null
  }
}

/** Símbolo del token leído on-chain (`symbol()` o fallback `token_symbol()`), ya normalizado a marca UI PHASELQ. */
export async function fetchTokenSymbol(contractId: string = TOKEN_ADDRESS): Promise<string> {
  try {
    const direct = await simulateContractCall(contractId, "symbol", [], READONLY_SIM_SOURCE_G)
    if (typeof direct === "string" && direct.trim().length > 0) return displayPhaserLiqSymbol(direct.trim())
  } catch {
    /* fallback below */
  }
  try {
    const legacy = await simulateContractCall(contractId, "token_symbol", [], READONLY_SIM_SOURCE_G)
    if (typeof legacy === "string" && legacy.trim().length > 0) return displayPhaserLiqSymbol(legacy.trim())
  } catch {
    /* fallback below */
  }
  return PHASER_LIQ_SYMBOL
}

/**
 * Verificación de originalidad: la wallet activa coincide con `TokenOwner(token_id)` en el contrato.
 */
export function isAuthentic(
  viewerAddress: string | null | undefined,
  onChainOwnerAddress: string | null | undefined,
): boolean {
  const vRaw = viewerAddress?.trim()
  const oRaw = onChainOwnerAddress?.trim()
  if (!vRaw || !oRaw) return false
  let v: string
  let o: string
  try {
    v = extractBaseAddress(vRaw).trim().toUpperCase()
    o = extractBaseAddress(oRaw).trim().toUpperCase()
  } catch {
    return false
  }
  return v.length === 56 && v.startsWith("G") && v === o
}

export function formatLiq(balance: string) {
  const num = parseInt(balance, 10) / 10000000
  return num.toFixed(2)
}

export function isLowEnergy(tokenBalance: string, requiredStroops: string = REQUIRED_AMOUNT) {
  try {
    return BigInt(tokenBalance || "0") < BigInt(requiredStroops || "0")
  } catch {
    return parseInt(tokenBalance, 10) < parseInt(requiredStroops, 10)
  }
}

/** On-chain `PhaseError::InsufficientBalance` (discriminant 2) as reported by the host. */
export function isPhaseInsufficientBalanceError(message: string) {
  return /Error\s*\(\s*Contract\s*,\s*#2\s*\)/.test(message) || /\bContract\s*,\s*#2\b/.test(message)
}

/** On-chain `PhaseError::CreatorAlreadyHasCollection` (discriminant 8). */
export function isCreatorAlreadyHasCollectionError(message: string) {
  return /Error\s*\(\s*Contract\s*,\s*#8\s*\)/.test(message) || /\bContract\s*,\s*#8\b/.test(message)
}

/** On-chain `PhaseError::UnauthorizedToken` (discriminant 4) o texto "unauthorized". */
export function isPhaseUnauthorizedError(message: string) {
  const m = message.toLowerCase()
  return (
    /Error\s*\(\s*Contract\s*,\s*#4\s*\)/.test(message) ||
    /\bContract\s*,\s*#4\b/.test(message) ||
    m.includes("unauthorized")
  )
}

/** Detect RPC / sequence class errors for narrative recovery UI */
export function isStellarDesyncError(message: string) {
  const m = message.toLowerCase()
  return (
    m.includes("sequence") ||
    m.includes("getaccount") ||
    m.includes("get account") ||
    m.includes("rpc") ||
    m.includes("network") ||
    m.includes("fetch") ||
    m.includes("failed to get account") ||
    m.includes("method not found")
  )
}
