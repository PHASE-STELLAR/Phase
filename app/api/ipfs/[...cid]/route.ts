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
  _request: NextRequest,
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
    return new NextResponse(result.bytes, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": result.contentType,
        // Issue #227: `Vary: Authorization` is mandatory on this route. Without
        // it a shared cache (s-maxage is 1 year) can key a single response per
        // CID and hand one viewer's gated bytes to the next unauthenticated
        // caller. #229 splits this further into public vs private per CID.
        "Cache-Control": "public, max-age=2592000, s-maxage=31536000, immutable",
        Vary: "Authorization",
        ...(isPhase123Enabled() ? { "X-Phase-Gateway": result.gateway, "X-Phase-Latency-Ms": String(result.latencyMs) } : {}),
      },
    })
  }

  return NextResponse.json(
    { error: "IPFS content unavailable from all gateways.", detail: result.error, perGateway: isPhase123Enabled() ? result.perGateway : undefined },
    { status: 502, headers: CORS },
  )
}
