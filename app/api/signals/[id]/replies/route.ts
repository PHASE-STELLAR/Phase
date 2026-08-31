import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getSignal, createReply, AttributionInReplySchema, recordReplyAttribution, getSignalContributors, computeCreditLedger, isPhase136Enabled, resolveCidGateway, extractIpfsCidPath } from "@/lib/signal-store"
import { createNotification } from "@/lib/notification-store"
import { dispatchPushNotification, extractMentionedWallets, isPhase92Enabled } from "@/lib/push-notifications"
import { createApiRequestContext } from "@/lib/api-observability"
import { verifySignalSignature } from "@/lib/viewer-signature"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { z } from "zod"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function isPhase116Enabled(): boolean {
  return isFeatureEnabled("phase-116")
}

/** phase-136: resolve a signal's NFT image CID through the cached gateway picker. */
function resolveSignalImage(nftImage: string | undefined): { image: string; gateway: string } | null {
  if (!isPhase136Enabled()) return null
  const cidPath = extractIpfsCidPath(nftImage)
  if (!cidPath) return null
  try {
    const resolved = resolveCidGateway(cidPath)
    return { image: resolved.url, gateway: resolved.gateway }
  } catch {
    return null
  }
}

type ReplyBody = {
  body?: unknown
  wallet?: unknown
  signature?: unknown
  timestamp?: unknown
  attribution?: unknown
  contributors?: unknown
}

