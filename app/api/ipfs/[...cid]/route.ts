import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { fetchWithIpfsFallback } from "@/lib/phase-nft-metadata-build"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
} as const

// phase-123 wiring: uses isolated fallback chain with per-gateway timeout
const IpfsCidParamSchema = z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/)).min(1).max(10)

function isPhase123Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_123 ?? process.env.FEATURE_PHASE_123 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ cid: string[] }> },
) {
  const { cid } = await context.params
  const parsed = IpfsCidParamSchema.safeParse(cid)
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing or invalid CID", details: parsed.error.flatten() }, { status: 400, headers: CORS })
  }

  const ipfsPath = parsed.data.join("/")

  // phase-123: isolated fallback chain (timeout per gateway, structured error)
  const result = await fetchWithIpfsFallback(ipfsPath, {
    config: isPhase123Enabled() ? { timeoutMs: 4000 } : { timeoutMs: 8000 },
  })

  if (result.ok) {
    // Issue #229: verify the bytes against the CID before they are eligible for
    // any shared cache. A client-supplied `metadata_uri` can name a perfectly
    // well-formed CID bound to an attacker payload; recomputing the multihash
    // is the only check that distinguishes the two. An unverified CID is served
    // `private, no-store` rather than rejected, so the route still functions
    // for a CID this server cannot recompute (blake2b) while keeping it out of
    // the 1-year shared cache.
    const { verifyCID, cacheControlForCid } = await import("@/lib/cid-verification")
    const requestedCid = parsed.data[0] ?? ""
    const verification = verifyCID(requestedCid, result.bytes)
    const gated = request.headers.get("x-phase-gated") === "1"

    if (!verification.ok && verification.code === "CID_MISMATCH") {
      return NextResponse.json(
        { error: "CID Mismatch", detail: verification.reason, cid: requestedCid },
        { status: 400, headers: { ...CORS, "Cache-Control": "private, no-store" } },
      )
    }

    return new NextResponse(result.bytes, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": result.contentType,
        "Cache-Control": cacheControlForCid(verification, gated),
        Vary: "Authorization",
        "X-Phase-Cid-Verified": verification.ok ? "1" : "0",
        ...(isPhase123Enabled() ? { "X-Phase-Gateway": result.gateway, "X-Phase-Latency-Ms": String(result.latencyMs) } : {}),
      },
    })
  }

  return NextResponse.json(
    { error: "IPFS content unavailable from all gateways.", detail: result.error, perGateway: isPhase123Enabled() ? result.perGateway : undefined },
    { status: 502, headers: CORS },
  )
}
