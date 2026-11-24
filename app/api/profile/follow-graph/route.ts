import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getFollowers, getFollowing, followUser } from "@/lib/follow-store"
import {
  FollowGraphPortabilityError,
  buildFollowGraphExport,
  isPhase95Enabled,
  parseFollowGraphImport,
} from "@/lib/env-validation"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function statusForCode(code: FollowGraphPortabilityError["code"]): number {
  switch (code) {
    case "FLAG_DISABLED":
      return 403
    case "VALIDATION_FAILED":
      return 400
    case "CHECKSUM_MISMATCH":
      return 422
    case "WALLET_MISMATCH":
      return 409
    default:
      return 500
  }
}

/** GET ?wallet=G... — export the wallet's follow graph as a portable, checksummed bundle. */
export async function GET(req: NextRequest) {
  if (!isPhase95Enabled()) {
    return NextResponse.json({ error: "Follow-graph export disabled (phase-95 flag off)" }, { status: 403 })
  }
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 })
  }
  try {
    const [following, followers] = await Promise.all([getFollowing(wallet), getFollowers(wallet)])
    const bundle = buildFollowGraphExport(wallet, following, followers)
    return NextResponse.json(bundle)
  } catch (e) {
    if (e instanceof FollowGraphPortabilityError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: statusForCode(e.code) })
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}

/** POST { wallet, bundle } — validate + import a previously exported follow graph, merging into the store. */
export async function POST(req: NextRequest) {
  if (!isPhase95Enabled()) {
    return NextResponse.json({ error: "Follow-graph import disabled (phase-95 flag off)" }, { status: 403 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 })
  }
  const { wallet, bundle } = (body ?? {}) as { wallet?: unknown; bundle?: unknown }
  if (typeof wallet !== "string" || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 })
  }

  try {
    const imported = parseFollowGraphImport(bundle, { expectedWallet: wallet })
    let merged = 0
    for (const target of imported.following) {
      if (!StrKey.isValidEd25519PublicKey(target) || target === wallet) continue
      await followUser(wallet, target)
      merged++
    }
    return NextResponse.json({ ok: true, wallet, mergedFollowing: merged })
  } catch (e) {
    if (e instanceof FollowGraphPortabilityError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: statusForCode(e.code) })
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 500 })
  }
}
