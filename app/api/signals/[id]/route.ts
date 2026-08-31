import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getSignal, upvoteSignal, getReplies, editSignal, SignalEditError } from "@/lib/signal-store"
import { createNotification } from "@/lib/notification-store"
import { checkAndUnlock } from "@/lib/achievement-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const signal = await getSignal(id)
  if (!signal) {
    return NextResponse.json({ error: "Signal not found" }, { status: 404 })
  }
  const replies = await getReplies(id)
  return NextResponse.json({ signal, replies })
}

type UpvoteBody = {
  wallet?: unknown
  signature?: unknown
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: UpvoteBody
  try {
    body = (await request.json()) as UpvoteBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 })
  }
  if (typeof body.signature !== "string" || body.signature.length === 0) {
    return NextResponse.json({ error: "Signature required" }, { status: 400 })
  }

  try {
    const signal = await upvoteSignal(id, body.wallet)
    // Notify at milestones: 5, 10, 25 upvotes (fire-and-forget)
    const count = signal.upvotes.length
    if ((count === 5 || count === 10 || count === 25) && signal.author_wallet !== body.wallet) {
      void createNotification(signal.author_wallet, "signal_upvote", {
        signal_id: id,
        signal_title: signal.title,
        upvote_count: count,
      }).catch(() => { /* silent */ })
    }
    // Achievement: track upvotes for the author (fire-and-forget)
    if (signal.author_wallet !== body.wallet) {
      void checkAndUnlock(signal.author_wallet, { upvote_delta: 1 }).catch(() => { /* silent */ })
    }
    return NextResponse.json({ signal })
  } catch {
    return NextResponse.json({ error: "Signal not found" }, { status: 404 })
  }
}

type EditBody = {
  wallet?: unknown
  title?: unknown
  body?: unknown
}

const EDIT_ERROR_STATUS: Record<SignalEditError["code"], number> = {
  FLAG_DISABLED: 404,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
}

// phase-82: edit a signal's title/body, snapshotting the pre-edit state into version history.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: EditBody
  try {
    body = (await request.json()) as EditBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 })
  }

  try {
    const { signal, version } = await editSignal(id, body.wallet, {
      title: typeof body.title === "string" ? body.title : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
    })
    return NextResponse.json({ signal, version })
  } catch (error) {
    if (error instanceof SignalEditError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: EDIT_ERROR_STATUS[error.code] })
    }
    return NextResponse.json({ error: "Failed to edit signal" }, { status: 500 })
  }
}
