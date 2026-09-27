import { notFound } from "next/navigation"
import Link from "next/link"
import { WalletAvatar } from "@/components/wallet-avatar"
import { getSignal, getReplies } from "@/lib/signal-store"
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
              style={{ background: "#EEEDFE", color: "#534AB7" }}
            >
              ✓ WALLET
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

          {signal.nft_token_id !== undefined && (
            <div className="flex items-center gap-3 border border-[var(--color-border-tertiary)] p-2">
              {signal.nft_image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={signal.nft_image} alt={signal.nft_name} className="h-10 w-10 object-cover" />
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
        </article>

        {/* Replies + compose (client island) */}
        <SignalDetailClient
          signalId={id}
          initialSignalVersion={signal.version}
          initialReplies={replies}
        />
      </div>
    </div>
  )
}
