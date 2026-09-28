import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { WalletAvatar } from "@/components/wallet-avatar"
import { getProfile } from "@/lib/profile-store"
import { getFollowCounts } from "@/lib/follow-store"
import { getSignals } from "@/lib/signal-store"
import { getAchievements } from "@/lib/achievement-store"
import { SocialChipsPublic } from "./social-chips-public"
import { FollowButton, FollowSuggestions } from "./follow-button"

type Props = {
  params: Promise<{ wallet: string }>
}

function truncate(addr: string) {
  if (!addr || addr.length < 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const d = Math.floor(diff / 86400000)
  const h = Math.floor(diff / 3600000)
  const m = Math.floor(diff / 60000)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  return `${m}m ago`
}

async function fetchNfts(wallet: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
    const res = await fetch(
      `${baseUrl}/api/wallet/phase-nfts?address=${encodeURIComponent(wallet)}`,
      { next: { revalidate: 60 } },
    )
    if (!res.ok) return []
    const json = (await res.json()) as {
      items?: { tokenId: number; name: string; image?: string; collectionId?: number }[]
    }
    return json.items ?? []
  } catch {
    return []
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { wallet } = await params
  const profile = await getProfile(wallet)
  const name = profile?.display_name ?? truncate(wallet)

  return {
    title: `${name} — PHASE`,
    description: `Profile of ${name} on PHASE. NFT artifacts, worlds, and rewards.`,
    openGraph: {
      title: `${name} on PHASE`,
      description: `View ${name}'s artifacts and worlds on PHASE.`,
      images: [
        {
          url: `/api/og/profile?wallet=${encodeURIComponent(wallet)}`,
          width: 1200,
          height: 630,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${name} on PHASE`,
      description: `View ${name}'s artifacts and worlds on PHASE.`,
      images: [`/api/og/profile?wallet=${encodeURIComponent(wallet)}`],
    },
  }
}

export default async function ProfilePage({ params }: Props) {
  const { wallet } = await params

  if (!wallet || wallet.length < 10) notFound()

  const [profile, nfts, followCounts, recentSignals, achievements] = await Promise.all([
    getProfile(wallet),
    fetchNfts(wallet),
    getFollowCounts(wallet),
    getSignals(undefined, "new").then((all) => all.filter((s) => s.author_wallet === wallet).slice(0, 3)),
    getAchievements(wallet),
  ])

  const displayName = profile?.display_name ?? truncate(wallet)
  const isCollector = nfts.length > 0

  return (
    <main className="min-h-screen bg-zinc-950 text-violet-100 px-4 py-16 font-mono">
      <div className="mx-auto max-w-2xl space-y-10">

        {/* Identity */}
        <section className="space-y-2">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-lg font-bold uppercase tracking-widest text-violet-300">
                  {displayName}
                </h1>
                {isCollector && (
                  <span
                    className="font-mono text-[8px] px-1.5 py-0.5"
                    style={{ background: "#E1F5EE", color: "#0F6E56" }}
                  >
                    ✓ COLLECTOR
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-600 tracking-widest break-all">{wallet}</p>
              <p className="font-mono text-[9px] text-zinc-600">
                <span className="text-zinc-400">{followCounts.followers}</span> followers
                {" · "}
                <span className="text-zinc-400">{followCounts.following}</span> following
              </p>
            </div>
            <FollowButton targetWallet={wallet} />
          </div>

          {/* Social handles */}
          {(profile?.twitter || profile?.discord || profile?.telegram) && (
            <div className="pt-1">
              <SocialChipsPublic profile={profile} />
            </div>
          )}
        </section>

        <FollowSuggestions profileWallet={wallet} />

        {/* Recent activity */}
        {(recentSignals.length > 0 || nfts.length > 0) && (
          <section className="space-y-3">
            <h2 className="text-[9px] uppercase tracking-widest text-zinc-600 border-b border-violet-800/20 pb-1">
              // RECENT_ACTIVITY
            </h2>
            <div className="space-y-2">
              {recentSignals.map((s) => (
                <a
                  key={s.id}
                  href={`/signals/${s.id}`}
                  className="flex items-start gap-3 border border-violet-800/10 bg-zinc-900/40 p-2 hover:border-violet-700/30 transition-colors"
                >
                  <span className="font-mono text-[8px] uppercase tracking-widest text-violet-600 shrink-0 pt-0.5">
                    POST
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[10px] text-zinc-300 truncate">{s.title}</p>
                    <p className="font-mono text-[8px] text-zinc-600">{timeAgo(s.created_at)}</p>
                  </div>
                </a>
              ))}
              {nfts.slice(0, 3).map((nft) => (
                <div
                  key={nft.tokenId}
                  className="flex items-center gap-3 border border-violet-800/10 bg-zinc-900/40 p-2"
                >
                  <span className="font-mono text-[8px] uppercase tracking-widest text-[#0F6E56] shrink-0">
                    MINT
                  </span>
                  {nft.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={nft.image} alt={nft.name} className="h-6 w-6 object-cover" />
                  )}
                  <p className="font-mono text-[10px] text-zinc-300 truncate">{nft.name}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Achievements */}
        {achievements.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-[9px] uppercase tracking-widest text-zinc-600 border-b border-violet-800/20 pb-1">
              ACHIEVEMENTS — {achievements.length}
            </h2>
            <div className="flex flex-wrap gap-2">
              {achievements.map((a) => {
                const NAMES: Record<string, string> = {
                  first_mint: "First Artifact", collector_5: "Collector ×5", collector_10: "Collector ×10",
                  first_collection: "Forge Master", world_builder: "World Builder", narrator_10: "Narrator ×10",
                  signal_pioneer: "Signal Pioneer", community_voice: "Community Voice", connector_10: "Connector ×10",
                  daily_streak_7: "Streak ×7", daily_streak_30: "Streak ×30", phaselq_100: "PHASELQ ×100",
                }
                return (
                  <span
                    key={a.id}
                    className="inline-flex items-center gap-1 font-mono text-[8px] px-2 py-1"
                    style={{ background: "rgba(124,58,237,0.1)", color: "#a78bfa", border: "1px solid rgba(124,58,237,0.25)" }}
                    title={`Unlocked ${new Date(a.unlocked_at).toLocaleDateString()}`}
                  >
                    ◈ {NAMES[a.id] ?? a.id}
                  </span>
                )
              })}
            </div>
          </section>
        )}

        {/* Artifact grid */}
        <section className="space-y-3">
          <h2 className="text-[9px] uppercase tracking-widest text-zinc-600 border-b border-violet-800/20 pb-1">
            ARTIFACTS — {nfts.length}
          </h2>

          {nfts.length === 0 ? (
            <p className="text-[9px] text-zinc-700">No artifacts minted yet.</p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {nfts.map((nft) => (
                <div
                  key={nft.tokenId}
                  className="aspect-square overflow-hidden rounded-sm border border-violet-800/20 bg-zinc-900"
                  title={nft.name}
                >
                  {nft.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={nft.image}
                      alt={nft.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center">
                      <span className="text-[8px] text-zinc-700">#{nft.tokenId}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Back link */}
        <a
          href="/"
          className="inline-block text-[9px] uppercase tracking-widest text-zinc-700 hover:text-violet-400 transition-colors"
        >
          ← PHASE
        </a>
      </div>
    </main>
  )
}
