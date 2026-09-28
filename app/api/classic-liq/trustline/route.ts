import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { logHorizonSubmitError } from "@/lib/stellar"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { submitTrustlineBatch } from "@/lib/classic-liq"

export const dynamic = 'force-dynamic'

// ─── phase-119: CID integrity schema (isolated, additive) ────────────────────
// ─── phase-134: accepts either a single `signedXdr` (legacy) or a
// `signedXdrs` array (batch). CID verification (phase-119) only applies to
// the single-XDR legacy path — batch callers are expected to have verified
// content before signing.
const TrustlinePostSchema = z.object({
  signedXdr: z.string().trim().min(10).optional(),
  signedXdrs: z.array(z.string().trim().min(10)).min(1).max(20).optional(),
  // optional re-pinned content CID to verify before trustline submission
  cid: z.string().trim().min(4).max(128).regex(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z0-9]+|bafk[a-z0-9]+).*/).optional().nullable(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  // if the caller also sends bytesRef (gateway URL) we can fetch + verify; otherwise just validate format
  cidPath: z.string().trim().max(512).regex(/^[A-Za-z0-9._\/-]+$/).optional().nullable(),
}).refine((v) => Boolean(v.signedXdr?.trim()) || (v.signedXdrs?.length ?? 0) > 0, {
  message: "signedXdr or signedXdrs is required.",
})

function isPhase119Enabled(): boolean {
  return isFeatureEnabled("phase-119")
}

