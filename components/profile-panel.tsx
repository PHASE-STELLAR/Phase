"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useLang } from "@/components/lang-context"
import { WalletAvatar } from "./wallet-avatar"

// Social icons (inline SVG)
function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.963 19.963 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.062 3.345-.48.33-.913.49-1.303.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.015 3.333-1.386 4.025-1.627 4.477-1.635z" />
    </svg>
  )
}

export type ProfileSocials = {
  display_name?: string
  twitter?: string
  discord?: string
  telegram?: string
}

type ProfileData = ProfileSocials & {
  avatar_token_id?: number
}

function SocialChip({
  bg,
  label,
  href,
  onCopy,
}: {
  bg: string
  label: string
  href?: string
  onCopy?: () => void
}) {
  const chip = (
    <span
      className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-[2px] shrink-0"
      style={{ background: bg, fontSize: "7px", color: "#fff", fontWeight: 700, lineHeight: 1 }}
    >
      {label}
    </span>
  )
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:opacity-80 transition-opacity">
        {chip}
      </a>
    )
  }
  return (
    <button type="button" onClick={onCopy} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
      {chip}
    </button>
  )
}

export function SocialChips({
  profile,
  showLabel = false,
}: {
  profile: ProfileSocials
  showLabel?: boolean
}) {
  const [discordCopied, setDiscordCopied] = useState(false)

  function copyDiscord() {
    if (!profile.discord) return
    void navigator.clipboard.writeText(profile.discord).then(() => {
      setDiscordCopied(true)
      setTimeout(() => setDiscordCopied(false), 2000)
    })
  }

  const hasSocials = profile.twitter || profile.discord || profile.telegram
  if (!hasSocials) return <span className="font-mono text-[9px] text-zinc-700">—</span>

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {profile.twitter && (
        <div className="flex items-center gap-1">
          <SocialChip
            bg="#000"
            label="𝕏"
            href={`https://twitter.com/${profile.twitter.replace(/^@/, "")}`}
          />
          {showLabel && (
            <span className="font-mono text-[9px] text-zinc-500">{profile.twitter}</span>
          )}
        </div>
      )}
      {profile.discord && (
        <div className="flex items-center gap-1">
          <SocialChip
            bg="#5865F2"
            label="DC"
            onCopy={copyDiscord}
          />
          {showLabel && (
            <span className="font-mono text-[9px] text-zinc-500">
              {discordCopied ? "[ COPIED ]" : profile.discord}
            </span>
          )}
        </div>
      )}
      {profile.telegram && (
        <div className="flex items-center gap-1">
          <SocialChip
            bg="#0088cc"
            label="TG"
            href={`https://t.me/${profile.telegram.replace(/^@/, "")}`}
          />
          {showLabel && (
            <span className="font-mono text-[9px] text-zinc-500">{profile.telegram}</span>
          )}
        </div>
      )}
    </div>
  )
}

type NftItem = {
  tokenId: number
  name: string
  image?: string
  collectionId?: number
}

type Tab = "artifacts" | "rewards" | "search" | "offers" | "achievements"

