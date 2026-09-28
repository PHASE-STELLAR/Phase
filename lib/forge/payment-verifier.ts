import { Address, extractBaseAddress, FeeBumpTransaction, rpc, scValToNative, TransactionBuilder, xdr } from "@stellar/stellar-sdk"
import { decodePaymentHeader, PaymentPayloadSchema, PaymentRequirementsSchema, useFacilitator, type PaymentRequirements } from "x402-stellar"
import { getPhaseProtocolConfigFromChain, NETWORK_PASSPHRASE, phaseProtocolContractIdForServer, READONLY_SIM_SOURCE_G, REQUIRED_AMOUNT, RPC_URL, stroopsToLiqDisplay, PHASER_LIQ_SYMBOL, tokenContractIdForServer } from "@/lib/phase-protocol"
import { logUnknownStellarError } from "@/lib/stellar"

const PHASE_PROTOCOL_CONTRACT = phaseProtocolContractIdForServer()
const PHASE_LIQ_TOKEN_CONTRACT = tokenContractIdForServer()
export const X402_NETWORK = "stellar:testnet"

export type ForgePaymentResolution = "paid" | "missing" | "facilitator_rejected"

export function forgePriceDisplay(): string {
  return `${stroopsToLiqDisplay(REQUIRED_AMOUNT)} ${PHASER_LIQ_SYMBOL}`
}

// ── helpers extracted from monolith ────────────────────────────────────────
function normalizeContractFunctionName(fn: string | Buffer | Uint8Array | unknown): string {
  if (typeof fn === "string") return fn.replace(/\0/g, "").trim()
  if (Buffer.isBuffer(fn)) return fn.toString("utf8").replace(/\0/g, "").trim()
  if (fn instanceof Uint8Array) return Buffer.from(fn).toString("utf8").replace(/\0/g, "").trim()
  return String(fn ?? "").replace(/\0/g, "").trim()
}

function comparableEd25519AccountG(addr: string): string {
  const t = addr.trim()
  if (!t) return ""
  try { return extractBaseAddress(t).trim().toUpperCase() } catch { return t.toUpperCase() }
}
function normalizeContractC(id: string): string { return id.trim().toUpperCase() }

function sorobanAmountScValToBigInt(sc: xdr.ScVal): bigint | null {
  const u64Mask = (BigInt(1) << BigInt(64)) - BigInt(1)
  try {
    const native = scValToNative(sc)
    if (typeof native === "bigint") return native
    if (typeof native === "number" && Number.isFinite(native)) return BigInt(Math.trunc(native))
    if (typeof native === "string" && /^-?\d+$/.test(native.trim())) return BigInt(native.trim())
    if (native && typeof native === "object") {
      const o = native as Record<string, unknown>
      const loVal = o.lo ?? o.LO; const hiVal = o.hi ?? o.HI
      if (loVal !== undefined || hiVal !== undefined) {
        const lo = BigInt(String(loVal ?? 0)); const hi = BigInt(String(hiVal ?? 0))
        return (hi << BigInt(64)) | (lo & u64Mask)
      }
    }
  } catch { /* fallback xdr */ }
  try {
    const parts = sc.i128(); const hi = BigInt(parts.hi().toString()); const lo = BigInt(parts.lo().toString())
    return (hi << BigInt(64)) | (lo & u64Mask)
  } catch { return null }
}

// ── challenge / payment requirements ────────────────────────────────────────
export type LegacyChallenge = {
  protocol: "x402"; version: "2"; network: string; token: string; contract_id: string
  token_contract: string; amount: number; priceDisplay: string; facilitator: string
  invoice: string; resource: string; note: string
}

function parseRequiredAmountInt(): number {
  const p = Number.parseInt(REQUIRED_AMOUNT, 10)
  return Number.isFinite(p) && p > 0 ? p : 0
}

export function facilitatorUrlFromRequest(origin: string): string {
  const c = process.env.X402_FACILITATOR_URL?.trim()
  if (c) return c
  return `${origin}/api/x402`
}

