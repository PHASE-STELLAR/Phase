"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useWallet } from "@/components/wallet-provider"
import { useLang } from "@/components/lang-context"
import { SignalCompose } from "@/components/signal-compose"
import { SocialChips } from "@/components/profile-panel"
import { WalletAvatar } from "@/components/wallet-avatar"
import type { Signal } from "@/lib/signal-store"

type ChannelStat = { id: string; label: string; count: number }

const copy = {
  en: {
    title: "◈ SIGNAL_BOARD",
    subtitle: "Community feed for PHASE protocol operators.",
    channels: "CHANNELS",
    all: "All signals",
    showcase: "NFT showcase",
    general: "General",
    worlds: "WORLDS",
    hot: "[ HOT ]",
    top: "[ TOP ]",
    new: "[ NEW ]",
    newPost: "[ NEW_SIGNAL ]",
    loadMore: "[ LOAD_MORE ]",
    loading: "[ LOADING… ]",
    noSignals: "[ NO_SIGNALS ]",
    replies: "replies",
    upvotes: "upvotes",
    walletBadge: "✓ WALLET",
    verifiedBadge: "✓ VERIFIED",
    onChain: "✓ ON-CHAIN",
    unverified: "UNVERIFIED",
    collector: "✓ COLLECTOR",
    share: "↗ share",
    expandMore: "[ more ]",
    expandLess: "[ less ]",
    pollClosed: "POLL CLOSED",
    scheduled: "SCHEDULED_QUEUE",
    cancel: "[ CANCEL ]",
  },
  es: {
    title: "◈ TABLERO_DE_SEÑALES",
    subtitle: "Feed comunitario para operadores del protocolo PHASE.",
    channels: "CANALES",
    all: "Todas las señales",
    showcase: "Vitrina NFT",
    general: "General",
    worlds: "MUNDOS",
    hot: "[ EVOS ]",
    top: "[ TOP ]",
    new: "[ NUEVA_SEÑAL ]",
    newPost: "[ NUEVA_SEÑAL ]",
    loadMore: "[ CARGAR_MÁS ]",
    loading: "[ CARGANDO… ]",
    noSignals: "[ SIN_SEÑALES ]",
    replies: "respuestas",
    upvotes: "votos",
    walletBadge: "✓ WALLET",
    verifiedBadge: "✓ VERIFICADO",
    onChain: "✓ ON-CHAIN",
    unverified: "NO_VERIFICADO",
    collector: "✓ COLECCIONISTA",
    share: "↗ compartir",
    expandMore: "[ más ]",
    expandLess: "[ menos ]",
    pollClosed: "ENCUESTA CERRADA",
    scheduled: "COLA_PROGRAMADA",
    cancel: "[ CANCELAR ]",
  },
}

function timeAgo(ts: number, lang: string): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (lang === "es") {
    if (d > 0) return `${d}d`
    if (h > 0) return `${h}h`
    return `${m}m`
  }
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  return `${m}m ago`
}

function channelTag(channel: string, channels: ChannelStat[]): string {
  if (channel === "showcase") return "NFT"
  if (channel === "general") return "GENERAL"
  const w = channels.find((c) => c.id === channel)
  return w ? `WORLD: ${w.label.toUpperCase()}` : channel.toUpperCase()
}

type AuthorProfile = {
  twitter?: string
  discord?: string
  telegram?: string
  isCollector: boolean
}

function useAuthorProfile(wallet: string): AuthorProfile {
  const [data, setData] = useState<AuthorProfile>({ isCollector: false })
  useEffect(() => {
    const abortCtrl = new AbortController()
    Promise.allSettled([
      fetch(`/api/profile?wallet=${encodeURIComponent(wallet)}`, { signal: abortCtrl.signal })
        .then((r) => r.json() as Promise<{ profile?: { twitter?: string; discord?: string; telegram?: string } | null }>),
      fetch(`/api/wallet/phase-nfts?address=${encodeURIComponent(wallet)}`, { signal: abortCtrl.signal })
        .then((r) => r.json() as Promise<{ items?: unknown[] }>),
    ]).then(([profileRes, nftRes]) => {
      const profile = profileRes.status === "fulfilled" ? profileRes.value.profile : null
      const nfts = nftRes.status === "fulfilled" ? (nftRes.value.items ?? []) : []
      setData({
        twitter: profile?.twitter,
        discord: profile?.discord,
        telegram: profile?.telegram,
        isCollector: nfts.length > 0,
      })
    }).catch(() => {})
    return () => abortCtrl.abort()
  }, [wallet])
  return data
}