export async function POST(req: NextRequest) {
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 })
  }

  const parsed = TrustlinePostSchema.safeParse(rawBody)
  if (!parsed.success) {
    // phase-144 (Module #44): quarantine the malformed payload for operator
    // review instead of dropping it silently. No-op when the flag is off.
    const quarantined = await import("@/lib/x402-dead-letter")
      .then((m) =>
        m.quarantineInvoice({
          source: "classic-liq/trustline:POST",
          raw: rawBody,
          reasons: parsed.error.issues,
        }),
      )
      .catch((e) => {
        logHorizonSubmitError("classic-liq/trustline dead-letter write", e)
        return null
      })
    if (quarantined?.quarantined) {
      return NextResponse.json(
        {
          error: "Malformed request quarantined for review.",
          code: "QUARANTINED",
          deadLetterId: quarantined.id,
          details: parsed.error.flatten(),
        },
        { status: 422 },
      )
    }
    return NextResponse.json({ error: "signedXdr es requerido.", details: parsed.error.flatten() }, { status: 400 })
  }

  const isBatch = (parsed.data.signedXdrs?.length ?? 0) > 0
  const signedXdrs = isBatch ? parsed.data.signedXdrs!.map((x) => x.trim()) : [parsed.data.signedXdr!.trim()]

  // phase-119: optional CID integrity verification (additive, does not block legacy callers).
  // Only applies to the single-XDR legacy path.
  if (!isBatch && isPhase119Enabled() && parsed.data.cid) {
    const cidStr = parsed.data.cid.trim()
    const expected = parsed.data.expectedSha256 ?? null
    try {
      // Validate CID format strictly
      const { CidSchema, verifyBytesIntegrity, sha256Hex, getCachedCid } = await import("@/lib/cid-cache")
      const cidCheck = CidSchema.safeParse(cidStr)
      if (!cidCheck.success) {
        return NextResponse.json({ error: `Invalid CID: ${cidStr.slice(0, 12)}…`, code: "CID_INVALID" }, { status: 400 })
      }
      // If cidPath provided, fetch and verify tampering
      if (parsed.data.cidPath) {
        try {
          const { fetchWithCidCache } = await import("@/lib/cid-cache")
          const fetched = await fetchWithCidCache(parsed.data.cidPath, { expectedSha256: expected })
          if (!fetched.ok) {
            return NextResponse.json({ error: fetched.error, code: fetched.code, cid: cidStr }, { status: 409 })
          }
          // verified — continue to trustline submission
        } catch (e) {
          return NextResponse.json({ error: e instanceof Error ? e.message : String(e), code: "CID_VERIFY_FAILED" }, { status: 409 })
        }
      } else if (expected) {
        // CID + expected hash supplied without bytes: check cache integrity
        try {
          const cached = await getCachedCid(cidStr, { expectedSha256: expected })
          if (cached && !verifyBytesIntegrity(cached.bytes, expected)) {
            return NextResponse.json({ error: `Cached CID ${cidStr.slice(0, 8)}… fails integrity check`, code: "HASH_MISMATCH" }, { status: 409 })
          }
          // if not cached, we allow submission but warn via header later
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return NextResponse.json({ error: msg, code: "CID_TAMPERED" }, { status: 409 })
        }
      }
    } catch (e) {
      logHorizonSubmitError("classic-liq/trustline CID boundary", e)
      await import("@/lib/x402-dead-letter")
        .then((m) => m.quarantineInvoice({ source: "classic-liq/trustline:cid", raw: rawBody }))
        .catch(() => {})
      return NextResponse.json(
        { error: "CID verification failed unexpectedly.", code: "CID_BOUNDARY_ERROR" },
        { status: 409 },
      )
    }
  }

  const results = await submitTrustlineBatch(signedXdrs)
  for (const r of results) {
    if (!r.ok) logHorizonSubmitError("classic-liq/trustline submit", r.cause ?? r.error)
  }
  // Drop internal `cause` before returning to the client.
  const publicResults = results.map((r) =>
    r.ok ? r : { signedXdr: r.signedXdr, ok: r.ok, error: r.error, attempts: r.attempts },
  )

  // phase-119 observability headers (legacy single-XDR path only)
  const headers: Record<string, string> = {}
  if (!isBatch && isPhase119Enabled()) {
    headers["X-Phase119"] = "enabled"
    if (parsed.data.cid) headers["X-Phase-CID"] = parsed.data.cid.slice(0, 16)
  }

  if (isBatch) {
    const anyOk = results.some((r) => r.ok)
    return NextResponse.json({ ok: anyOk, results: publicResults }, { status: anyOk ? 200 : 502, headers })
  }

  // Legacy single-XDR response shape — unchanged for existing callers.
  const single = results[0]!
  if (!single.ok) {
    return NextResponse.json({ error: single.error }, { status: 502, headers })
  }
  return NextResponse.json({ ok: true, hash: single.hash }, { headers })
}

// GET exposes cache stats when flag enabled (observability, zero regression when off)
export async function GET(req: NextRequest) {
  // phase-144 (Module #44): dead-letter review queue for operators.
  if (new URL(req.url).searchParams.get("view") === "dead-letter") {
    const { isX402DeadLetterEnabled, listDeadLetterQueue, getDeadLetterStats } = await import(
      "@/lib/x402-dead-letter"
    )
    if (!isX402DeadLetterEnabled()) {
      return NextResponse.json({ enabled: false, error: "phase-144 flag disabled" }, { status: 404 })
    }
    const statusParam = new URL(req.url).searchParams.get("status")
    const status =
      statusParam === "open" || statusParam === "resolved" || statusParam === "discarded"
        ? statusParam
        : undefined
    const [queue, stats] = await Promise.all([
      listDeadLetterQueue({ status, limit: 100 }),
      getDeadLetterStats(),
    ])
    return NextResponse.json({ enabled: true, stats, queue })
  }

  if (!isPhase119Enabled()) {
    return NextResponse.json({ enabled: false, error: "phase-119 flag disabled" }, { status: 404 })
  }
  try {
    const { getCidCacheStats } = await import("@/lib/cid-cache")
    const stats = getCidCacheStats()
    return NextResponse.json({ enabled: true, stats })
  } catch (e) {
    return NextResponse.json({ enabled: true, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