export function buildLegacyChallenge(origin: string, pathname: string): LegacyChallenge {
  return {
    protocol: "x402", version: "2", network: X402_NETWORK,
    token: PHASE_LIQ_TOKEN_CONTRACT, contract_id: PHASE_PROTOCOL_CONTRACT,
    token_contract: PHASE_LIQ_TOKEN_CONTRACT, amount: parseRequiredAmountInt(),
    priceDisplay: forgePriceDisplay(), facilitator: facilitatorUrlFromRequest(origin),
    invoice: `forge_${Date.now()}`, resource: pathname,
    note: "Payment in PHASELQ via PHASE protocol `settle` on-chain, or x402 exact payment per paymentRequirements.",
  }
}

export function buildOfficialPaymentRequirements(origin: string): PaymentRequirements | null {
  try {
    const resource = `${origin}/api/forge-agent`
    const payTo = process.env.X402_FORGE_PAY_TO?.trim() || READONLY_SIM_SOURCE_G
    return PaymentRequirementsSchema.parse({
      scheme: "exact", network: "stellar-testnet", maxAmountRequired: REQUIRED_AMOUNT,
      resource, description: "PHASELQ (Soroban) — pago x402 exact para el agente de forja.",
      mimeType: "application/json", payTo, maxTimeoutSeconds: 600, asset: PHASE_LIQ_TOKEN_CONTRACT,
      extra: { phaserLiqContract: PHASE_LIQ_TOKEN_CONTRACT, phaseProtocolContract: PHASE_PROTOCOL_CONTRACT, requiredAmountStroops: REQUIRED_AMOUNT },
    })
  } catch { return null }
}

async function verifyOfficialX402(rawHeader: string, paymentRequirements: PaymentRequirements): Promise<boolean> {
  let decoded: unknown
  try { decoded = decodePaymentHeader<unknown>(rawHeader) } catch { return false }
  const parsed = PaymentPayloadSchema.safeParse(decoded)
  if (!parsed.success) return false
  const facilitatorUrlConfigured = process.env.X402_FACILITATOR_URL?.trim()
  const { verify } = useFacilitator(facilitatorUrlConfigured ? { url: facilitatorUrlConfigured } : undefined)
  const res = await verify(parsed.data, paymentRequirements)
  return res.isValid === true
}

// ── on-chain settle verification ────────────────────────────────────────────
export async function verifyPhaseSettleTxOnChain(txHash: string, payerAddress: string): Promise<boolean> {
  const payerComparable = comparableEd25519AccountG(payerAddress.trim())
  if (!payerComparable.startsWith("G") || payerComparable.length !== 56) return false
  const chainCfg = await getPhaseProtocolConfigFromChain()
  const allowed = new Set<string>([PHASE_LIQ_TOKEN_CONTRACT])
  if (chainCfg?.tokenAddress) allowed.add(chainCfg.tokenAddress)
  const allowedNorm = new Set([...allowed].map(normalizeContractC))
  const contractNorm = normalizeContractC(PHASE_PROTOCOL_CONTRACT)
  const server = new rpc.Server(RPC_URL)
  let res: rpc.Api.GetTransactionResponse
  try { res = await server.getTransaction(txHash.trim()) } catch { return false }
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) return false
  const parsed = TransactionBuilder.fromXDR(res.envelopeXdr, NETWORK_PASSPHRASE)
  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
  const sourceG = typeof tx.source === "string" ? tx.source.trim() : ""
  if (comparableEd25519AccountG(sourceG) !== payerComparable) return false
  for (const op of tx.operations) {
    if (op.type !== "invokeHostFunction") continue
    const hf = op.func
    if (hf.switch().name !== "hostFunctionTypeInvokeContract") continue
    const ic = hf.invokeContract()
    const addr = Address.fromScAddress(ic.contractAddress()).toString()
    if (normalizeContractC(addr) !== contractNorm) continue
    if (normalizeContractFunctionName(ic.functionName()) !== "settle") continue
    const args = ic.args(); if (!args || args.length < 3) continue
    let userG: string; try { userG = Address.fromScVal(args[0]).toString() } catch { continue }
    if (comparableEd25519AccountG(userG) !== payerComparable) continue
    let tokenC: string; try { tokenC = Address.fromScVal(args[1]).toString() } catch { continue }
    if (!allowedNorm.has(normalizeContractC(tokenC))) continue
    const bi = sorobanAmountScValToBigInt(args[2]); if (bi === null || bi < BigInt(REQUIRED_AMOUNT)) continue
    return true
  }
  return false
}