function useNftVerified(wallet: string, tokenId: number | undefined): "pending" | "verified" | "unverified" {
  const [state, setState] = useState<"pending" | "verified" | "unverified">("pending")
  useEffect(() => {
    if (tokenId === undefined) return
    const abortCtrl = new AbortController()
    fetch(`/api/phase-nft/verify?wallet=${encodeURIComponent(wallet)}&tokenId=${tokenId}`, { signal: abortCtrl.signal })
      .then((r) => r.json() as Promise<{ verified?: boolean }>)
      .then((data) => setState(data.verified ? "verified" : "unverified"))
      .catch(() => setState("unverified"))
    return () => abortCtrl.abort()
  }, [wallet, tokenId])
  return state
}

function PostCard({
  signal,
  channels,
  lang,
  t,
  onUpvote,
  onPollVote,
  viewerWallet,
}: {
  signal: Signal
  channels: ChannelStat[]
  lang: string
  t: typeof copy.en
  onUpvote: (id: string) => void
  onPollVote: (signalId: string, optionId: string) => void
  viewerWallet: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const router = useRouter()
  const shortWallet = `${signal.author_wallet.slice(0, 4)}…${signal.author_wallet.slice(-4)}`
  const isLong = signal.body.length > 180
  const authorProfile = useAuthorProfile(signal.author_wallet)
  const nftVerified = useNftVerified(signal.author_wallet, signal.nft_token_id)
  const totalPollVotes = signal.poll?.options.reduce((total, option) => total + option.voters.length, 0) ?? 0
  const pollClosed = Boolean(signal.poll?.closes_at && signal.poll.closes_at <= Date.now())

  return (
    <div
      role="article"
      onClick={() => router.push(`/signals/${signal.id}`)}
      className="block border border-[var(--color-border-tertiary)] hover:border-[var(--color-border-primary)] transition-colors cursor-pointer"
      style={{
        background: "var(--color-background-primary)",
        ...(signal.channel !== "general" && signal.channel !== "showcase"
          ? { borderLeft: "2px solid #7F77DD" }
          : {}),
      }}
    >
      <div className="p-4 flex flex-col gap-2.5">
        {/* Header */}
        <div className="flex items-center gap-2 flex-wrap">
          <WalletAvatar
            wallet={signal.author_wallet}
            displayName={signal.author_display}
            size={28}
          />
          {/* Author name → public profile */}
          <Link
            href={`/profile/${signal.author_wallet}`}
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[11px] text-foreground font-medium hover:text-[#7F77DD] transition-colors"
          >
            {signal.author_display}
          </Link>
          <span
            className="font-mono text-[9px] px-1.5 py-0.5"
            style={
              signal.signature_verified
                ? { background: "#E1F5EE", color: "#0F6E56" }
                : { background: "#EEEDFE", color: "#534AB7" }
            }
          >
            {signal.signature_verified ? t.verifiedBadge : t.walletBadge}
          </span>
          {authorProfile.isCollector && (
            <span
              className="font-mono text-[8px] px-1.5 py-0.5"
              style={{ background: "#E1F5EE", color: "#0F6E56" }}
            >
              {t.collector}
            </span>
          )}
          <span className="font-mono text-[9px] text-muted-foreground/60 border border-[var(--color-border-tertiary)] px-1.5 py-0.5 uppercase tracking-widest">
            {channelTag(signal.channel, channels)}
          </span>
          <span className="ml-auto font-mono text-[9px] text-muted-foreground/50">
            {timeAgo(signal.created_at, lang)}
          </span>
        </div>

        {/* Social chips */}
        {(authorProfile.twitter || authorProfile.discord || authorProfile.telegram) && (
          <div onClick={(e) => e.preventDefault()}>
            <SocialChips profile={authorProfile} />
          </div>
        )}

        {/* Title */}
        <p className="font-mono text-[13px] font-medium text-foreground leading-snug">
          {signal.title}
        </p>

        {/* NFT card */}
        {signal.nft_token_id !== undefined && (
          <div
            className="flex items-center gap-3 border border-[var(--color-border-tertiary)] p-2"
            onClick={(e) => e.preventDefault()}
          >
            {signal.nft_image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={signal.nft_image} alt={signal.nft_name} className="h-8 w-8 object-cover" />
            )}
            <span className="font-mono text-[10px] text-foreground/80">{signal.nft_name}</span>
            {nftVerified === "pending" ? (
              <span className="ml-auto font-mono text-[8px] text-muted-foreground/40">···</span>
            ) : nftVerified === "verified" ? (
              <span
                className="ml-auto font-mono text-[8px] tracking-widest px-1.5 py-0.5"
                style={{ background: "#E1F5EE", color: "#0F6E56" }}
              >
                {t.onChain}
              </span>
            ) : (
              <span
                className="ml-auto font-mono text-[8px] tracking-widest px-1.5 py-0.5 border border-[var(--color-border-tertiary)] text-muted-foreground/50"
              >
                {t.unverified}
              </span>
            )}
          </div>
        )}

        {/* Body */}
        <div className="font-mono text-[11px] text-muted-foreground leading-relaxed">
          {isLong && !expanded ? (
            <>
              {signal.body.slice(0, 180)}…{" "}
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); setExpanded(true) }}
                className="text-[#7F77DD] hover:underline"
              >
                {t.expandMore}
              </button>
            </>
          ) : (
            <>
              {signal.body}
              {isLong && (
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); setExpanded(false) }}
                  className="ml-1 text-[#7F77DD] hover:underline"
                >
                  {t.expandLess}
                </button>
              )}
            </>
          )}
        </div>

        {signal.type === "poll" && signal.poll && (
          <fieldset className="flex flex-col gap-1.5" onClick={(event) => event.stopPropagation()}>
            <legend className="sr-only">{signal.title}</legend>
            {signal.poll.options.map((option) => {
              const selected = Boolean(viewerWallet && option.voters.includes(viewerWallet))
              const percent = totalPollVotes === 0 ? 0 : Math.round((option.voters.length / totalPollVotes) * 100)
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={!viewerWallet || pollClosed}
                  aria-pressed={selected}
                  onClick={() => onPollVote(signal.id, option.id)}
                  className={`relative overflow-hidden border px-3 py-2 text-left font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#7F77DD] disabled:cursor-not-allowed ${selected ? "border-[#7F77DD] text-violet-200" : "border-[var(--color-border-tertiary)] text-muted-foreground hover:border-[#7F77DD]/60"}`}
                >
                  <span className="absolute inset-y-0 left-0 bg-[#534AB7]/10" style={{ width: `${percent}%` }} aria-hidden="true" />
                  <span className="relative flex justify-between gap-3">
                    <span>{option.text}</span>
                    <span>{percent}%</span>
                  </span>
                </button>
              )
            })}
            <span className="font-mono text-[8px] text-muted-foreground/60">
              {totalPollVotes} votes{pollClosed ? ` · ${t.pollClosed}` : ""}
            </span>
          </fieldset>
        )}

        {/* Footer */}
        <div className="flex items-center gap-4 pt-1">
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); onUpvote(signal.id) }}
            className="font-mono text-[10px] text-muted-foreground hover:text-[#7F77DD] transition-colors"
          >
            ▲ {signal.upvotes.length} {t.upvotes}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              void navigator.clipboard.writeText(`${window.location.origin}/signals/${signal.id}`)
            }}
            className="font-mono text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {t.share}
          </button>
          <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">{shortWallet}</span>
        </div>
      </div>
    </div>
  )
}

