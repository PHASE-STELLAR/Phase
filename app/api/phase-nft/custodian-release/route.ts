import { NextRequest, NextResponse } from "next/server"
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk"
import { z } from "zod"
import { classicLiqIssuerForStellarToml } from "@/lib/classic-liq"
import {
  buildTransferPhaseNftTransaction,
  fetchTokenCollectionIdForToken,
  fetchTokenOwnerAddress,
  fetchUserPhaseArtifact,
  getGatewayHealthSnapshot,
  getTransactionResult,
  isCustodianReleaseAuthorized,
  NETWORK_PASSPHRASE,
  phaseProtocolContractIdForServer,
  sendTransaction,
} from "@/lib/phase-protocol"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PHASE_PROTOCOL_CONTRACT = phaseProtocolContractIdForServer()

// Best-effort in-process lock: prevents concurrent duplicate claims of the same
// custodial token from racing each other into buildTransferPhaseNftTransaction
// before the first transfer has landed on-chain.
const inFlightCustodianReleases = new Set<number>()

// phase-121: gateway health dashboard flag (rollback: unset NEXT_PUBLIC_FEATURE_PHASE_121)
function isPhase121Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_121 ?? process.env.FEATURE_PHASE_121 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const CustodianReleaseBodySchema = z.object({
  tokenId: z.union([z.number().int().min(1), z.string().regex(/^\d+$/).transform((s) => parseInt(s, 10))]).transform((v) => (typeof v === "string" ? parseInt(v, 10) : v)).pipe(z.number().int().min(1)),
  recipientWallet: z.string().length(56).regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address"),
})

type Body = {
  tokenId?: number | string
  recipientWallet?: string
}

// phase-121: GET health dashboard (operators: which gateway is slow)
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isPhase121Enabled()) {
    return NextResponse.json({ ok: false, error: "Gateway health dashboard disabled (phase-121 flag off). Enable NEXT_PUBLIC_FEATURE_PHASE_121=1." }, { status: 404 })
  }
  const wantJson = request.headers.get("accept")?.includes("application/json") ?? true
  if (!wantJson) {
    return NextResponse.json({ ok: false, error: "Accept: application/json required" }, { status: 400 })
  }
  const url = new URL(request.url)
  const sort = url.searchParams.get("sort") ?? "score"
  const limitRaw = url.searchParams.get("limit")
  const limit = limitRaw ? Math.max(1, Math.min(50, parseInt(limitRaw, 10) || 20)) : 20
  if (!["score", "latency", "uptime"].includes(sort)) {
    return NextResponse.json({ ok: false, error: "Invalid sort (score|latency|uptime)" }, { status: 400 })
  }
  const snapshot = getGatewayHealthSnapshot()
  let gateways = [...snapshot.gateways]
  if (sort === "latency") gateways.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)
  else if (sort === "uptime") gateways.sort((a, b) => b.uptime - a.uptime)
  gateways = gateways.slice(0, limit)
  return NextResponse.json(
    { ok: true, enabled: snapshot.enabled, updatedAt: snapshot.updatedAt, bestGateway: snapshot.bestGateway, worstGateway: snapshot.worstGateway, gateways },
    { headers: { "Cache-Control": "no-store", "X-Phase-Flag": "phase-121" } },
  )
}