function tryPhaseProofFromAuthHeader(authHeader: string | null): { settlementTxHash: string; payerAddress: string } | null {
  if (!authHeader?.toLowerCase().startsWith("x402 ")) return null
  const raw = authHeader.slice(5).trim(); if (!raw) return null
  try {
    const j = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>
    const h = typeof j.settlementTxHash === "string" ? j.settlementTxHash.trim() : ""
    const p = typeof j.payerAddress === "string" ? j.payerAddress.trim() : ""
    if (!h || !p) return null
    return { settlementTxHash: h, payerAddress: p }
  } catch { return null }
}

async function sorobanSuccessfulTxSourcePublicKey(txHash: string): Promise<string | null> {
  const h = txHash.trim(); if (!h) return null
  const server = new rpc.Server(RPC_URL)
  let res: rpc.Api.GetTransactionResponse
  try { res = await server.getTransaction(h) } catch { return null }
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) return null
  try {
    const parsed = TransactionBuilder.fromXDR(res.envelopeXdr, NETWORK_PASSPHRASE)
    const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
    const src = typeof tx.source === "string" ? tx.source.trim() : ""
    if (!src) return null
    const g = extractBaseAddress(src).trim()
    return g.startsWith("G") && g.length === 56 ? g : null
  } catch { return null }
}

export function parseBearerSettlementTxHash(authHeader: string | null): string | null {
  const h = authHeader?.trim(); if (!h?.toLowerCase().startsWith("bearer ")) return null
  return h.slice(7).trim() || null
}

export function extractSettlementReceiptTxHash(authHeader: string | null, body: { settlementTxHash?: string }): string {
  const fromBody = body.settlementTxHash?.trim() ?? ""
  if (fromBody) return fromBody
  const bearer = parseBearerSettlementTxHash(authHeader)
  if (bearer) return bearer
  const phase = tryPhaseProofFromAuthHeader(authHeader)
  return phase?.settlementTxHash?.trim() ?? ""
}

// ── pipeline step ───────────────────────────────────────────────────────────
export type VerifyPaymentStepInput = {
  authHeader: string | null
  body: { settlementTxHash?: string; payerAddress?: string }
  paymentRequirements: PaymentRequirements | null
}

export async function verifyPaymentStep(input: VerifyPaymentStepInput): Promise<ForgePaymentResolution> {
  const { authHeader, body, paymentRequirements } = input
  const bearerHash = parseBearerSettlementTxHash(authHeader)
  let settlementTx = body.settlementTxHash?.trim() ?? ""
  if (bearerHash) {
    if (settlementTx && settlementTx !== bearerHash) return "missing"
    settlementTx = settlementTx || bearerHash
  }
  let payer = body.payerAddress?.trim()
  if (settlementTx) {
    if (!payer) payer = (await sorobanSuccessfulTxSourcePublicKey(settlementTx)) ?? ""
    if (payer) {
      try { return (await verifyPhaseSettleTxOnChain(settlementTx, payer)) ? "paid" : "missing" }
      catch (e) { logUnknownStellarError("forge verifyPaymentStep (body settle)", e); return "missing" }
    }
  }
  const phaseFromAuth = tryPhaseProofFromAuthHeader(authHeader)
  if (phaseFromAuth) {
    try { return (await verifyPhaseSettleTxOnChain(phaseFromAuth.settlementTxHash, phaseFromAuth.payerAddress)) ? "paid" : "missing" }
    catch (e) { logUnknownStellarError("forge verifyPaymentStep (auth settle)", e); return "missing" }
  }
  if (!authHeader?.toLowerCase().startsWith("x402 ")) return "missing"
  const raw = authHeader.slice(5).trim(); if (!raw || !paymentRequirements) return "missing"
  let decoded: unknown
  try { decoded = decodePaymentHeader<unknown>(raw) } catch { return "missing" }
  if (!PaymentPayloadSchema.safeParse(decoded).success) return "missing"
  try { return (await verifyOfficialX402(raw, paymentRequirements)) ? "paid" : "facilitator_rejected" }
  catch (e) { logUnknownStellarError("forge verifyPaymentStep (x402 verify)", e); return "facilitator_rejected" }
}
