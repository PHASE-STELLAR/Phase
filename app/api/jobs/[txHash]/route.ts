/**
 * GET /api/jobs/[txHash]
 *
 * Client polling endpoint for async image generation status.
 * The client calls this with the settlement transaction hash it already holds
 * to track job progress until completion or failure.
 *
 * Response shape:
 *   200 { found: true, job: { status, imageUrl?, result?, error?, ... } }
 *   404 { found: false }
 *
 * Typical polling interval: 3–5 seconds. The client should stop polling on
 * status === 'completed' | 'failed', or after a client-side timeout (e.g. 3 min).
 *
 * Cache-Control: no-store to prevent stale responses from CDN.
 */

import { NextRequest, NextResponse } from "next/server"
import { getGenerationJobByTxHash } from "@/lib/generation-job-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ txHash: string }> },
): Promise<NextResponse> {
  const { txHash } = await context.params
  const decoded = decodeURIComponent(txHash).trim()

  if (!decoded || decoded.length < 8) {
    return NextResponse.json(
      { found: false, error: "Invalid txHash" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  }

  try {
    const job = await getGenerationJobByTxHash(decoded)

    if (!job) {
      return NextResponse.json(
        { found: false },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      )
    }

    return NextResponse.json(
      {
        found: true,
        job: {
          id: job.id,
          txHash: job.txHash,
          status: job.status,
          imageUrl: job.imageUrl,
          result: job.result,
          error: job.error,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[jobs/txHash] Error reading job store:", msg)
    return NextResponse.json(
      { found: false, error: "Internal error reading job status" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}
