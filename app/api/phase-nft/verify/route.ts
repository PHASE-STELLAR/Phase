import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { fetchTokenOwnerAddress, phaseProtocolContractIdForServer } from "@/lib/phase-protocol"
import { auditPushNotificationWiring, isPhase92Enabled, auditWashTradingWiring, isPhase77Enabled } from "@/lib/stellar"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PHASE_PROTOCOL_CONTRACT = phaseProtocolContractIdForServer()

// phase-122: flag check (rollback: unset NEXT_PUBLIC_FEATURE_PHASE_122)
function isPhase122Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_122 ?? process.env.FEATURE_PHASE_122 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const VerifyBodySchema = z.object({
  tokenId: z.union([z.number().int().min(1), z.string().regex(/^\d+$/).transform((s) => parseInt(s, 10))]).transform((v) => (typeof v === "string" ? parseInt(v, 10) : v)).pipe(z.number().int().min(1).max(1_000_000)),
  walletAddress: z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address").optional().or(z.literal("")),
  // Issue #227: a gated preview needs a signature bound to this exact token,
  // with an expiry and a single-use id. Absent signature => unverified, which
  // is the safe default for gated content.
  viewerSignature: z.string().min(1).max(4096).optional(),
  viewerClaims: z
    .object({
      viewer: z.string().min(1).max(64),
      tokenId: z.number().int().min(1).max(1_000_000),
      exp: z.number().int().positive(),
      jti: z.string().min(8).max(128),
    })
    .optional(),
})

type Body = {
  tokenId?: number | string
  walletAddress?: string
  viewerSignature?: string
  viewerClaims?: { viewer: string; tokenId: number; exp: number; jti: string }
}

/**
 * Comprueba que el utility NFT existe en ledger (`owner_of`).
 * Devuelve `viewerIsOwner` si se pasó `walletAddress`; el cliente usa eso para ocultar Collect cuando ya es dueño.
 * phase-122: when delta enabled, also probes off-chain delta store and reports storage rent insight.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 })
  }

  // phase-122: structured validation when flag enabled
  if (isPhase122Enabled()) {
    const parsed = VerifyBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Validation failed", details: parsed.error.flatten() }, { status: 400 })
    }
    body.tokenId = parsed.data.tokenId
    body.walletAddress = parsed.data.walletAddress
  }

  const rawId = body.tokenId
  const tokenId = typeof rawId === "number" ? rawId : Number.parseInt(String(rawId ?? ""), 10)
  if (!Number.isFinite(tokenId) || tokenId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid tokenId." }, { status: 400 })
  }

  const wallet = typeof body.walletAddress === "string" ? body.walletAddress.trim() : ""
  const tid = Math.floor(tokenId)
  /** Soroban RPC puede ir unos cientos de ms detrás del último ledger tras mint/settle. */
  let owner: string | null = null
  const backoffMs = [0, 400, 900, 1600]
  for (const ms of backoffMs) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms))
    owner = await fetchTokenOwnerAddress(PHASE_PROTOCOL_CONTRACT, tid)
    if (owner) break
  }

  if (!owner) {
    return NextResponse.json(
      {
        ok: false,
        code: "NFT_NOT_MINTED",
        detail:
          "No on-chain owner for this token id. The NFT was not minted (e.g. mint tx failed) or the id does not exist on this contract.",
        contractId: PHASE_PROTOCOL_CONTRACT,
        tokenId: tid,
      },
      { status: 404 },
    )
  }

  const viewerIsOwner = wallet.length > 0 && owner.toUpperCase() === wallet.toUpperCase()

  // Issue #227: gated-preview authorization.
  //
  // Ownership alone is not the gate — a holder can be a bot, and a *stolen*
  // signature must not open every gated token. A gated grant requires a
  // signature bound to this token, unexpired, and not already used. The
  // response is `private` + `Vary: Authorization` so a shared cache cannot
  // hand one viewer's grant to the next caller.
  //
  // No signature => `gatedVerified: false`. That is the default-deny posture:
  // gated content stays gated when the signature path is absent or broken.
  let gatedVerified = false
  let gatedReason = "no_signature"
  if (typeof body.viewerSignature === "string" && body.viewerSignature.length > 0) {
    const { verifyViewerSignature } = await import("@/lib/viewer-authorization")
    const { recordPreviewVerifyFailure } = await import("@/lib/security-counters")
    const result = await verifyViewerSignature({
      claims: body.viewerClaims,
      signatureBase64: body.viewerSignature,
      contractId: PHASE_PROTOCOL_CONTRACT,
      tokenId: tid,
    })
    if (result.ok) {
      gatedVerified = result.claims.viewer.toUpperCase() === owner.toUpperCase()
      gatedReason = gatedVerified ? "ok" : "viewer_is_not_owner"
      if (gatedVerified) {
        const { incSecurityCounter } = await import("@/lib/security-counters")
        incSecurityCounter("preview_verify_total")
      }
    } else {
      recordPreviewVerifyFailure(result.code)
      gatedReason = result.code
      const { incSecurityCounter } = await import("@/lib/security-counters")
      incSecurityCounter("gated_cdn_leak_blocked")
    }
  }

  // phase-122: off-chain delta probe (flag-gated, best-effort, no regression)
  let delta: { present: boolean; manifest?: unknown; error?: string } | null = null
  if (isPhase122Enabled()) {
    try {
      const { fetchOffchainDelta } = await import("@/lib/offchain-delta")
      const res = await fetchOffchainDelta(PHASE_PROTOCOL_CONTRACT, tid)
      if (res.ok) delta = { present: true, manifest: res.manifest }
      else if (res.code === "NOT_FOUND") delta = { present: false }
      else delta = { present: false, error: res.error }
    } catch (e) {
      delta = { present: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  return NextResponse.json(
    {
      ok: true,
      owner,
      viewerIsOwner,
      gatedVerified,
      gatedReason,
      contractId: PHASE_PROTOCOL_CONTRACT,
      tokenId: tid,
      ...(delta ? { delta } : {}),
      ...(isPhase122Enabled() ? { storage: { onChainStub: `delta:${tid}:<hash8>`, note: "Full metadata off-chain (phase-122); on-chain holds stub only. Rollback: unset FEATURE_PHASE_122." } } : {}),
      // phase-92: audit-only wiring hook — verifies push subscription/dispatch pipeline
      // is loadable without altering NFT ownership verification above.
      ...(isPhase92Enabled() ? { pushNotifications: auditPushNotificationWiring() } : {}),
      // phase-77: audit-only wiring hook — verifies wash trading heuristic pipeline is loadable
      ...(isPhase77Enabled() ? { washTrading: auditWashTradingWiring() } : {}),
    },
    {
      // Issue #227: a per-viewer grant must never be stored by a shared cache.
      headers: { "Cache-Control": "private, no-store", Vary: "Authorization" },
    },
  )
}
