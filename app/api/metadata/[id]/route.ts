import { serverLog } from "@/lib/server-logger"
import { NextResponse, type NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { buildPhaseTokenMetadataJson, isPhase93Enabled, isPhase78Enabled, PhaseMetadataRequestSchema } from "@/lib/phase-nft-metadata-build"
import { phaseProtocolContractIdForServer } from "@/lib/phase-protocol"
import {
  commitMetadataDraft,
  DesignStudioMetadataError,
  getCommittedArtifactMetadata,
  getMetadataDraft,
  isDesignStudioMetadataEnabled,
  previewArtifactMetadata,
  saveMetadataDraft,
} from "@/lib/design-studio-metadata"

export const dynamic = "force-dynamic"

// phase-123: feature flag check (rollback: unset NEXT_PUBLIC_FEATURE_PHASE_123)
function isPhase123Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_123 ?? process.env.FEATURE_PHASE_123 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const MetadataIdParamSchema = z.coerce.number().int().min(1).max(1_000_000)

const corsJson = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, Accept, If-Match",
  "Access-Control-Max-Age": "86400",
} as const

/** Freighter / wallets pueden hacer preflight antes del GET del JSON de metadata. */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsJson })
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const parsedId = MetadataIdParamSchema.safeParse(id)
  if (!parsedId.success) {
    return NextResponse.json(
      { error: "invalid id", details: parsedId.error.flatten() },
      { status: 400, headers: { ...corsJson, "Content-Type": "application/json; charset=utf-8" } },
    )
  }
  const tokenId = parsedId.data

  const cParam = request.nextUrl.searchParams.get("c")?.trim() ?? ""
  const contractId =
    cParam && StrKey.isValidContract(cParam) ? cParam : phaseProtocolContractIdForServer()

  // Issue #229: a caller-supplied `m` (metadata_uri) is not trusted before it
  // is resolved. `ipfs://` CIDv1/v0 only — an `https://` URI is not
  // content-addressed, so whatever that origin returns would be served as the
  // World's metadata and then cached for a year. Rejected here, before any
  // fetch, so a poisoned URI never reaches a gateway or the CID cache.
  const metadataUriParam = request.nextUrl.searchParams.get("m")?.trim()
  if (metadataUriParam) {
    const { parseMetadataUri } = await import("@/lib/cid-verification")
    const uriResult = parseMetadataUri(metadataUriParam)
    if (!uriResult.ok) {
      return NextResponse.json(
        { error: "invalid metadata_uri", code: uriResult.code, detail: uriResult.reason },
        { status: 400, headers: { ...corsJson, "Cache-Control": "private, no-store" } },
      )
    }
  }

  // phase-123: validate contract+token pair when flag enabled (type-safe, structured error)
  if (isPhase123Enabled()) {
    const chk = PhaseMetadataRequestSchema.safeParse({ contractId, tokenId })
    if (!chk.success) {
      return NextResponse.json(
        { error: "validation failed", details: chk.error.flatten() },
        { status: 400, headers: { ...corsJson, "Content-Type": "application/json; charset=utf-8" } },
      )
    }
  }

  // phase-258: serve Design Studio draft or committed metadata when flag enabled
  if (isDesignStudioMetadataEnabled()) {
    if (request.nextUrl.searchParams.get("draft") === "1") {
      const draft = await getMetadataDraft(tokenId, contractId)
      if (!draft) {
        return NextResponse.json(
          { error: "draft not found" },
          { status: 404, headers: { ...corsJson, "Cache-Control": "private, no-store" } },
        )
      }
      return NextResponse.json(
        draft,
        {
          headers: {
            ...corsJson,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store",
            ETag: draft.etag,
          },
        },
      )
    }

    const committed = await getCommittedArtifactMetadata(tokenId, contractId)
    if (committed) {
      return NextResponse.json(
        committed.metadata,
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsJson,
            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
            Vary: "Authorization",
            ETag: committed.etag,
            "X-Phase-Design-Studio-Metadata": "committed",
          },
        },
      )
    }
  }

  let payload: Awaited<ReturnType<typeof buildPhaseTokenMetadataJson>>
  try {
    payload = await buildPhaseTokenMetadataJson(contractId, tokenId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Structured error handling: don't leak internal, but log with flag context
    if (isPhase123Enabled()) {
      serverLog.warn(`[phase-123] metadata build failed token=${tokenId} contract=${contractId.slice(0, 8)}…: ${msg}`)
    }
    return NextResponse.json(
      { error: "metadata build failed", detail: msg.slice(0, 200) },
      { status: 502, headers: { ...corsJson, "Content-Type": "application/json; charset=utf-8" } },
    )
  }
  if (!payload) {
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: { ...corsJson, "Content-Type": "application/json; charset=utf-8" } },
    )
  }

  return NextResponse.json(
    payload,
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsJson,
        // Issue #227/#229: `Vary: Authorization` keeps a shared cache from
        // serving one viewer's entry to the next caller now that metadata can be
        // gated (#227) and CID-verified (#229).
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        Vary: "Authorization",
        ...(isPhase123Enabled() ? { "X-Phase-IPFS-Fallback": "enabled" } : {}),
        ...(isPhase93Enabled() ? { "X-Phase-Profile-Completeness": "enabled" } : {}),
        ...(isPhase78Enabled() ? { "X-Phase-Gas-Estimate": "enabled" } : {}),
      },
    },
  )
}

