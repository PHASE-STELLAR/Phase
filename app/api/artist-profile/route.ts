import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getProfileHandle,
  resolveProfileHandle,
  saveProfileHandle,
  isPhase66Enabled,
  getCrtBundleSavingsSummary,
  isFaucetRateLimitRedisEnabled,
  auditFaucetRateLimitWiring,
} from "@/lib/profile-store"
import {
  getArtistAliasAudit,
  getSignedArtistAlias,
  isArtistAttestationV2Enabled,
  resolveSignedArtistAlias,
  saveSignedArtistAlias,
} from "@/lib/artist-attestation"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ArtistProfileBody = {
  walletAddress?: unknown
  alias?: unknown
  handle?: unknown
  expectedVersion?: unknown
  issuedAt?: unknown
  nonce?: unknown
  signature?: unknown
  attested?: unknown
}

function handleResponseStatus(code: string) {
  if (code === "HANDLE_TAKEN") return 409
  if (code === "NOT_FOUND") return 404
  return 400
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("walletAddress")?.trim() ?? ""
  const handle = req.nextUrl.searchParams.get("handle")?.trim() ?? ""
  const includeAudit = req.nextUrl.searchParams.get("audit") === "1"

  if (isArtistAttestationV2Enabled(wallet || undefined)) {
    if (handle) {
      const resolved = resolveSignedArtistAlias(handle)
      if (!resolved) {
        return NextResponse.json({ error: "Alias not found", code: "NOT_FOUND", feature_enabled: true }, { status: 404 })
      }
      return NextResponse.json({
        walletAddress: resolved.wallet,
        alias: resolved.alias,
        handle: resolved.alias,
        version: resolved.version,
        attested: resolved.attested,
        updatedAt: resolved.updatedAt,
        feature_enabled: true,
      })
    }

    if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
      return NextResponse.json({ error: "walletAddress invalida." }, { status: 400 })
    }

    const record = getSignedArtistAlias(wallet)
    return NextResponse.json({
      walletAddress: wallet,
      alias: record?.alias ?? null,
      handle: record?.alias ?? null,
      version: record?.version ?? 0,
      attested: record?.attested ?? false,
      updatedAt: record?.updatedAt ?? null,
      ...(includeAudit ? { audit: getArtistAliasAudit(wallet) } : {}),
    })
  }

  if (handle) {
    const resolved = await resolveProfileHandle(handle)
    if (!resolved.ok) {
      return NextResponse.json(
        { error: resolved.error, code: resolved.code, feature_enabled: resolved.featureEnabled },
        { status: handleResponseStatus(resolved.code) },
      )
    }

    return NextResponse.json({
      walletAddress: resolved.walletAddress,
      alias: resolved.handle,
      handle: resolved.handle,
      updatedAt: resolved.updatedAt,
      feature_enabled: resolved.featureEnabled,
    })
  }

  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "walletAddress invalida." }, { status: 400 })
  }

  const profile = await getProfileHandle(wallet)
  return NextResponse.json({
    walletAddress: wallet,
    alias: profile?.handle ?? null,
    handle: profile?.handle ?? null,
    updatedAt: profile?.updatedAt ?? null,
    ...(isPhase66Enabled() ? { crt_code_split: getCrtBundleSavingsSummary() } : {}),
    ...(isFaucetRateLimitRedisEnabled() ? { faucet_rate_limit: auditFaucetRateLimitWiring() } : {}),
  })
}

export async function POST(req: NextRequest) {
  let body: ArtistProfileBody
  try {
    body = (await req.json()) as ArtistProfileBody
  } catch {
    return NextResponse.json({ error: "JSON invalido." }, { status: 400 })
  }

  const wallet = typeof body.walletAddress === "string" ? body.walletAddress.trim() : ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "walletAddress invalida." }, { status: 400 })
  }

  const handle = typeof body.handle === "string" ? body.handle : typeof body.alias === "string" ? body.alias : ""

  if (isArtistAttestationV2Enabled(wallet)) {
    const lang = req.headers.get("accept-language")?.split(",")[0]?.split("-")[0]
    const saved = saveSignedArtistAlias(
      {
        wallet,
        alias: handle,
        expectedVersion: body.expectedVersion,
        issuedAt: body.issuedAt,
        nonce: body.nonce,
        signature: body.signature,
        attested: body.attested,
      },
      lang,
    )
    if (!saved.ok) {
      return NextResponse.json(
        {
          error: saved.error,
          code: saved.code,
          currentVersion: saved.currentVersion,
          feature_enabled: true,
        },
        { status: saved.status },
      )
    }

    return NextResponse.json({
      ok: true,
      walletAddress: saved.record.wallet,
      alias: saved.record.alias,
      handle: saved.record.alias,
      version: saved.record.version,
      attested: saved.record.attested,
      updatedAt: saved.record.updatedAt,
      feature_enabled: true,
    })
  }

  const saved = await saveProfileHandle(wallet, handle)
  if (!saved.ok) {
    return NextResponse.json(
      { error: saved.error, code: saved.code, feature_enabled: saved.featureEnabled },
      { status: handleResponseStatus(saved.code) },
    )
  }

  return NextResponse.json({
    ok: true,
    walletAddress: wallet,
    alias: saved.handle,
    handle: saved.handle,
    updatedAt: saved.updatedAt,
    feature_enabled: saved.featureEnabled,
  })
}
