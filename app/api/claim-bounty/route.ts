import { NextRequest, NextResponse } from "next/server"
import {
  BountyClaimError,
  BountyClaimRequestSchema,
  claimBountyWithSnapshot,
  isBountyClaimEnabled,
} from "@/lib/bounty-claim"
import { resolveSessionWallet } from "@/lib/sep10-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  if (!isBountyClaimEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON.", code: "VALIDATION_FAILED" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    )
  }

  const normalizedInput =
    rawBody && typeof rawBody === "object"
      ? {
          ...(rawBody as Record<string, unknown>),
          bountyId:
            (rawBody as Record<string, unknown>).bountyId ??
            (rawBody as Record<string, unknown>).reward,
        }
      : rawBody

  const parsed = BountyClaimRequestSchema.safeParse(normalizedInput)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        code: "VALIDATION_FAILED",
        details: parsed.error.flatten(),
      },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    )
  }

  const sessionWallet = await resolveSessionWallet(request)

  try {
    const claim = await claimBountyWithSnapshot({
      sessionWallet,
      bountyId: parsed.data.bountyId,
      snapshotVersion: parsed.data.snapshotVersion,
      snapshotHash: parsed.data.snapshotHash,
      expectedStoreVersion: parsed.data.expectedStoreVersion,
      claimedWallet: parsed.data.walletAddress ?? parsed.data.userAddress,
    })

    return NextResponse.json(
      {
        ok: true,
        reward: claim.bountyId,
        bountyId: claim.bountyId,
        amountStroops: claim.rewardStroops,
        snapshotVersion: claim.snapshotVersion,
        snapshotHash: claim.snapshotHash,
        storeVersion: claim.storeVersion,
        claimedAt: claim.claimedAt,
      },
      { status: 200, headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (err) {
    if (err instanceof BountyClaimError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: err.status, headers: { "Cache-Control": "private, no-store" } },
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: msg.slice(0, 200) },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    )
  }
}
