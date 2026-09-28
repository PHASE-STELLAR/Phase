import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import {
  getSignals,
  createSignal,
  getSignalChannelStats,
} from "@/lib/signal-store"
import { verifySignalSignature } from "@/lib/viewer-signature"
import type { Signal } from "@/lib/signal-store"
import { getAllWorldCollections } from "@/lib/narrative-world-store"
import { checkAndUnlock } from "@/lib/achievement-store"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { nanoid } from "nanoid"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function isValidWallet(w: unknown): w is string {
  return typeof w === "string" && StrKey.isValidEd25519PublicKey(w)
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const channel = sp.get("channel") ?? undefined
  const sort = (sp.get("sort") ?? "hot") as "hot" | "new" | "top"
  const limit = Math.min(Number(sp.get("limit") ?? 20), 100)
  const offset = Number(sp.get("offset") ?? 0)

  const worldStore = await getAllWorldCollections()
  const worldNames: Record<string, string> = {}
  for (const [id, data] of Object.entries(worldStore)) {
    worldNames[id] = data.world_name
  }

  const [all, channels] = await Promise.all([
    getSignals(channel, sort),
    getSignalChannelStats(worldNames),
  ])

  const total = all.length
  const signals = all.slice(offset, offset + limit)

  return NextResponse.json({ signals, total, channels })
}

type CreateSignalBody = {
  title?: unknown
  body?: unknown
  channel?: unknown
  wallet?: unknown
  signature?: unknown
  timestamp?: unknown
  nft_token_id?: unknown
  nft_collection_id?: unknown
  nft_name?: unknown
  nft_image?: unknown
  type?: unknown
  poll_options?: unknown
  poll_closes_at?: unknown
  scheduled_for?: unknown
}

export async function POST(request: NextRequest) {
  let body: CreateSignalBody
  try {
    body = (await request.json()) as CreateSignalBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (!isValidWallet(body.wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 })
  }
  if (typeof body.signature !== "string" || body.signature.length === 0) {
    return NextResponse.json({ error: "Signature required" }, { status: 400 })
  }
  if (typeof body.timestamp !== "number" || !Number.isFinite(body.timestamp)) {
    return NextResponse.json({ error: "Invalid signature timestamp" }, { status: 400 })
  }
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return NextResponse.json({ error: "Title required" }, { status: 400 })
  }
  if (body.title.trim().length > 120) {
    return NextResponse.json({ error: "Title max 120 chars" }, { status: 400 })
  }
  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    return NextResponse.json({ error: "Body required" }, { status: 400 })
  }
  if (body.body.trim().length > 1000) {
    return NextResponse.json({ error: "Body max 1000 chars" }, { status: 400 })
  }
  if (typeof body.channel !== "string" || body.channel.trim().length === 0) {
    return NextResponse.json({ error: "Channel required" }, { status: 400 })
  }

  const walletStr = body.wallet
  const proofPayload = {
    title: body.title.trim(),
    body: (body.body as string).trim(),
    timestamp: body.timestamp as number,
  }
  const signatureVerified = await verifySignalSignature(
    walletStr,
    proofPayload,
    body.signature as string,
  )
  if (!signatureVerified) {
    return NextResponse.json(
      { error: "Invalid signature: payload not signed by this wallet" },
      { status: 400 },
    )
  }

  let poll: Signal["poll"]
  if (body.type === "poll") {
    if (!isFeatureEnabled("phase-90")) {
      return NextResponse.json({ error: "Polls are disabled" }, { status: 404 })
    }
    if (!Array.isArray(body.poll_options) || body.poll_options.length < 2 || body.poll_options.length > 6) {
      return NextResponse.json({ error: "Polls require 2 to 6 options" }, { status: 400 })
    }
    const options = body.poll_options.map((option) => typeof option === "string" ? option.trim() : "")
    if (options.some((option) => option.length === 0 || option.length > 80) || new Set(options).size !== options.length) {
      return NextResponse.json({ error: "Poll options must be unique and 1 to 80 characters" }, { status: 400 })
    }
    let closesAt: number | undefined
    if (body.poll_closes_at != null) {
      closesAt = typeof body.poll_closes_at === "number"
        ? body.poll_closes_at
        : Date.parse(String(body.poll_closes_at))
      if (!Number.isFinite(closesAt) || closesAt <= Date.now()) {
        return NextResponse.json({ error: "Poll close time must be in the future" }, { status: 400 })
      }
    }
    poll = {
      options: options.map((text) => ({ id: nanoid(6), text, voters: [] })),
      ...(closesAt ? { closes_at: closesAt } : {}),
    }
  } else if (body.type != null && body.type !== "post") {
    return NextResponse.json({ error: "type must be post or poll" }, { status: 400 })
  }

  let scheduledFor: number | undefined
  if (body.scheduled_for != null) {
    if (!isFeatureEnabled("phase-89")) {
      return NextResponse.json({ error: "Signal scheduling is disabled" }, { status: 404 })
    }
    scheduledFor = typeof body.scheduled_for === "number"
      ? body.scheduled_for
      : Date.parse(String(body.scheduled_for))
    const latest = Date.now() + 365 * 24 * 60 * 60 * 1000
    if (!Number.isFinite(scheduledFor) || scheduledFor <= Date.now() || scheduledFor > latest) {
      return NextResponse.json({ error: "Schedule time must be within the next year" }, { status: 400 })
    }
  }

  const res = await fetch(
    `${request.nextUrl.origin}/api/artist-profile?walletAddress=${encodeURIComponent(walletStr)}`,
  ).catch(() => null)
  let author_display = `${walletStr.slice(0, 4)}…${walletStr.slice(-4)}`
  if (res?.ok) {
    const data = (await res.json().catch(() => ({}))) as { alias?: string | null }
    if (typeof data.alias === "string" && data.alias.trim().length > 0) {
      author_display = data.alias.trim()
    }
  }

  const signal = await createSignal({
    author_wallet: walletStr,
    author_display,
    channel: (body.channel as string).trim(),
    title: body.title.trim(),
    body: (body.body as string).trim(),
    upvotes: [],
    signature: body.signature as string,
    signature_verified: signatureVerified,
    type: body.type === "poll" ? "poll" : "post",
    ...(poll ? { poll } : {}),
    ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
    ...(typeof body.nft_token_id === "number" ? { nft_token_id: body.nft_token_id } : {}),
    ...(typeof body.nft_collection_id === "number" ? { nft_collection_id: body.nft_collection_id } : {}),
    ...(typeof body.nft_name === "string" ? { nft_name: body.nft_name } : {}),
    ...(typeof body.nft_image === "string" ? { nft_image: body.nft_image } : {}),
  })

  // Achievements: fire-and-forget
  void checkAndUnlock(walletStr, { signal_posted: true }).catch(() => { /* silent */ })

  return NextResponse.json({ signal }, { status: signal.status === "scheduled" ? 202 : 201 })
}
