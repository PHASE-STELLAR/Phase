import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  ArtistAttestationError,
  IssueBadgeRequestSchema,
  checkOnChainArtistAttestation,
  getVerifiedArtistBadge,
  isPhase94Enabled,
  issueVerifiedArtistBadge,
} from "@/lib/artist-attestation"
import { createApiRequestContext } from "@/lib/api-observability"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function statusForCode(code: ArtistAttestationError["code"]): number {
  switch (code) {
    case "FLAG_DISABLED":
      return 403
    case "VALIDATION_FAILED":
      return 400
    case "SIGNATURE_INVALID":
      return 401
    case "ALREADY_ISSUED":
      return 409
    case "NOT_FOUND":
      return 404
    default:
      return 500
  }
}

/**
 * Issue #225: admin gate for badge issuance.
 *
 * Attestation is the trust anchor for World collections and explore ranking,
 * so issuance is restricted to the operator key (PHASE_ADMIN_KEY via
 * `x-admin-key`) in addition to the per-wallet signature the lib already
 * verifies. When PHASE_ADMIN_KEY is unset the route is closed (503) rather
 * than open, so a missing secret can never silently fall back to public.
 */
function adminAuthOk(req: NextRequest): { ok: true } | { ok: false; status: number; error: string } {
  const adminKey = process.env.PHASE_ADMIN_KEY?.trim()
  if (!adminKey) {
    return { ok: false, status: 503, error: "Badge issuance is not configured (PHASE_ADMIN_KEY unset)." }
  }
  const provided = req.headers.get("x-admin-key")?.trim()
  if (!provided || provided !== adminKey) {
    return { ok: false, status: 403, error: "Forbidden" }
  }
  return { ok: true }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("walletAddress")?.trim() ?? ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "walletAddress invalida." }, { status: 400 })
  }
  const badge = await getVerifiedArtistBadge(wallet)
  return NextResponse.json({
    walletAddress: wallet,
    verified: badge != null,
    badge,
    feature_enabled: isPhase94Enabled(),
  })
}

export async function POST(req: NextRequest) {
  const api = createApiRequestContext(req, "/api/artist-badge")

  // Issue #225: admin_auth before anything else.
  const auth = adminAuthOk(req)
  if (!auth.ok) {
    api.log("warn", "artist_badge_spoof_attempt", { status: auth.status, reason: auth.error })
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 })
  }

  const parsed = IssueBadgeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  // Issue #225: the on-chain attestation is the trust anchor — never issue an
  // off-chain badge for an artist the contract has not attested.
  const onChain = await checkOnChainArtistAttestation(parsed.data.wallet)
  if (onChain === "not_attested") {
    api.log("warn", "artist_attestation_onchain_mismatch", { wallet: parsed.data.wallet })
    return NextResponse.json(
      { ok: false, error: "Not Attested On-Chain", code: "NOT_ATTESTED" },
      { status: 400 },
    )
  }
  if (onChain === "unavailable") {
    api.log("warn", "artist_attestation_rpc_unavailable", { wallet: parsed.data.wallet })
    return NextResponse.json(
      { ok: false, error: "Attestation chain unavailable, try again shortly", code: "CHAIN_UNAVAILABLE" },
      { status: 503 },
    )
  }

  try {
    const badge = await issueVerifiedArtistBadge(parsed.data)
    return NextResponse.json({ ok: true, badge })
  } catch (e) {
    if (e instanceof ArtistAttestationError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: statusForCode(e.code) })
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 500 })
  }
}
