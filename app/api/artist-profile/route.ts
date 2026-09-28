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

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ArtistProfileBody = {
  walletAddress?: unknown
  alias?: unknown
  handle?: unknown
}

function handleResponseStatus(code: string) {
  if (code === "HANDLE_TAKEN") return 409
  if (code === "NOT_FOUND") return 404
  return 400
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("walletAddress")?.trim() ?? ""
  const handle = req.nextUrl.searchParams.get("handle")?.trim() ?? ""

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