/**
 * Transfiere el NFT PHASE desde la cuenta custodia (emisor PHASELQ G…) al usuario.
 * El contrato exige `from.require_auth()`: solo puede firmar el custodio on-chain.
 * phase-121: adds structured validation and gateway health telemetry (flag-gated).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 })
  }

  // phase-121: type-safe validation when flag enabled (structured error, no regression when off)
  if (isPhase121Enabled()) {
    const parsed = CustodianReleaseBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Validation failed", details: parsed.error.flatten() }, { status: 400 })
    }
    // Use validated values for downstream logic
    body.tokenId = parsed.data.tokenId
    body.recipientWallet = parsed.data.recipientWallet
  }

  const rawId = body.tokenId
  const tokenId = typeof rawId === "number" ? rawId : Number.parseInt(String(rawId ?? ""), 10)
  if (!Number.isFinite(tokenId) || tokenId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid tokenId." }, { status: 400 })
  }

  const recipient = typeof body.recipientWallet === "string" ? body.recipientWallet.trim() : ""
  if (!recipient || !recipient.startsWith("G") || recipient.length !== 56) {
    return NextResponse.json({ ok: false, error: "Invalid recipientWallet." }, { status: 400 })
  }

  // Require recipient authorization: custodian release must be signed by recipient
  const authHeader = request.headers.get("authorization") ?? ""
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { ok: false, code: "MISSING_AUTHORIZATION", error: "Authorization header required; recipient must sign release request." },
      { status: 401 },
    )
  }

  const secret = process.env.CLASSIC_LIQ_ISSUER_SECRET?.trim()
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        code: "MISSING_ISSUER_SECRET",
        error: "CLASSIC_LIQ_ISSUER_SECRET is not configured; server cannot sign custodian transfer.",
      },
      { status: 503 },
    )
  }

  let kp: Keypair
  try {
    kp = Keypair.fromSecret(secret)
  } catch {
    return NextResponse.json({ ok: false, error: "CLASSIC_LIQ_ISSUER_SECRET is not a valid Stellar secret." }, { status: 503 })
  }

  const issuerG = classicLiqIssuerForStellarToml()
  if (kp.publicKey().toUpperCase() !== issuerG.toUpperCase()) {
    return NextResponse.json(
      {
        ok: false,
        code: "ISSUER_SECRET_MISMATCH",
        error: "CLASSIC_LIQ_ISSUER_SECRET public key does not match configured PHASELQ issuer (classicLiqIssuerForStellarToml).",
      },
      { status: 503 },
    )
  }

  const owner = await fetchTokenOwnerAddress(PHASE_PROTOCOL_CONTRACT, Math.floor(tokenId))
  if (!owner) {
    return NextResponse.json(
      { ok: false, code: "NFT_NOT_MINTED", error: "No on-chain owner for this token id." },
      { status: 404 },
    )
  }

  if (owner.toUpperCase() !== issuerG.toUpperCase()) {
    return NextResponse.json(
      {
        ok: false,
        code: "NOT_ISSUER_CUSTODY",
        owner,
        detail:
          "This token is not held by the configured PHASELQ issuer. It may already be in the user's wallet or held by another address.",
      },
      { status: 409 },
    )
  }

  if (recipient.toUpperCase() === owner.toUpperCase()) {
    return NextResponse.json({ ok: false, error: "Recipient is already the on-chain owner." }, { status: 400 })
  }

  // Multi-claim guard: custody alone is not authorization. Verify on-chain that
  // this exact tokenId is the one this recipientWallet actually phased/settled
  // (`get_user_phase`), so an arbitrary caller cannot release someone else's
  // custodial token to their own wallet by guessing/enumerating tokenIds.
  const id = Math.floor(tokenId)
  const collectionId = await fetchTokenCollectionIdForToken(id, recipient, PHASE_PROTOCOL_CONTRACT)
  const recipientArtifact = await fetchUserPhaseArtifact(recipient, collectionId ?? 0)
  if (!isCustodianReleaseAuthorized(recipientArtifact, id)) {
    return NextResponse.json(
      {
        ok: false,
        code: "TOKEN_NOT_ASSIGNED_TO_RECIPIENT",
        error: "This token was not phased/settled by the requested recipient wallet; refusing to release custody.",
      },
      { status: 403 },
    )
  }

  if (inFlightCustodianReleases.has(id)) {
    return NextResponse.json(
      { ok: false, code: "RELEASE_IN_PROGRESS", error: "A custodian release for this token is already in progress." },
      { status: 409 },
    )
  }
  inFlightCustodianReleases.add(id)

  try {
    const start = Date.now()
    const xdr = await buildTransferPhaseNftTransaction(issuerG, recipient, id, { contractId: PHASE_PROTOCOL_CONTRACT })
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE)
    tx.sign(kp)
    const sendResult = await sendTransaction(tx.toXDR())
    const hash = sendResult.hash as string | undefined
    if (hash) {
      await getTransactionResult(hash)
    }
    const latencyMs = Date.now() - start
    // phase-121: record custodial flow latency for operator visibility (best-effort)
    if (isPhase121Enabled()) {
      try {
        const { recordGatewayLatency } = await import("@/lib/gateway-health")
        recordGatewayLatency("custodian:sendTransaction", latencyMs, true)
      } catch { /* ignore */ }
    }
    return NextResponse.json(
      { ok: true, hash: hash ?? null, contractId: PHASE_PROTOCOL_CONTRACT, tokenId: id },
      { headers: isPhase121Enabled() ? { "X-Phase-Custodian-Latency-Ms": String(latencyMs) } : undefined },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (isPhase121Enabled()) {
      try {
        const { recordGatewayLatency } = await import("@/lib/gateway-health")
        recordGatewayLatency("custodian:sendTransaction", 0, false)
      } catch { /* ignore */ }
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  } finally {
    inFlightCustodianReleases.delete(id)
  }
}
