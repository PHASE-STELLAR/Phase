import { NextRequest, NextResponse } from "next/server"
import {
  fetchAssetEnrichment,
  fetchTxEnrichment,
  isExplorerEnabled,
  recordEnrichmentOutcome,
  sanitizeEnrichmentRequest,
} from "@/lib/explorer-links"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * phase-220 — read-only Stellar metadata enrichment.
 * Only `kind` + `id` are accepted; any extra query field is rejected so no
 * wallet/email/memo can travel with the request. Failures return 200 with
 * `ok:false` so the UI degrades to the raw hash instead of an error state.
 */
export async function GET(req: NextRequest) {
  if (!isExplorerEnabled()) {
    return NextResponse.json({ error: "Explorer integration disabled (phase-220 off)" }, { status: 404 })
  }

  const sp = req.nextUrl.searchParams
  const input = sanitizeEnrichmentRequest({ kind: sp.get("kind"), id: sp.get("id") })
  if (!input.ok) {
    // Reject unknown query fields too — only kind/id are part of the contract.
    const extras = [...sp.keys()].filter((k) => k !== "kind" && k !== "id")
    if (extras.length > 0 || input.reason === "unexpected-field") {
      return NextResponse.json({ error: "Unexpected request field." }, { status: 400 })
    }
    return NextResponse.json({ error: `Invalid enrichment request (${input.reason}).` }, { status: 400 })
  }

  const result =
    input.kind === "tx" ? await fetchTxEnrichment(input.id) : await fetchAssetEnrichment(input.id)
  recordEnrichmentOutcome(result.ok)
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  })
}
