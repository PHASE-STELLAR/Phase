import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"
import { voteOnPoll } from "@/lib/signal-store"
import { isFeatureEnabled } from "@/lib/feature-flags"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VoteSchema = z.object({
  option_id: z.string().trim().min(1).max(64),
  wallet: z.string().refine((value) => StrKey.isValidEd25519PublicKey(value), "Invalid wallet"),
  signature: z.string().trim().min(1),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isFeatureEnabled("phase-90")) {
    return NextResponse.json({ error: "Polls are disabled" }, { status: 404 })
  }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const parsed = VoteSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid vote" }, { status: 400 })
  }
  try {
    const { id } = await params
    const signal = await voteOnPoll(id, parsed.data.option_id, parsed.data.wallet)
    return NextResponse.json({ signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vote failed"
    return NextResponse.json({ error: message }, { status: message === "Poll not found" ? 404 : 409 })
  }
}
