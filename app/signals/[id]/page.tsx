import { notFound } from "next/navigation"
import Link from "next/link"
import { WalletAvatar } from "@/components/wallet-avatar"
import { getSignal, getReplies, getSignalContributors, computeCreditLedger, isPhase116Enabled, isPhase136Enabled, resolveCidGateway, extractIpfsCidPath } from "@/lib/signal-store"
import { SignalDetailClient } from "./signal-detail-client"

export const dynamic = "force-dynamic"

type Props = {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  const signal = await getSignal(id)
  if (!signal) return { title: "Signal not found — PHASE" }
  return {
    title: `${signal.title} — PHASE SIGNAL_BOARD`,
    description: signal.body.slice(0, 160),
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  return `${m}m ago`
}

export default async function SignalDetailPage({ params }: Props) {
  const { id } = await params
  const signal = await getSignal(id)
  if (!signal) notFound()

  const replies = await getReplies(id)
  const shortWallet = `${signal.author_wallet.slice(0, 4)}…${signal.author_wallet.slice(-4)}`

  // phase-136: resolve the signal's NFT image CID through the cached gateway picker
  let nftImageSrc = signal.nft_image
  const nftCidPath = extractIpfsCidPath(signal.nft_image)
  if (isPhase136Enabled() && nftCidPath) {
    try {
      nftImageSrc = resolveCidGateway(nftCidPath).url
    } catch {
      // fall back to the stored URL (zero regression)
    }
  }

  // phase-116: load contributor ledger when flag enabled (preserves signal detail wiring)
  const phase116 = isPhase116Enabled()
  let contributors: Awaited<ReturnType<typeof getSignalContributors>> = null
  let creditLedger: Awaited<ReturnType<typeof computeCreditLedger>> = []
  if (phase116) {
    try {
      contributors = await getSignalContributors(id)
      creditLedger = await computeCreditLedger(id)
    } catch {
      // best-effort
    }
  }

  // phase-156 (Module #56): flag whether this signal's author is on the governed
  // deny-list, so the detail view can show it. Best-effort; false when flag off.
  let authorRestricted = false
  if (isFaucetDenyListEnabled()) {
    try {
      authorRestricted = await isWalletDenied(signal.author_wallet)
    } catch {
      // best-effort
    }
  }

  return (
    <div className="min-h-screen" style={{ fontFamily: "var(--font-mono)" }}>
      <div className="mx-auto max-w-2xl px-4 py-16">
        {/* Back */}
        <Link
          href="/signals"
          className="mb-6 inline-block font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
        >
          ← SIGNAL_BOARD
        </Link>

        {/* Signal */}
        <article
          className="border border-[var(--color-border-tertiary)] p-5 flex flex-col gap-3"
          style={{
            background: "var(--color-background-primary)",
            ...(signal.channel !== "general" && signal.channel !== "showcase"
              ? { borderLeft: "2px solid #7F77DD" }
              : {}),
          }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <WalletAvatar
              wallet={signal.author_wallet}
              displayName={signal.author_display}
              size={28}
            />
            <span className="font-mono text-[11px] font-medium text-foreground">
              {signal.author_display}
            </span>
            <span
              className="font-mono text-[9px] px-1.5 py-0.5"
              style={
                signal.signature_verified
                  ? { background: "#E1F5EE", color: "#0F6E56" }
                  : { background: "#EEEDFE", color: "#534AB7" }
              }
            >
              {signal.signature_verified ? "✓ VERIFIED" : "✓ WALLET"}
            </span>
            <span className="font-mono text-[9px] text-muted-foreground/40 border border-[var(--color-border-tertiary)] px-1.5 py-0.5 uppercase tracking-widest">
              {signal.channel.toUpperCase()}
            </span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground/50">
              {timeAgo(signal.created_at)}
            </span>
          </div>

          <h1 className="font-mono text-[15px] font-semibold text-foreground leading-snug">
            {signal.title}
          </h1>

          {authorRestricted && (
            <p className="font-mono text-[9px] uppercase tracking-widest text-amber-600 border border-amber-600/40 px-1.5 py-0.5 self-start">
              ⚠ AUTHOR ON DENY-LIST
            </p>
          )}

          {signal.nft_token_id !== undefined && (
            <div className="flex items-center gap-3 border border-[var(--color-border-tertiary)] p-2">
              {nftImageSrc && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={nftImageSrc} alt={signal.nft_name} className="h-10 w-10 object-cover" />
              )}
              <div className="flex flex-col">
                <span className="font-mono text-[10px] text-foreground/80">{signal.nft_name}</span>
                {signal.nft_collection_id !== undefined && (
                  <span className="font-mono text-[9px] text-muted-foreground/50">
                    Collection #{signal.nft_collection_id}
                  </span>
                )}
              </div>
              <span
                className="ml-auto font-mono text-[8px] tracking-widest px-1.5 py-0.5"
                style={{ background: "#E1F5EE", color: "#0F6E56" }}
              >
                ✓ ON-CHAIN
              </span>
            </div>
          )}

          <p className="font-mono text-[12px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
            {signal.body}
          </p>

          <div className="flex items-center gap-4 pt-1 border-t border-[var(--color-border-tertiary)]">
            <span className="font-mono text-[10px] text-muted-foreground">
              ▲ {signal.upvotes.length} upvotes
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {replies.length} replies
            </span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">
              {shortWallet}
            </span>
          </div>

          {/* phase-116: contributor attribution & credit ledger (flag-gated) */}
          {phase116 && contributors && contributors.contributors.length > 0 ? (
            <div className="mt-3 border border-violet-200/50 bg-violet-50/50 p-3">
              <p className="font-mono text-[9px] uppercase tracking-widest text-violet-700">CONTRIBUTORS & CREDIT LEDGER</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {creditLedger.map((c) => (
                  <div key={c.wallet} className="flex items-center gap-2 font-mono text-[10px]">
                    <WalletAvatar wallet={c.wallet} displayName={c.displayName} size={20} />
                    <span className="font-medium text-foreground">{c.displayName}</span>
                    <span className="text-muted-foreground/60">{c.wallet.slice(0, 4)}…{c.wallet.slice(-4)}</span>
                    <span className="ml-auto text-violet-700">{(c.totalShareBps / 100).toFixed(1)}%</span>
                    <span className="rounded bg-violet-100 px-1 py-0.5 text-[8px] uppercase tracking-widest text-violet-700">{c.roles.join(", ")}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 font-mono text-[9px] text-muted-foreground/50">Total share: {contributors.totalShareBps / 100}% · {contributors.contributors.length} attribution(s)</p>
            </div>
          ) : phase116 ? (
            <div className="mt-3 border border-dashed border-[var(--color-border-tertiary)] p-2">
              <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">No co-authors yet — reply with attribution to add credit</p>
            </div>
          ) : null}
        </article>

        {/* Replies + compose (client island) */}
        <SignalDetailClient signalId={id} initialReplies={replies} />
      </div>
    </div>
  )
}
