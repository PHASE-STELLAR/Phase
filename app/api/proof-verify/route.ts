import { NextRequest, NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  getProofVerificationByHash,
  getProofVerificationByMsgId,
  ProofSubmissionSchema,
  verifyAndRecordProof,
} from "@/lib/proof-relay"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/proof-verify?msg_id=... | ?proof_hash=...
 * Check the verification status of a cross-chain proof
 */
export async function GET(request: NextRequest) {
  if (!isFeatureEnabled("phase-249")) {
    return NextResponse.json(
      { error: "Proof relay verification disabled (phase-249 flag off)." },
      { status: 404 },
    )
  }

  try {
    const proofHash = request.nextUrl.searchParams.get("proof_hash")?.trim()
    const msgId = request.nextUrl.searchParams.get("msg_id")?.trim()
    if (!proofHash && !msgId) {
      return NextResponse.json(
        { error: "Missing msg_id or proof_hash parameter" },
        { status: 400 },
      )
    }

    const record = proofHash
      ? getProofVerificationByHash(proofHash.toLowerCase())
      : getProofVerificationByMsgId(msgId!)

    if (!record) {
      return NextResponse.json({
        msg_id: msgId ?? null,
        proof_hash: proofHash ?? null,
        status: "pending",
        source_chain: "unknown",
      })
    }

    return NextResponse.json({
      ...record,
      replayed: false,
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Proof verification lookup failed", details: String(error) },
      { status: 500 },
    )
  }
}

/**
 * POST /api/proof-verify
 * Submit a proof with multi-signature attestations for verification
 */
export async function POST(request: NextRequest) {
  if (!isFeatureEnabled("phase-249")) {
    return NextResponse.json(
      { error: "Proof relay verification disabled (phase-249 flag off)." },
      { status: 404 },
    )
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 })
  }

  const parsed = ProofSubmissionSchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "INVALID_SCHEMA",
        status: "failed",
        error: "Proof submission schema validation failed.",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    )
  }

  const outcome = await verifyAndRecordProof(parsed.data)
  if (!outcome.ok) {
    const statusCode = outcome.retryable ? 503 : 400
    return NextResponse.json(
      {
        code: outcome.code,
        status: "failed",
        proof_hash: outcome.proofHash,
        retryable: outcome.retryable,
        error: outcome.error,
      },
      { status: statusCode },
    )
  }

  return NextResponse.json(
    {
      ...outcome.record,
      replayed: outcome.replayed,
    },
    { status: outcome.replayed ? 200 : 201 },
  )
}