export default function SignalsPage() {
  const { address } = useWallet()
  const { lang } = useLang()
  const t = copy[lang] ?? copy.en

  const [activeChannel, setActiveChannel] = useState("all")
  const [sort, setSort] = useState<"hot" | "new" | "top">("hot")
  const [channels, setChannels] = useState<ChannelStat[]>([])
  const [signals, setSignals] = useState<Signal[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [composeOpen, setComposeOpen] = useState(false)
  const [scheduledSignals, setScheduledSignals] = useState<Signal[]>([])
  const schedulingEnabled = ["1", "true", "yes", "on"].includes(
    (process.env.NEXT_PUBLIC_FEATURE_PHASE_89 ?? "").trim().toLowerCase(),
  )

  const PAGE = 20

  const fetchSignals = useCallback(
    async (ch: string, s: "hot" | "new" | "top", offset = 0, append = false) => {
      setLoading(true)
      try {
        const params = new URLSearchParams({
          sort: s,
          limit: String(PAGE),
          offset: String(offset),
        })
        if (ch !== "all") params.set("channel", ch)
        const res = await fetch(`/api/signals?${params.toString()}`)
        const data = (await res.json()) as {
          signals: Signal[]
          total: number
          channels: ChannelStat[]
        }
        if (append) {
          setSignals((prev) => [...prev, ...data.signals])
        } else {
          setSignals(data.signals)
        }
        setTotal(data.total)
        setChannels(data.channels)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void fetchSignals(activeChannel, sort)
  }, [activeChannel, sort, fetchSignals])

  useEffect(() => {
    if (!schedulingEnabled || !address) {
      setScheduledSignals([])
      return
    }
    const controller = new AbortController()
    fetch(`/api/signals/scheduled?wallet=${encodeURIComponent(address)}`, {
      signal: controller.signal,
      headers: { "x-wallet-signature": address },
    })
      .then((response) => response.ok ? response.json() as Promise<{ signals?: Signal[] }> : { signals: [] })
      .then((data) => setScheduledSignals(data.signals ?? []))
      .catch(() => {})
    return () => controller.abort()
  }, [address, schedulingEnabled])

  function handleChannelChange(id: string) {
    setActiveChannel(id)
    setSort("hot")
  }

  function handleSortChange(s: "hot" | "new" | "top") {
    setSort(s)
  }

  function handleLoadMore() {
    void fetchSignals(activeChannel, sort, signals.length, true)
  }

  function handleUpvote(id: string) {
    if (!address) return
    void fetch(`/api/signals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: address, signature: address }),
    })
      .then((r) => r.json())
      .then((data: { signal?: Signal }) => {
        if (data.signal) {
          setSignals((prev) => prev.map((s) => (s.id === id ? data.signal! : s)))
        }
      })
      .catch(() => {})
  }

  function handlePollVote(signalId: string, optionId: string) {
    if (!address) return
    void fetch(`/api/signals/${signalId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option_id: optionId, wallet: address, signature: address }),
    })
      .then((response) => response.json())
      .then((data: { signal?: Signal }) => {
        if (data.signal) setSignals((current) => current.map((signal) => signal.id === signalId ? data.signal! : signal))
      })
      .catch(() => {})
  }

  function handleCancelScheduled(id: string) {
    if (!address) return
    void fetch("/api/signals/scheduled", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, wallet: address, signature: address }),
    })
      .then((response) => {
        if (response.ok) setScheduledSignals((current) => current.filter((signal) => signal.id !== id))
      })
      .catch(() => {})
  }

  const worldChannels = channels.filter(
    (c) => c.id !== "all" && c.id !== "general" && c.id !== "showcase",
  )

  const labelClass =
    "font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60 px-3 py-1.5"
  const channelItemClass = (active: boolean) =>
    `flex items-center justify-between px-3 py-1.5 cursor-pointer font-mono text-[11px] transition-colors ${
      active
        ? "text-[#7F77DD] border-l-2 border-[#7F77DD] bg-[#534AB7]/5"
        : "text-muted-foreground hover:text-foreground border-l-2 border-transparent"
    }`

  const tabClass = (active: boolean) =>
    `font-mono text-[10px] uppercase tracking-widest px-4 py-2 transition-colors cursor-pointer border-b-2 ${
      active
        ? "border-[#7F77DD] text-[#7F77DD]"
        : "border-transparent text-muted-foreground hover:text-foreground"
    }`

  return (
    <div className="min-h-screen" style={{ fontFamily: "var(--font-mono)" }}>
      <div className="mx-auto max-w-5xl px-4 py-16">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="font-mono text-[13px] uppercase tracking-[0.2em] text-[#7F77DD]">
            {t.title}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{t.subtitle}</p>
        </div>

        <div className="flex gap-6">
          {/* Sidebar */}
          <aside className="hidden w-[200px] shrink-0 flex-col gap-1 md:flex">
            <div className={labelClass}>{t.channels}</div>
            {channels
              .filter((c) => c.id === "all" || c.id === "general" || c.id === "showcase")
              .map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleChannelChange(c.id)}
                  className={channelItemClass(activeChannel === c.id)}
                >
                  <span>
                    {c.id === "all" ? t.all : c.id === "showcase" ? t.showcase : t.general}
                  </span>
                  <span className="font-mono text-[9px] text-muted-foreground/40">{c.count}</span>
                </button>
              ))}

            {worldChannels.length > 0 && (
              <>
                <div className="my-1 border-t border-[var(--color-border-tertiary)]" />
                <div className={labelClass}>{t.worlds}</div>
                {worldChannels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleChannelChange(c.id)}
                    className={channelItemClass(activeChannel === c.id)}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: "#7F77DD" }}
                      />
                      <span className="truncate">{c.label}</span>
                    </span>
                    <span className="font-mono text-[9px] text-muted-foreground/40">{c.count}</span>
                  </button>
                ))}
              </>
            )}
          </aside>

          {/* Main feed */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center border-b border-[var(--color-border-tertiary)]">
                {(["hot", "new", "top"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleSortChange(s)}
                    className={tabClass(sort === s)}
                  >
                    {s === "hot" ? t.hot : s === "new" ? t.new : t.top}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setComposeOpen(true)}
                className="border border-[#534AB7] bg-[#534AB7]/10 px-4 py-1.5 font-mono text-[10px] uppercase tracking-widest text-[#7F77DD] hover:bg-[#534AB7]/20 transition-colors"
              >
                {t.newPost}
              </button>
            </div>

            {scheduledSignals.length > 0 && (
              <section aria-labelledby="scheduled-queue-title" className="border-y border-[var(--color-border-tertiary)]">
                <h2 id="scheduled-queue-title" className="px-3 py-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">
                  {t.scheduled} ({scheduledSignals.length})
                </h2>
                <div className="divide-y divide-[var(--color-border-tertiary)]">
                  {scheduledSignals.map((signal) => (
                    <div key={signal.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/80">{signal.title}</span>
                      <time className="shrink-0 font-mono text-[8px] text-muted-foreground" dateTime={new Date(signal.scheduled_for ?? 0).toISOString()}>
                        {new Date(signal.scheduled_for ?? 0).toLocaleString()}
                      </time>
                      <button
                        type="button"
                        onClick={() => handleCancelScheduled(signal.id)}
                        className="shrink-0 font-mono text-[8px] text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#7F77DD]"
                      >
                        {t.cancel}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Feed */}
            {loading && signals.length === 0 ? (
              <div className="py-8 text-center font-mono text-[11px] text-muted-foreground">
                {t.loading}
              </div>
            ) : signals.length === 0 ? (
              <div className="py-8 text-center font-mono text-[11px] text-muted-foreground">
                {t.noSignals}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {signals.map((s) => (
                  <PostCard
                    key={s.id}
                    signal={s}
                    channels={channels}
                    lang={lang}
                    t={t}
                    onUpvote={handleUpvote}
                    onPollVote={handlePollVote}
                    viewerWallet={address}
                  />
                ))}
                {signals.length < total && (
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={loading}
                    className="mt-2 w-full border border-[var(--color-border-tertiary)] py-2.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:border-[var(--color-border-primary)] hover:text-foreground transition-colors disabled:opacity-40"
                  >
                    {t.loadMore}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <SignalCompose
        open={composeOpen}
        onOpenChange={setComposeOpen}
        channels={channels}
        onCreated={(signal) => {
          if (signal.status !== "scheduled") {
            setSignals((prev) => [signal, ...prev])
            setTotal((n) => n + 1)
          } else {
            setScheduledSignals((current) => [...current, signal].sort((a, b) => (a.scheduled_for ?? 0) - (b.scheduled_for ?? 0)))
          }
        }}
      />
    </div>
  )
}