function truncateAddress(addr: string) {
  if (!addr || addr.length < 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function avatarInitials(displayName: string | undefined, address: string): string {
  if (displayName?.trim()) {
    const words = displayName.trim().split(/\s+/)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return displayName.slice(0, 2).toUpperCase()
  }
  return address.slice(1, 3).toUpperCase()
}

type SearchResult = {
  wallet: string
  display_name: string | null
  twitter: string | null
  discord: string | null
  telegram: string | null
  artifact_count: number
  has_world: boolean
  world_name: string | null
  is_following: boolean
}

type SearchFilter = "all" | "collectors" | "world_creators" | "following"

type SearchCopy = {
  searchPlaceholder: string
  searchInitial: string
  searchNoResults: string
  searchSearching: string
  viewProfile: string
  filterAll: string
  filterCollectors: string
  filterWorldCreators: string
  filterFollowing: string
  suggested: string
  totalCollectors: string
  viewAll: string
}

function SkeletonCard() {
  return (
    <div className="flex items-start gap-2 border border-zinc-800 bg-zinc-900/60 p-2 animate-pulse">
      <div className="h-9 w-9 shrink-0 rounded-full bg-zinc-800" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
        <div className="h-2 w-24 rounded bg-zinc-800" />
        <div className="h-1.5 w-16 rounded bg-zinc-800/70" />
        <div className="h-1.5 w-20 rounded bg-zinc-800/50" />
      </div>
    </div>
  )
}

function SearchResultCard({ r, t }: { r: SearchResult; t: SearchCopy }) {
  const name = r.display_name ?? `${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)}`
  return (
    <div className="flex items-start gap-2 border border-zinc-800 bg-zinc-900/60 p-2">
      <WalletAvatar wallet={r.wallet} displayName={r.display_name ?? undefined} size={36} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-[10px] font-medium text-zinc-200 truncate">{name}</span>
          <span
            className="shrink-0 font-mono text-[7px] px-1 py-0.5"
            style={{ background: "#EEEDFE", color: "#534AB7" }}
          >
            ✓ WALLET
          </span>
          {r.artifact_count > 0 && (
            <span
              className="shrink-0 font-mono text-[7px] px-1 py-0.5"
              style={{ background: "#E1F5EE", color: "#0F6E56" }}
            >
              ◈ COLLECTOR
            </span>
          )}
        </div>
        <span className="font-mono text-[8px] text-zinc-600 truncate">
          {r.wallet.slice(0, 6)}…{r.wallet.slice(-4)}
        </span>
        {r.has_world && r.world_name && (
          <span
            className="inline-flex self-start font-mono text-[7px] px-1 py-0.5 truncate max-w-full"
            style={{ background: "rgba(124,58,237,0.15)", color: "#a78bfa" }}
          >
            ◆ {r.world_name}
          </span>
        )}
        <SocialChips profile={{
          display_name: r.display_name ?? undefined,
          twitter: r.twitter ?? undefined,
          discord: r.discord ?? undefined,
          telegram: r.telegram ?? undefined,
        }} />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {r.artifact_count > 0 && (
          <span className="font-mono text-[9px] text-zinc-500">{r.artifact_count}</span>
        )}
        <a
          href={`/profile/${r.wallet}`}
          className="font-mono text-[8px] uppercase tracking-widest text-violet-500 hover:text-violet-300 transition-colors"
        >
          {t.viewProfile}
        </a>
      </div>
    </div>
  )
}

function SearchTab({ t, viewerAddress }: { t: SearchCopy; viewerAddress: string }) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<SearchFilter>("all")
  const [results, setResults] = useState<SearchResult[]>([])
  const [suggested, setSuggested] = useState<SearchResult[]>([])
  const [totalCollectors, setTotalCollectors] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  const fetchResults = useCallback(
    (q: string, f: SearchFilter) => {
      setSearching(true)
      const params = new URLSearchParams({ q, filter: f })
      if (viewerAddress) params.set("viewer", viewerAddress)
      fetch(`/api/profile/search?${params.toString()}`)
        .then((r) => r.json())
        .then((data: { results?: SearchResult[]; suggested?: SearchResult[]; totalCollectors?: number }) => {
          setResults(data.results ?? [])
          setSuggested(data.suggested ?? [])
          setTotalCollectors(data.totalCollectors ?? null)
          setSearched(true)
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    },
    [viewerAddress],
  )

  // Trigger on filter change immediately
  useEffect(() => {
    fetchResults(query, filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  // Debounce on query change
  useEffect(() => {
    const timer = setTimeout(() => fetchResults(query, filter), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const filters: { id: SearchFilter; label: string }[] = [
    { id: "all", label: t.filterAll },
    { id: "collectors", label: t.filterCollectors },
    { id: "world_creators", label: t.filterWorldCreators },
    { id: "following", label: t.filterFollowing },
  ]

  const activeStyle = {
    borderColor: "rgba(124,58,237,0.5)",
    color: "#a78bfa",
    background: "rgba(124,58,237,0.1)",
  }

  const showSuggested = !searching && !searched && suggested.length > 0
  const showResults = searched && results.length > 0
  const showEmpty = !searching && searched && results.length === 0

  return (
    <div className="flex flex-col gap-2 pt-1">
      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.searchPlaceholder}
          className="w-full border border-zinc-700 bg-zinc-900 px-2 py-1.5 pr-7 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-violet-600 transition-colors"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 text-[11px]">
          ⌕
        </span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-1">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className="border px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-widest transition-colors"
            style={
              filter === f.id
                ? activeStyle
                : { borderColor: "rgba(113,113,122,0.3)", color: "#71717a" }
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Loading skeletons */}
      {searching && (
        <div className="flex flex-col gap-2">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {/* Suggested collectors */}
      {!searching && showSuggested && (
        <>
          <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-600">{t.suggested}</p>
          <div className="flex flex-col gap-2">
            {suggested.map((r) => <SearchResultCard key={r.wallet} r={r} t={t} />)}
          </div>
        </>
      )}

      {/* Results */}
      {!searching && showResults && (
        <div className="flex flex-col gap-2">
          {results.map((r) => <SearchResultCard key={r.wallet} r={r} t={t} />)}
        </div>
      )}

      {/* Empty */}
      {showEmpty && (
        <div className="flex flex-col gap-1 py-2">
          <p className="font-mono text-[9px] text-zinc-600">{t.searchNoResults}</p>
          <p className="font-mono text-[8px] text-zinc-700">No collectors match your search</p>
        </div>
      )}

      {/* Footer */}
      {totalCollectors !== null && (
        <div className="flex items-center justify-between border-t border-zinc-800/60 pt-2 mt-1">
          <span className="font-mono text-[8px] text-zinc-700">
            {totalCollectors} {t.totalCollectors}
          </span>
          <a
            href="/profile"
            className="font-mono text-[8px] uppercase tracking-widest text-zinc-600 hover:text-violet-400 transition-colors"
          >
            {t.viewAll} ↗
          </a>
        </div>
      )}
    </div>
  )
}

type OfferItem = {
  id: string
  listing_id: string
  buyer_wallet: string
  amount_phaselq: number
  message?: string
  created_at: number
  status: "pending" | "accepted" | "rejected" | "expired"
  expires_at: number
}

type ListingItem = {
  id: string
  token_id: number
  collection_id: number
  seller_wallet: string
  price_phaselq: number
  accepts_offers: boolean
  image?: string
  name?: string
  listed_at: number
  status: "active" | "sold" | "cancelled"
}

type OffersTabCopy = {
  offersReceived: string
  offersSent: string
  noOffers: string
  accept: string
  reject: string
  offerPending: string
  offerAccepted: string
  offerRejected: string
  offerExpired: string
}

function OfferStatusBadge({ status, t }: { status: OfferItem["status"]; t: OffersTabCopy }) {
  const map: Record<OfferItem["status"], { text: string; color: string }> = {
    pending:  { text: t.offerPending,  color: "#a78bfa" },
    accepted: { text: t.offerAccepted, color: "#0F6E56" },
    rejected: { text: t.offerRejected, color: "#ef4444" },
    expired:  { text: t.offerExpired,  color: "#71717a" },
  }
  const { text, color } = map[status] ?? map.pending
  return (
    <span className="font-mono text-[7px] px-1 py-0.5" style={{ background: `${color}20`, color }}>
      {text}
    </span>
  )
}

function OffersTab({ address, t }: { address: string; t: OffersTabCopy }) {
  const [received, setReceived] = useState<{ offer: OfferItem; listing: ListingItem }[]>([])
  const [sent, setSent] = useState<{ offer: OfferItem; listing: ListingItem | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    // Fetch listings I own + offers on them; plus offers I've sent
    Promise.all([
      fetch(`/api/market?seller=${encodeURIComponent(address)}&status=active`).then((r) => r.json() as Promise<{ listings?: ListingItem[] }>),
      fetch(`/api/market/offers-by-buyer?buyer=${encodeURIComponent(address)}`).then((r) => r.json() as Promise<{ offers?: OfferItem[] }>).catch(() => ({ offers: [] })),
    ])
      .then(async ([listingsData, sentData]) => {
        if (cancelled) return
        const myListings = listingsData.listings ?? []
        // For each listing, fetch its offers
        const withOffers = await Promise.all(
          myListings.map(async (listing) => {
            try {
              const res = await fetch(`/api/market/${listing.id}/offers`)
              const data = (await res.json()) as { offers?: OfferItem[] }
              return (data.offers ?? []).map((offer) => ({ offer, listing }))
            } catch { return [] }
          }),
        )
        if (cancelled) return
        setReceived(withOffers.flat())

        // Sent offers — need listing info for each
        const sentOffers = sentData.offers ?? []
        const sentWithListings = await Promise.all(
          sentOffers.map(async (offer) => {
            try {
              const res = await fetch(`/api/market/${offer.listing_id}`)
              if (!res.ok) return { offer, listing: null }
              const data = (await res.json()) as { listing?: ListingItem }
              return { offer, listing: data.listing ?? null }
            } catch { return { offer, listing: null } }
          }),
        )
        if (cancelled) return
        setSent(sentWithListings)
      })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [address])

  async function handleAction(offerId: string, listingId: string, action: "accept" | "reject") {
    setActing(offerId)
    try {
      await fetch(`/api/market/${listingId}/offers/${offerId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, action }),
      })
      setReceived((prev) =>
        prev.map((r) =>
          r.offer.id === offerId
            ? { ...r, offer: { ...r.offer, status: action === "accept" ? "accepted" : "rejected" } }
            : r,
        ),
      )
    } catch { /* silent */ }
    finally { setActing(null) }
  }

  if (loading) {
    return <p className="font-mono text-[9px] text-zinc-600 pt-2">···</p>
  }

  return (
    <div className="flex flex-col gap-4 pt-1">
      {/* Received offers */}
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-600">{t.offersReceived}</p>
        {received.length === 0 ? (
          <p className="font-mono text-[9px] text-zinc-700">{t.noOffers}</p>
        ) : (
          received.map(({ offer, listing }) => (
            <div key={offer.id} className="flex flex-col gap-1 border border-zinc-800 bg-zinc-900/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] text-zinc-200 font-medium">
                  {offer.amount_phaselq} PHASELQ
                </span>
                <OfferStatusBadge status={offer.status} t={t} />
              </div>
              <span className="font-mono text-[8px] text-zinc-600 truncate">
                {listing.name ?? `Token #${listing.token_id}`}
              </span>
              <span className="font-mono text-[8px] text-zinc-700 truncate">
                {offer.buyer_wallet.slice(0, 6)}…{offer.buyer_wallet.slice(-4)}
              </span>
              {offer.message && (
                <span className="font-mono text-[8px] text-zinc-500 italic truncate">{offer.message}</span>
              )}
              {offer.status === "pending" && (
                <div className="flex gap-2 pt-0.5">
                  <button
                    type="button"
                    disabled={acting === offer.id}
                    onClick={() => void handleAction(offer.id, offer.listing_id, "accept")}
                    className="font-mono text-[7px] uppercase tracking-widest text-green-400 hover:text-green-300 transition-colors disabled:opacity-50"
                  >
                    {t.accept}
                  </button>
                  <button
                    type="button"
                    disabled={acting === offer.id}
                    onClick={() => void handleAction(offer.id, offer.listing_id, "reject")}
                    className="font-mono text-[7px] uppercase tracking-widest text-red-400/70 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    {t.reject}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Sent offers */}
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-600">{t.offersSent}</p>
        {sent.length === 0 ? (
          <p className="font-mono text-[9px] text-zinc-700">{t.noOffers}</p>
        ) : (
          sent.map(({ offer, listing }) => (
            <div key={offer.id} className="flex items-center justify-between gap-2 border border-zinc-800 bg-zinc-900/60 p-2">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="font-mono text-[9px] text-zinc-200">{offer.amount_phaselq} PHASELQ</span>
                <span className="font-mono text-[8px] text-zinc-600 truncate">
                  {listing?.name ?? `Token #${offer.listing_id.slice(0, 6)}`}
                </span>
              </div>
              <OfferStatusBadge status={offer.status} t={t} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

type AchievementEntry = {
  id: string
  unlocked_at: number
  tx_evidence?: string
}

type AchievementsTabCopy = {
  achievementsTitle: string
  achievementsUnlocked: string
  achievementsLocked: string
  achievementsEmpty: string
  achievementsProgress: string
  achievementsTimeline: string
}

const ALL_ACHIEVEMENT_IDS = [
  "first_mint", "collector_5", "collector_10", "first_collection",
  "world_builder", "narrator_10", "signal_pioneer", "community_voice",
  "connector_10", "daily_streak_7", "daily_streak_30", "phaselq_100",
] as const

const ACHIEVEMENT_META: Record<string, { name: string; icon: string; desc_en: string; desc_es: string }> = {
  first_mint:       { name: "First Artifact",   icon: "◈", desc_en: "Minted first artifact",        desc_es: "Primer artefacto forjado" },
  collector_5:      { name: "Collector ×5",      icon: "◈", desc_en: "5 artifacts minted",           desc_es: "5 artefactos forjados" },
  collector_10:     { name: "Collector ×10",     icon: "◈", desc_en: "10 artifacts minted",          desc_es: "10 artefactos forjados" },
  first_collection: { name: "Forge Master",      icon: "◆", desc_en: "Created a collection",         desc_es: "Creaste una colección" },
  world_builder:    { name: "World Builder",     icon: "◆", desc_en: "Created a narrative world",    desc_es: "Creaste un mundo narrativo" },
  narrator_10:      { name: "Narrator ×10",      icon: "◉", desc_en: "Generated 10 narratives",      desc_es: "10 narrativas generadas" },
  signal_pioneer:   { name: "Signal Pioneer",    icon: "◉", desc_en: "Posted first signal",          desc_es: "Primera señal publicada" },
  community_voice:  { name: "Community Voice",   icon: "◉", desc_en: "Received 25 upvotes",          desc_es: "25 votos recibidos" },
  connector_10:     { name: "Connector ×10",     icon: "◉", desc_en: "10 followers",                 desc_es: "10 seguidores" },
  daily_streak_7:   { name: "Streak ×7",         icon: "◈", desc_en: "7-day daily streak",           desc_es: "Racha de 7 días" },
  daily_streak_30:  { name: "Streak ×30",        icon: "◈", desc_en: "30-day daily streak",          desc_es: "Racha de 30 días" },
  phaselq_100:      { name: "PHASELQ ×100",      icon: "◈", desc_en: "Earned 100+ PHASELQ",          desc_es: "100+ PHASELQ ganados" },
}

type TimelineEntry = {
  id: string
  name: string
  unlocked_at: number
}

function AchievementsTab({ address, t, lang }: { address: string; t: AchievementsTabCopy; lang: string }) {
  const [unlocked, setUnlocked] = useState<AchievementEntry[]>([])
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/achievements?wallet=${encodeURIComponent(address)}`)
      .then((r) => r.json() as Promise<{ achievements?: AchievementEntry[]; timeline?: TimelineEntry[] }>)
      .then((data) => {
        if (cancelled) return
        setUnlocked(data.achievements ?? [])
        setTimeline(data.timeline ?? null)
      })
      .catch(() => { if (!cancelled) { setUnlocked([]); setTimeline(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [address])

  if (loading) return <p className="font-mono text-[9px] text-zinc-600 pt-2">···</p>

  const unlockedIds = new Set(unlocked.map((a) => a.id))
  const unlockedList = ALL_ACHIEVEMENT_IDS.filter((id) => unlockedIds.has(id))
  const lockedList   = ALL_ACHIEVEMENT_IDS.filter((id) => !unlockedIds.has(id))

  function BadgeCard({ id, lit }: { id: string; lit: boolean }) {
    const meta = ACHIEVEMENT_META[id]
    if (!meta) return null
    const desc = lang === "es" ? meta.desc_es : meta.desc_en
    return (
      <div
        className="flex items-center gap-2 border p-2 transition-colors"
        style={{
          borderColor: lit ? "rgba(124,58,237,0.4)" : "rgba(63,63,70,0.4)",
          background: lit ? "rgba(124,58,237,0.06)" : "rgba(24,24,27,0.5)",
        }}
      >
        <span
          className="shrink-0 font-mono text-[14px] leading-none"
          style={{ color: lit ? "#a78bfa" : "#3f3f46" }}
        >
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[9px] font-medium truncate" style={{ color: lit ? "#c4b5fd" : "#52525b" }}>
            {meta.name}
          </p>
          <p className="font-mono text-[8px] truncate" style={{ color: lit ? "#71717a" : "#3f3f46" }}>
            {desc}
          </p>
        </div>
        {lit && (
          <span className="shrink-0 font-mono text-[7px]" style={{ color: "#7c3aed" }}>✓</span>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      {/* Timeline (phase-114) */}
      {timeline && timeline.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-600">
            {t.achievementsTimeline}
          </p>
          <div className="flex flex-col gap-0 border-l pl-2.5" style={{ borderColor: "rgba(124,58,237,0.3)" }}>
            {timeline.map((event) => {
              const meta = ACHIEVEMENT_META[event.id]
              const date = new Date(event.unlocked_at)
              return (
                <div key={`${event.id}-${event.unlocked_at}`} className="relative py-1.5">
                  <span
                    className="absolute -left-[13px] top-2 h-1.5 w-1.5 rounded-full"
                    style={{ background: "#7c3aed" }}
                  />
                  <p className="font-mono text-[9px] font-medium" style={{ color: "#c4b5fd" }}>
                    {meta?.icon ?? "◈"} {event.name}
                  </p>
                  <p className="font-mono text-[8px]" style={{ color: "#71717a" }}>
                    {date.toLocaleDateString(lang === "es" ? "es-ES" : "en-US")}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Unlocked */}
      {unlockedList.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-600">
            {t.achievementsUnlocked} — {unlockedList.length}
          </p>
          {unlockedList.map((id) => <BadgeCard key={id} id={id} lit={true} />)}
        </div>
      )}

      {/* Locked */}
      {lockedList.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-[8px] uppercase tracking-widest text-zinc-700">
            {t.achievementsLocked}
          </p>
          {lockedList.map((id) => <BadgeCard key={id} id={id} lit={false} />)}
        </div>
      )}

      {unlockedList.length === 0 && lockedList.length === 0 && (
        <p className="font-mono text-[9px] text-zinc-700">{t.achievementsEmpty}</p>
      )}
    </div>
  )
}

type ProfilePanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  address: string
  disconnect: () => void
}

export function ProfilePanel({ open, onOpenChange, address, disconnect }: ProfilePanelProps) {
  const { lang } = useLang()
  const router = useRouter()

  const [tab, setTab] = useState<Tab>("artifacts")
  const [profile, setProfile] = useState<ProfileData>({})
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ProfileData>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState("")
  const [nfts, setNfts] = useState<NftItem[]>([])
  const [nftsLoading, setNftsLoading] = useState(false)
  const [worldsCount, setWorldsCount] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [avatarSelectorOpen, setAvatarSelectorOpen] = useState(false)
  const [savingAvatar, setSavingAvatar] = useState(false)
  const selectorRef = useRef<HTMLDivElement>(null)

  const t =
    lang === "es"
      ? {
          profile: "◈ PERFIL",
          artifacts: "ARTEFACTOS",
          rewards: "RECOMPENSAS",
          statArtifacts: "ARTEFACTOS",
          statWorlds: "MUNDOS",
          statPhaseLQ: "PHASELQ",
          statNarratives: "NARRATIVAS",
          socialLabel: "// SOCIAL_LINKS",
          displayName: "Nombre",
          twitter: "Twitter / X",
          discord: "Discord",
          telegram: "Telegram",
          edit: "[ EDITAR ]",
          save: "[ GUARDAR ]",
          cancel: "[ CANCELAR ]",
          saving: "[ GUARDANDO... ]",
          saved: "[ GUARDADO ]",
          copyAddress: "[ COPIAR ]",
          copied: "[ COPIADO ]",
          disconnect: "[ DESCONECTAR_WALLET ]",
          noArtifacts: "Sin artefactos en esta wallet.",
          loading: "···",
          quickRewards: "◈ RECOMPENSAS",
          quickSignals: "◉ SEÑALES",
          search: "BUSCAR",
          searchPlaceholder: "Nombre, @twitter, discord, wallet...",
          searchInitial: "[ INGRESAR_TÉRMINO ]",
          searchNoResults: "[ SIN_RESULTADOS ]",
          searchSearching: "[ BUSCANDO… ]",
          viewProfile: "[ VER ]",
          filterAll: "TODO",
          filterCollectors: "COLECCIONISTAS",
          filterWorldCreators: "CREADORES",
          filterFollowing: "SIGUIENDO",
          suggested: "// COLECCIONISTAS_SUGERIDOS",
          totalCollectors: "coleccionistas en PHASE",
          viewAll: "[ VER_TODOS ]",
          offers: "OFERTAS",
          offersReceived: "// OFERTAS_RECIBIDAS",
          offersSent: "// OFERTAS_ENVIADAS",
          noOffers: "[ SIN_OFERTAS ]",
          accept: "[ ACEPTAR ]",
          reject: "[ RECHAZAR ]",
          offerPending: "PENDIENTE",
          offerAccepted: "ACEPTADA",
          offerRejected: "RECHAZADA",
          offerExpired: "EXPIRADA",
          listNft: "[ LISTAR_NFT ]",
          listed: "[ LISTADO ]",
          cancelListing: "[ CANCELAR ]",
          listPrice: "Precio PHASELQ",
          listAcceptsOffers: "Acepta ofertas",
          listMinOffer: "Oferta mínima",
          listSubmit: "[ PUBLICAR ]",
          achievements: "LOGROS",
          achievementsTitle: "// LOGROS",
          achievementsUnlocked: "// DESBLOQUEADOS",
          achievementsLocked: "// BLOQUEADOS",
          achievementsEmpty: "[ SIN_LOGROS ]",
          achievementsProgress: "Progreso",
          achievementsTimeline: "// CRONOLOGÍA",
          placeholder: {
            displayName: "alias o nombre",
            twitter: "@handle",
            discord: "usuario#0000",
            telegram: "@handle",
          },
        }
      : {
          profile: "◈ PROFILE",
          artifacts: "ARTIFACTS",
          rewards: "REWARDS",
          statArtifacts: "ARTIFACTS",
          statWorlds: "WORLDS",
          statPhaseLQ: "PHASELQ",
          statNarratives: "NARRATIVES",
          socialLabel: "// SOCIAL_LINKS",
          displayName: "Display name",
          twitter: "Twitter / X",
          discord: "Discord",
          telegram: "Telegram",
          edit: "[ EDIT ]",
          save: "[ SAVE ]",
          cancel: "[ CANCEL ]",
          saving: "[ SAVING... ]",
          saved: "[ SAVED ]",
          copyAddress: "[ COPY ]",
          copied: "[ COPIED ]",
          disconnect: "[ DISCONNECT_WALLET ]",
          noArtifacts: "No artifacts in this wallet.",
          loading: "···",
          quickRewards: "◈ REWARDS",
          quickSignals: "◉ SIGNALS",
          search: "SEARCH",
          searchPlaceholder: "Name, @twitter, discord, wallet...",
          searchInitial: "[ ENTER_SEARCH_TERM ]",
          searchNoResults: "[ NO_RESULTS ]",
          searchSearching: "[ SEARCHING… ]",
          viewProfile: "[ VIEW ]",
          filterAll: "ALL",
          filterCollectors: "COLLECTORS",
          filterWorldCreators: "WORLD CREATORS",
          filterFollowing: "FOLLOWING",
          suggested: "// SUGGESTED_COLLECTORS",
          totalCollectors: "collectors in PHASE",
          viewAll: "[ VIEW_ALL ]",
          offers: "OFFERS",
          offersReceived: "// OFFERS_RECEIVED",
          offersSent: "// OFFERS_SENT",
          noOffers: "[ NO_OFFERS ]",
          accept: "[ ACCEPT ]",
          reject: "[ REJECT ]",
          offerPending: "PENDING",
          offerAccepted: "ACCEPTED",
          offerRejected: "REJECTED",
          offerExpired: "EXPIRED",
          listNft: "[ LIST_NFT ]",
          listed: "[ LISTED ]",
          cancelListing: "[ CANCEL ]",
          listPrice: "Price PHASELQ",
          listAcceptsOffers: "Accept offers",
          listMinOffer: "Min offer",
          listSubmit: "[ PUBLISH ]",
          achievements: "ACHIEVEMENTS",
          achievementsTitle: "// ACHIEVEMENTS",
          achievementsUnlocked: "// UNLOCKED",
          achievementsLocked: "// LOCKED",
          achievementsEmpty: "[ NO_ACHIEVEMENTS ]",
          achievementsProgress: "Progress",
          achievementsTimeline: "// TIMELINE",
          placeholder: {
            displayName: "alias or name",
            twitter: "@handle",
            discord: "user#0000",
            telegram: "@handle",
          },
        }

  const loadProfile = useCallback(async () => {
    if (!address) return
    try {
      const res = await fetch(`/api/profile?wallet=${encodeURIComponent(address)}`)
      if (!res.ok) return
      const json = (await res.json()) as { profile: ProfileData | null }
      if (json.profile) {
        setProfile(json.profile)
        setForm(json.profile)
      }
    } catch { /* ignore */ }
  }, [address])

  const loadNfts = useCallback(async () => {
    if (!address) return
    setNftsLoading(true)
    try {
      const res = await fetch(`/api/wallet/phase-nfts?address=${encodeURIComponent(address)}`)
      if (!res.ok) return
      const json = (await res.json()) as { items?: NftItem[] }
      setNfts(json.items ?? [])
    } catch { /* ignore */ }
    finally { setNftsLoading(false) }
  }, [address])

  const loadWorlds = useCallback(async () => {
    try {
      const res = await fetch("/api/world")
      if (!res.ok) return
      const json = (await res.json()) as { items?: unknown[] }
      setWorldsCount(json.items?.length ?? 0)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!open || !address) return
    void loadProfile()
    void loadNfts()
    void loadWorlds()
  }, [open, address, loadProfile, loadNfts, loadWorlds])

  // Close avatar selector on click outside
  useEffect(() => {
    if (!avatarSelectorOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setAvatarSelectorOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [avatarSelectorOpen])

  async function handleSave() {
    setSaving(true)
    setSaveMsg("")
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, ...form }),
      })
      if (!res.ok) throw new Error("save failed")
      setProfile(form)
      setEditing(false)
      setSaveMsg(t.saved)
      setTimeout(() => setSaveMsg(""), 2500)
    } catch {
      setSaveMsg("Error")
    } finally {
      setSaving(false)
    }
  }

  function handleDisconnect() {
    onOpenChange(false)
    setTimeout(disconnect, 150)
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: "artifacts", label: t.artifacts },
    { id: "rewards", label: t.rewards },
    { id: "offers", label: t.offers },
    { id: "achievements", label: t.achievements },
    { id: "search", label: t.search },
  ]

  const SOCIAL_FIELDS = [
    { key: "display_name" as const, label: t.displayName, ph: t.placeholder.displayName },
    { key: "twitter" as const, label: t.twitter, ph: t.placeholder.twitter },
    { key: "discord" as const, label: t.discord, ph: t.placeholder.discord },
    { key: "telegram" as const, label: t.telegram, ph: t.placeholder.telegram },
  ]

  async function handleSelectAvatar(tokenId: number | null) {
    setSavingAvatar(true)
    const selectedNft = tokenId !== null ? nfts.find((n) => n.tokenId === tokenId) : undefined
    const avatar_image_url = selectedNft?.image?.trim() || undefined
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: address,
          display_name: profile.display_name,
          twitter: profile.twitter,
          discord: profile.discord,
          telegram: profile.telegram,
          avatar_token_id: tokenId,
          avatar_image_url,
        }),
      })
      if (!res.ok) throw new Error("save failed")
      setProfile((p) => ({ ...p, avatar_token_id: tokenId ?? undefined, avatar_image_url }))
      setAvatarSelectorOpen(false)
    } catch { /* ignore */ }
    finally { setSavingAvatar(false) }
  }

  const chooseAvatarText = lang === "es" ? "◈ ELEGIR_AVATAR" : "◈ CHOOSE_AVATAR"
  const resetText = lang === "es" ? "[ RESETEAR ]" : "[ RESET ]"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[min(100vw,22rem)] flex flex-col gap-0 p-0 border-l border-violet-800/30 bg-[#0a0a0f] text-zinc-100 overflow-hidden"
      >
        <SheetTitle className="sr-only">{t.profile}</SheetTitle>

        {/* ── Header ── */}
        <div className="px-5 pt-5 pb-4 border-b border-violet-800/20 flex items-start gap-3">
          {/* Avatar - clickable */}
          <button
            type="button"
            onClick={() => setAvatarSelectorOpen(!avatarSelectorOpen)}
            disabled={nfts.length === 0}
            className="shrink-0 rounded-full border border-violet-700/40 hover:border-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <WalletAvatar
              key={profile.avatar_token_id ?? "no-avatar"}
              wallet={address}
              displayName={profile.display_name}
              size={40}
            />
          </button>

          {/* Identity */}
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-violet-400 mb-0.5">
              {t.profile}
            </p>
            {profile.display_name && (
              <p className="font-mono text-[11px] text-zinc-200 font-medium truncate mb-0.5">
                {profile.display_name}
              </p>
            )}
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] tracking-widest text-zinc-500 truncate">
                {truncateAddress(address)}
              </span>
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="shrink-0 font-mono text-[8px] uppercase tracking-widest text-zinc-700 hover:text-violet-400 transition-colors"
              >
                {copied ? t.copied : t.copyAddress}
              </button>
            </div>
          </div>
        </div>

        {/* ── Avatar Selector ── */}
        {avatarSelectorOpen && nfts.length > 0 && (
          <div
            ref={selectorRef}
            className="px-5 py-3 border-b border-violet-800/20 bg-violet-950/20"
          >
            <p className="font-mono text-[10px] text-violet-400 mb-2">{chooseAvatarText}</p>
            <div className="grid grid-cols-4 gap-2">
              {nfts.map((nft) => {
                const isSelected = profile.avatar_token_id === nft.tokenId
                return (
                  <button
                    key={nft.tokenId}
                    type="button"
                    onClick={() => handleSelectAvatar(nft.tokenId)}
                    disabled={savingAvatar}
                    className={`aspect-square overflow-hidden border-2 transition-colors ${
                      isSelected
                        ? "border-[#7c3aed]"
                        : "border-zinc-800 hover:border-violet-700/50"
                    }`}
                  >
                    {nft.image ? (
                      <img
                        src={nft.image}
                        alt={nft.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center bg-zinc-900">
                        <span className="font-mono text-[8px] text-zinc-700">#{nft.tokenId}</span>
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
            <div className="flex justify-center mt-3">
              <button
                type="button"
                onClick={() => handleSelectAvatar(null)}
                disabled={savingAvatar || profile.avatar_token_id === undefined}
                className="font-mono text-[8px] uppercase tracking-widest text-zinc-600 hover:text-violet-400 transition-colors disabled:opacity-50"
              >
                {resetText}
              </button>
            </div>
          </div>
        )}

        {/* ── Stats 2×2 ── */}
        <div className="grid grid-cols-2 gap-px bg-violet-800/10 border-b border-violet-800/20">
          {[
            { label: t.statArtifacts, value: nftsLoading ? t.loading : nfts.length },
            { label: t.statPhaseLQ,   value: "—" },
            { label: t.statWorlds,    value: worldsCount ?? t.loading },
            { label: t.statNarratives,value: nfts.length > 0 ? nfts.length : "—" },
          ].map(({ label, value }) => (
            <div key={label} className="bg-zinc-900/80 px-4 py-3 flex flex-col gap-1">
              <span className="font-mono text-[8px] uppercase tracking-[0.2em] text-zinc-500">
                {label}
              </span>
              <span className="font-mono text-[20px] font-medium leading-none text-zinc-100">
                {value}
              </span>
            </div>
          ))}
        </div>

        {/* ── Quick actions ── */}
        <div className="flex gap-px border-b border-violet-800/20">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("open-faucet"))}
            className="flex-1 py-2 font-mono text-[9px] uppercase tracking-widest text-violet-400 hover:text-violet-200 hover:bg-violet-950/30 transition-colors"
          >
            {t.quickRewards}
          </button>
          <button
            type="button"
            onClick={() => { onOpenChange(false); router.push("/signals") }}
            className="flex-1 py-2 font-mono text-[9px] uppercase tracking-widest text-violet-400 hover:text-violet-200 hover:bg-violet-950/30 transition-colors"
          >
            {t.quickSignals}
          </button>
        </div>

        {/* ── Social links ── */}
        <div className="px-5 py-3 border-b border-violet-800/20">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-[8px] uppercase tracking-widest text-zinc-600">
              {t.socialLabel}
            </span>
            {!editing && (
              <div className="flex items-center gap-3">
                {saveMsg && (
                  <span className="font-mono text-[8px] text-violet-500">{saveMsg}</span>
                )}
                <button
                  type="button"
                  onClick={() => { setForm(profile); setEditing(true) }}
                  className="font-mono text-[8px] uppercase tracking-widest text-zinc-600 hover:text-violet-400 transition-colors"
                >
                  {t.edit}
                </button>
              </div>
            )}
          </div>

          {!editing ? (
            /* View mode */
            <SocialChips profile={profile} />
          ) : (
            /* Edit mode */
            <div className="space-y-1.5">
              {SOCIAL_FIELDS.map(({ key, label, ph }) => (
                <div key={key} className="flex items-center gap-2">
                  <label className="w-20 shrink-0 font-mono text-[8px] uppercase tracking-widest text-zinc-600">
                    {label}
                  </label>
                  <input
                    type="text"
                    value={form[key] ?? ""}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    placeholder={ph}
                    className="flex-1 h-8 border border-zinc-700 bg-zinc-900 px-2 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-violet-600 transition-colors"
                    maxLength={40}
                  />
                </div>
              ))}
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="font-mono text-[8px] uppercase tracking-widest text-violet-400 hover:text-violet-200 transition-colors disabled:opacity-50"
                >
                  {saving ? t.saving : t.save}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setForm(profile) }}
                  className="font-mono text-[8px] uppercase tracking-widest text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  {t.cancel}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Tabs ── */}
        <div className="flex border-b border-violet-800/20 shrink-0">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={[
                "flex-1 py-2.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
                tab === id
                  ? "text-violet-300 border-b-2 border-violet-500 -mb-px"
                  : "text-zinc-600 hover:text-zinc-400",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Tab content ── */}
        <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
          {tab === "artifacts" && (
            nftsLoading ? (
              <p className="font-mono text-[9px] text-zinc-600 pt-2">{t.loading}</p>
            ) : nfts.length === 0 ? (
              <p className="font-mono text-[9px] text-zinc-600 pt-2">{t.noArtifacts}</p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {nfts.map((nft) => (
                  <div key={nft.tokenId} className="group flex flex-col gap-1">
                    <div className="aspect-square overflow-hidden border border-zinc-800 bg-zinc-900 group-hover:border-violet-700/50 transition-colors">
                      {nft.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={nft.image} alt={nft.name} className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center">
                          <span className="font-mono text-[8px] text-zinc-700">#{nft.tokenId}</span>
                        </div>
                      )}
                    </div>
                    <p className="font-mono text-[8px] text-zinc-600 truncate leading-tight">
                      {nft.name}
                    </p>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === "rewards" && (
            <div className="pt-2 space-y-1">
              <a
                href="/faucet"
                className="block font-mono text-[9px] uppercase tracking-widest text-zinc-600 hover:text-violet-400 transition-colors"
              >
                → FAUCET / REWARDS
              </a>
            </div>
          )}

          {tab === "offers" && <OffersTab address={address} t={t} />}

          {tab === "achievements" && <AchievementsTab address={address} t={t} lang={lang} />}

          {tab === "search" && <SearchTab t={t} viewerAddress={address} />}
        </div>

        {/* ── Disconnect ── */}
        <div className="px-5 py-3 border-t border-violet-800/20 shrink-0">
          <button
            type="button"
            onClick={handleDisconnect}
            className="font-mono text-[9px] uppercase tracking-widest text-red-400/60 hover:text-red-400 transition-colors"
          >
            {t.disconnect}
          </button>
        </div>

      </SheetContent>
    </Sheet>
  )
}
