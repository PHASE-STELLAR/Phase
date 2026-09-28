import { notFound } from "next/navigation"
import type { Metadata } from "next"
import Link from "next/link"
import { LangToggle } from "@/components/lang-toggle"
import {
  getWorldForCollection,
  getNarrativeForToken,
} from "@/lib/narrative-world-store"
import {
  phaseProtocolContractIdForServer,
  fetchPhaseProtocolTotalSupply,
  fetchTokenOwnerAddress,
} from "@/lib/phase-protocol"
import {
  buildPhaseTokenMetadataJson,
  publicPhaseSiteBaseUrl,
} from "@/lib/phase-nft-metadata-build"

const navLink =
  "inline-flex min-h-[36px] items-center border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-400 transition-colors hover:border-violet-500/50 hover:text-violet-300"
const navLinkActive =
  "inline-flex min-h-[36px] items-center border border-violet-600/50 bg-violet-950/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-violet-300"

type Props = {
  params: Promise<{ collection_id: string }>
}

function resolveContractId(): string | null {
  try {
    return phaseProtocolContractIdForServer()
  } catch {
    return null
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() {
    for (;;) {
      const idx = i++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { collection_id } = await params
  const collectionId = parseInt(collection_id, 10)
  if (!Number.isFinite(collectionId) || collectionId <= 0) return { title: "Not Found" }

  const world = await getWorldForCollection(collectionId).catch(() => null)
  if (!world) return { title: "PHASE World Archive" }

  const base = publicPhaseSiteBaseUrl()
  return {
    title: `${world.world_name} · PHASE World`,
    description: world.world_prompt,
    alternates: { canonical: `${base}/world/${collection_id}` },
    openGraph: {
      title: `${world.world_name} · PHASE World`,
      description: world.world_prompt,
      url: `${base}/world/${collection_id}`,
      type: "website",
    },
    twitter: {
      card: "summary",
      title: `${world.world_name} · PHASE World`,
      description: world.world_prompt,
    },
  }
}

type WorldNFT = {
  tokenId: number
  name: string
  image: string
  narrative: string | null
  narrativeTimestamp: number | null
}

function StoryTimelineVisualizer({
  narratives,
}: {
  narratives: Array<WorldNFT & { narrative: string }>
}) {
  const sorted = [...narratives].sort(
    (a, b) => (a.narrativeTimestamp ?? 0) - (b.narrativeTimestamp ?? 0),
  )

  return (
    <ol className="relative space-y-6 border-l border-violet-400/30 pl-6">
      {sorted.map((nft) => (
        <li key={nft.tokenId} className="relative">
          <span className="absolute -left-[31px] top-1 h-2.5 w-2.5 rounded-full border border-violet-400/60 bg-violet-950" />
          <span className="mb-1 block text-[9px] uppercase tracking-widest text-violet-500/70">
            TOKEN_#{nft.tokenId} ·{" "}
            {nft.narrativeTimestamp
              ? `${new Date(nft.narrativeTimestamp)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 19)} UTC`
              : "UNKNOWN_TIME"}
          </span>
          <p className="text-[12px] italic leading-relaxed text-violet-200/80">
            {nft.narrative}
          </p>
        </li>
      ))}
    </ol>
  )
}

export default async function WorldGalleryPage({ params }: Props) {
  const { collection_id } = await params
  const collectionId = parseInt(collection_id, 10)

  if (!Number.isFinite(collectionId) || collectionId <= 0) notFound()

  const [world, contractId] = await Promise.all([
    getWorldForCollection(collectionId).catch(() => null),
    Promise.resolve(resolveContractId()),
  ])

  if (!world) notFound()
  if (!contractId) notFound()

  const scanCap = Math.min(
    500,
    Math.max(1, parseInt(process.env.PHASE_EXPLORE_SCAN_CAP ?? "500", 10)),
  )
  const rawTotal = await fetchPhaseProtocolTotalSupply(contractId)
  const total = Math.min(rawTotal, scanCap)

  let nfts: WorldNFT[] = []

  if (total > 0) {
    const ids = Array.from({ length: total }, (_, i) => i + 1)

    // 1. Scan owners
    const owned = await mapConcurrent(ids, 12, async (id) => {
      try {
        const owner = await fetchTokenOwnerAddress(contractId, id)
        return owner ? id : null
      } catch {
        return null
      }
    })
    const ownedIds = owned.filter((x): x is number => x !== null)

    // 2. Build metadata + filter by collectionId + fetch narratives (single pass)
    const results = await mapConcurrent(ownedIds, 8, async (id) => {
      const meta = await buildPhaseTokenMetadataJson(contractId, id).catch(() => null)
      if (!meta || meta.collectionId !== collectionId) return null
      const narrativeData = await getNarrativeForToken(id).catch(() => null)
      return {
        tokenId: id,
        name: meta.name,
        image: meta.image,
        narrative: narrativeData?.narrative ?? null,
        narrativeTimestamp: narrativeData?.generated_at ?? null,
      } satisfies WorldNFT
    })

    nfts = results.filter((x): x is WorldNFT => x !== null)
  }

  return (
    <div className="min-h-screen bg-background font-mono text-foreground">
      <div className="grid-bg pointer-events-none fixed inset-0 opacity-40" aria-hidden />

      {/* Header */}
      <header className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-violet-800/40 bg-zinc-950/90 px-4 py-3 backdrop-blur-sm md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/world" className={navLink}>← Worlds</Link>
          <span className={navLinkActive} aria-current="page">[ WORLD ]</span>
          <Link href="/explore" className={navLink}>Explore</Link>
        </div>
        <span className="text-center text-[10px] font-bold uppercase tracking-[0.28em] text-violet-200">
          ◈ {world.world_name.toUpperCase()}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <LangToggle variant="phosphor" />
          <Link href="/forge" className={navLink}>Forge</Link>
          <Link href="/chamber" className={navLink}>Chamber</Link>
          <Link href="/dashboard" className={navLink}>Market</Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-7xl px-4 py-10 md:py-12">
        <div className="border-4 border-double border-violet-400/55 bg-[oklch(0.05_0_0)] shadow-[0_0_32px_rgba(139,92,246,0.06)]">

          {/* ── Section 1: World header ── */}
          <div className="border-b border-violet-400/30 px-6 py-6 md:px-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex max-w-2xl flex-col gap-2">
                <span className="w-fit border border-violet-400/50 bg-violet-950/50 px-2 py-0.5 text-[8px] uppercase tracking-widest text-violet-300">
                  [ COLLECTION_#{collectionId} ]
                </span>
                <h1 className="text-[24px] font-medium leading-tight tracking-wide text-violet-100">
                  {world.world_name}
                </h1>
                <p className="line-clamp-3 text-[13px] leading-relaxed text-violet-300/70">
                  {world.world_prompt}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="text-[11px] uppercase tracking-[0.15em] text-violet-500/70">
                  ARTIFACTS · {nfts.length} &nbsp;·&nbsp; NARRATIVES ·{" "}
                  {nfts.filter((n) => n.narrative !== null).length}
                </div>
                <Link
                  href={`/chamber?collection=${collectionId}`}
                  className="inline-flex min-h-[36px] items-center border border-violet-500/50 bg-violet-950/30 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-violet-300 transition-colors hover:border-violet-400 hover:bg-violet-900/40 hover:text-violet-100"
                >
                  [ MINT_IN_THIS_WORLD ]
                </Link>
              </div>
            </div>
          </div>

          {/* ── Section 2: Artifact archive ── */}
          <div className="border-b border-violet-400/20 px-6 py-6 md:px-8">
            <h2 className="mb-5 text-[11px] font-bold uppercase tracking-[0.28em] text-violet-400">
              ◈ [ ARTIFACT_ARCHIVE ]
            </h2>
            {nfts.length === 0 ? (
              <p className="py-12 text-center text-[10px] uppercase tracking-widest text-violet-500/50">
                [ AWAITING_FIRST_MINT ]
              </p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {nfts.map((nft) => (
                  <li
                    key={nft.tokenId}
                    className="group flex flex-col border border-violet-500/30 bg-black/50 transition-all duration-200 hover:border-violet-400/60 hover:shadow-[0_0_14px_rgba(139,92,246,0.08)]"
                  >
                    <div className="relative border-b border-violet-500/20">
                      {nft.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={nft.image}
                          alt={nft.name}
                          loading="lazy"
                          decoding="async"
                          className="aspect-square w-full object-cover opacity-80 transition-opacity group-hover:opacity-95"
                        />
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center bg-violet-950/20">
                          <span className="text-[9px] uppercase tracking-widest text-violet-400/30">
                            NO_IMAGE
                          </span>
                        </div>
                      )}
                      <span className="absolute left-2 top-2 border border-violet-400/40 bg-black/70 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest text-violet-300/80">
                        #{nft.tokenId}
                      </span>
                      {nft.narrative && (
                        <span className="absolute bottom-1.5 left-1.5 border border-violet-400/60 bg-black/80 px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-violet-300">
                          [ NARRATED ]
                        </span>
                      )}
                      <Link
                        href={`/chamber?collection=${collectionId}`}
                        className="absolute inset-0"
                        aria-label={`Open Chamber for ${nft.name}`}
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-1.5 p-3">
                      <p className="line-clamp-2 text-[11px] font-semibold uppercase tracking-wide text-violet-50">
                        {nft.name}
                      </p>
                      {!nft.narrative && (
                        <p className="text-[9px] uppercase tracking-widest text-violet-400/30">
                          // LORE_PENDING
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Section 3: Narrator feed ── */}
          <div className="px-6 py-6 md:px-8">
            <h2 className="mb-5 text-[11px] font-bold uppercase tracking-[0.28em] text-violet-400">
              ◈ [ NARRATIVE_TIMELINE ]
            </h2>
            {nfts.filter((n) => n.narrative !== null).length === 0 ? (
              <p className="py-10 text-center text-[10px] uppercase tracking-widest text-violet-500/50">
                [ AWAITING_FIRST_MINT ]
              </p>
            ) : (
              <StoryTimelineVisualizer
                narratives={nfts.filter(
                  (n): n is WorldNFT & { narrative: string } => n.narrative !== null,
                )}
              />
            )}
          </div>

        </div>
      </main>
    </div>
  )
}