const ContributorsArraySchema = z.array(
  z.object({
    wallet: z.string().trim().length(56).regex(/^G[A-Z2-7]{55}$/),
    displayName: z.string().trim().min(1).max(48),
    role: z.enum(["author", "co_author", "editor", "illustrator", "translator"]).default("co_author"),
    shareBps: z.number().int().min(0).max(10_000).default(1000),
  }),
).max(5).optional()

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]/replies")
  const { id } = await params
  let body: ReplyBody
  try {
    body = (await request.json()) as ReplyBody
  } catch {
    return api.json({ error: "Invalid JSON" }, { status: 400, event: "signals.reply.invalid_json" })
  }

  if (typeof body.wallet !== "string" || !StrKey.isValidEd25519PublicKey(body.wallet)) {
    return api.json(
      { error: "Invalid wallet address" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "wallet" } },
    )
  }
  if (typeof body.signature !== "string" || body.signature.length === 0) {
    return api.json(
      { error: "Signature required" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "signature" } },
    )
  }
  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    return api.json(
      { error: "Body required" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "body" } },
    )
  }
  if (body.body.trim().length > 500) {
    return api.json(
      { error: "Body max 500 chars" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "body_length" } },
    )
  }
  if (typeof body.timestamp !== "number" || !Number.isFinite(body.timestamp)) {
    return api.json(
      { error: "Invalid signature timestamp" },
      { status: 400, event: "signals.reply.validation_failed", metadata: { reason: "timestamp" } },
    )
  }

  const walletStr = body.wallet
  const signatureVerified = await verifySignalSignature(
    walletStr,
    { title: "", body: (body.body as string).trim(), timestamp: body.timestamp as number },
    body.signature as string,
  )
  if (!signatureVerified) {
    return api.json(
      { error: "Invalid signature: reply not signed by this wallet" },
      { status: 400, event: "signals.reply.invalid_signature" },
    )
  }

  // phase-156 (Module #56): reject posts from wallets on the governed deny-list.
  // No-op when the flag is off. Wrapped so a store read failure never 500s the
  // reply path.
  if (isFaucetDenyListEnabled()) {
    try {
      if (await isWalletDenied(body.wallet)) {
        const entry = await getWalletDenyEntry(body.wallet).catch(() => null)
        return api.json(
          {
            error: "This wallet is excluded from posting.",
            code: "WALLET_DENIED",
            ...(entry ? { reason: entry.reason, entryId: entry.id } : {}),
          },
          { status: 403, event: "signals.reply.wallet_denied", metadata: { wallet: body.wallet } },
        )
      }
    } catch (e) {
      api.log("warn", "signals.reply.deny_check_failed", { error: e instanceof Error ? e.message : String(e) })
    }
  }

  // phase-116: validate attribution if provided (optional, additive)
  let attributionParsed: z.infer<typeof ContributorsArraySchema> | undefined
  if (isPhase116Enabled() && (body.attribution != null || body.contributors != null)) {
    const rawContribs = (body.attribution ?? body.contributors) as unknown
    // allow either { contributors: [...] } or direct array
    const arr = Array.isArray(rawContribs)
      ? rawContribs
      : rawContribs != null && typeof rawContribs === "object" && Array.isArray((rawContribs as { contributors?: unknown }).contributors)
        ? (rawContribs as { contributors: unknown[] }).contributors
        : rawContribs
    const parsedAttrib = ContributorsArraySchema.safeParse(arr)
    if (!parsedAttrib.success) {
      return api.json(
        { error: "Invalid attribution", details: parsedAttrib.error.flatten(), code: "VALIDATION_FAILED" },
        { status: 400, event: "signals.reply.attribution_invalid" },
      )
    }
    attributionParsed = parsedAttrib.data
    // share overflow pre-check (sum <= 10000)
    if (attributionParsed && attributionParsed.length > 0) {
      const sum = attributionParsed.reduce((s, c) => s + (c.shareBps ?? 0), 0)
      if (sum > 10_000) {
        return api.json({ error: `Attribution share overflow: ${sum} > 10000 bps`, code: "SHARE_OVERFLOW" }, { status: 400, event: "signals.reply.attribution_overflow" })
      }
      // also validate no duplicate wallets in this request
      const seen = new Set<string>()
      for (const c of attributionParsed) {
        if (seen.has(c.wallet)) {
          return api.json({ error: `Duplicate contributor ${c.wallet.slice(0, 6)}…`, code: "DUPLICATE" }, { status: 400, event: "signals.reply.attribution_duplicate" })
        }
        seen.add(c.wallet)
      }
    }
  }

  try {
    const signal = await getSignal(id)
    if (!signal) {
      return api.json({ error: "Signal not found" }, { status: 404, event: "signals.reply.signal_missing", metadata: { signal_id: id } })
    }

    const res = await fetch(
      `${request.nextUrl.origin}/api/artist-profile?walletAddress=${encodeURIComponent(walletStr)}`,
      { headers: { "x-correlation-id": api.correlationId } },
    ).catch((error) => {
      api.log("warn", "signals.reply.profile_lookup_failed", { error })
      return null
    })
    let author_display = `${walletStr.slice(0, 4)}...${walletStr.slice(-4)}`
    if (res?.ok) {
      const data = (await res.json().catch(() => ({}))) as { alias?: string | null }
      if (typeof data.alias === "string" && data.alias.trim().length > 0) {
        author_display = data.alias.trim()
      }
    }

    const reply = await createReply({
      signal_id: id,
      author_wallet: walletStr,
      author_display,
      body: (body.body as string).trim(),
      upvotes: [],
      signature: body.signature as string,
      signature_verified: signatureVerified,
    })

    // phase-116: record contributor attribution (flag-gated, best-effort)
    let creditLedger: Awaited<ReturnType<typeof computeCreditLedger>> | null = null
    let contributors: Awaited<ReturnType<typeof getSignalContributors>> | null = null
    if (isPhase116Enabled() && attributionParsed && attributionParsed.length > 0) {
      try {
        await recordReplyAttribution(id, walletStr, { contributors: attributionParsed })
      } catch (e) {
        api.log("warn", "signals.reply.attribution_failed", { error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (isPhase116Enabled()) {
      try {
        contributors = await getSignalContributors(id)
        creditLedger = await computeCreditLedger(id)
      } catch {
        // non-blocking
      }
    }

    if (signal.author_wallet !== walletStr) {
      void createNotification(signal.author_wallet, "signal_reply", {
        reply_author_wallet: walletStr,
        reply_author_name: author_display,
        signal_id: id,
        signal_title: signal.title,
      })
        .then(() => {
          if (isPhase92Enabled()) {
            void dispatchPushNotification(signal.author_wallet, "signal_reply", {
              reply_author_name: author_display,
              signal_id: id,
              signal_title: signal.title,
            }).catch((error) => api.log("warn", "signals.reply.push_dispatch_failed", { error }))
          }
        })
        .catch((error) => api.log("warn", "signals.reply.notification_failed", { error }))
    }

    // phase-92: push notifications for @-mentions in the reply body (flag-gated, best-effort)
    if (isPhase92Enabled()) {
      const mentioned = extractMentionedWallets(body.body as string).filter((w) => w !== walletStr)
      for (const mentionedWallet of mentioned) {
        void createNotification(mentionedWallet, "mention", {
          reply_author_wallet: walletStr,
          reply_author_name: author_display,
          signal_id: id,
          signal_title: signal.title,
          mention: true,
        })
          .then(() =>
            dispatchPushNotification(mentionedWallet, "mention", {
              reply_author_name: author_display,
              signal_id: id,
              signal_title: signal.title,
            }),
          )
          .catch((error) => api.log("warn", "signals.reply.mention_notification_failed", { error }))
      }
    }

    const resolvedImage = resolveSignalImage(signal.nft_image)

    return api.json(
      {
        reply,
        ...(isPhase116Enabled() ? { contributors: contributors?.contributors ?? [], creditLedger: creditLedger ?? [] } : {}),
        ...(resolvedImage ? { signalMedia: resolvedImage } : {}),
      },
      {
        status: 201,
        event: "signals.reply.created",
        metadata: { signal_id: id, reply_id: reply.id, phase116: isPhase116Enabled(), phase136: isPhase136Enabled(), attribCount: attributionParsed?.length ?? 0 },
        headers: {
          ...(isPhase116Enabled() ? { "X-Phase116": "enabled" } : {}),
          ...(resolvedImage ? { "X-Phase136-Gateway": resolvedImage.gateway } : {}),
        },
      },
    )
  } catch (error) {
    return api.errorJson(error, 500, "signals.reply.create_failed")
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const api = createApiRequestContext(request, "/api/signals/[id]/replies")
  const { id } = await params
  if (!isPhase116Enabled()) {
    return api.json({ error: "Contributor ledger disabled (phase-116 flag off)" }, { status: 404, event: "signals.ledger.disabled" })
  }
  try {
    const { getSignal } = await import("@/lib/signal-store")
    const signal = await getSignal(id)
    if (!signal) return api.json({ error: "Signal not found" }, { status: 404, event: "signals.ledger.signal_missing" })
    const contributors = await getSignalContributors(id)
    const creditLedger = await computeCreditLedger(id)
    const resolvedImage = resolveSignalImage(signal.nft_image)
    return api.json(
      {
        signalId: id,
        contributors: contributors?.contributors ?? [],
        totalShareBps: contributors?.totalShareBps ?? 0,
        creditLedger,
        ...(resolvedImage ? { signalMedia: resolvedImage } : {}),
      },
      { event: "signals.ledger.loaded", metadata: { signal_id: id, phase136: isPhase136Enabled() } },
    )
  } catch (error) {
    return api.errorJson(error, 500, "signals.ledger.load_failed")
  }
}