// ── Spike 673: edition attributes ride the existing 60s CDN body (per-token URL, no extra
// Vary needed). Token renumbering rule: existing token_id names/URIs are stable; new mints
// append `edition` / `artist_proof` traits via buildPhaseTokenMetadataJson. Cache invalidation
// is natural expiry (s-maxage=60). No header change when flag off.

// ── phase-258: Design Studio artifact metadata draft + commit handlers ──────
async function parseWriteRequest(request: NextRequest, idParam: string): Promise<
  | { ok: true; tokenId: number; contractId: string; body: Record<string, unknown>; ifMatch: string | null }
  | { ok: false; response: NextResponse }
> {
  if (!isDesignStudioMetadataEnabled()) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404, headers: corsJson }),
    }
  }
  const parsedId = MetadataIdParamSchema.safeParse(idParam)
  if (!parsedId.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid id", details: parsedId.error.flatten() },
        { status: 400, headers: corsJson },
      ),
    }
  }
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsJson }),
    }
  }
  const cParam =
    (typeof body.contractId === "string" ? body.contractId.trim() : "") ||
    (request.nextUrl.searchParams.get("c")?.trim() ?? "")
  const contractId =
    cParam && StrKey.isValidContract(cParam) ? cParam : phaseProtocolContractIdForServer()
  return {
    ok: true,
    tokenId: parsedId.data,
    contractId,
    body,
    ifMatch: request.headers.get("if-match"),
  }
}

function metadataErrorResponse(err: unknown): NextResponse {
  if (err instanceof DesignStudioMetadataError) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status: err.status, headers: { ...corsJson, "Cache-Control": "private, no-store" } },
    )
  }
  const msg = err instanceof Error ? err.message : String(err)
  return NextResponse.json(
    { error: msg.slice(0, 200) },
    { status: 500, headers: { ...corsJson, "Cache-Control": "private, no-store" } },
  )
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const parsed = await parseWriteRequest(request, id)
  if (!parsed.ok) return parsed.response

  try {
    const draft = await saveMetadataDraft({
      tokenId: parsed.tokenId,
      contractId: parsed.contractId,
      metadata: parsed.body.metadata ?? parsed.body,
      ifMatch: parsed.ifMatch,
      updatedBy: typeof parsed.body.updatedBy === "string" ? parsed.body.updatedBy : undefined,
    })
    return NextResponse.json(
      { ok: true, draft },
      {
        status: 200,
        headers: {
          ...corsJson,
          "Cache-Control": "private, no-store",
          ETag: draft.etag,
        },
      },
    )
  } catch (err) {
    return metadataErrorResponse(err)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const parsed = await parseWriteRequest(request, id)
  if (!parsed.ok) return parsed.response

  try {
    if (parsed.body.action === "preview") {
      const preview = previewArtifactMetadata(parsed.body.metadata ?? parsed.body)
      return NextResponse.json(
        { ok: true, preview },
        { status: 200, headers: { ...corsJson, "Cache-Control": "private, no-store" } },
      )
    }

    const committed = await commitMetadataDraft({
      tokenId: parsed.tokenId,
      contractId: parsed.contractId,
      metadata: parsed.body.metadata,
      ifMatch: parsed.ifMatch,
      updatedBy: typeof parsed.body.updatedBy === "string" ? parsed.body.updatedBy : undefined,
    })
    return NextResponse.json(
      { ok: true, draft: committed.draft, metadata: committed.metadata },
      {
        status: 200,
        headers: {
          ...corsJson,
          "Cache-Control": "private, no-store",
          ETag: committed.draft.etag,
        },
      },
    )
  } catch (err) {
    return metadataErrorResponse(err)
  }
}
