"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { LangToggle } from "@/components/lang-toggle"
import { useLang } from "@/components/lang-context"
import { useWallet } from "@/components/wallet-provider"
import { fetchCreatorCollectionIds } from "@/lib/phase-protocol"
import type { WorldsListItem, WorldsGlobalStats } from "@/app/api/world/route"
import type { NarratorTone } from "@/lib/narrative-world-store"

// ── i18n ──────────────────────────────────────────────────────────────────────
const copy = {
  en: {
    title: "◈ WORLD_STUDIO",
    subtitle: "Narrative universes built on PHASE. Each collection is a world. Each mint expands the story.",
    tabs: {
      explore: "[ EXPLORE_WORLDS ]",
      create:  "[ CREATE_WORLD ]",
      manage:  "[ MY_WORLDS ]",
    },
    stats: {
      worldsActive:       "WORLDS ACTIVE",
      totalArtifacts:     "TOTAL ARTIFACTS",
      narrativesGenerated:"NARRATIVES GENERATED",
      collectors:         "COLLECTORS",
    },
    noWorlds:   "[ NO_WORLDS_ACTIVE ]",
    noWorldsDesc: "No narrative worlds exist yet.",
    noWorldsDesc2: "Create one from the",
    noWorldsLink: "Create World",
    noWorldsTab:  "tab.",
    recentNarratives: "◈ [ RECENT_NARRATIVES ]",
    noNarratives: "[ NO_NARRATIVES_YET ]",
    enterWorld: "[ ENTER_WORLD ]",
    worldActive: "[ WORLD_ACTIVE ]",
    collectionLabel: "COLLECTION",
    narrativesLabel: "NARRATIVES",
    // Create tab
    createTitle: "◈ [ FORGE_NEW_WORLD ]",
    createSubtitle: "Define a universe context. Every mint in this collection will inherit it.",
    fieldWorldName: "World Name",
    fieldWorldNameHint: "Max 80 characters",
    fieldCollection: "Link to Collection",
    fieldCollectionHint: "Only collections without an active world are shown.",
    fieldCollectionLoading: "Loading your collections…",
    fieldCollectionNone: "No collections available",
    fieldCollectionNoneHint: "All your collections already have a world. ",
    fieldCollectionForgeLink: "Create a new collection →",
    fieldTone: "Narrator Tone",
    fieldContext: "Universe Context",
    fieldContextHint: "Every mint in this collection will inherit this context. Gemini uses it to generate coherent lore for each artifact.",
    fieldContextPreviewLabel: "GEMINI CONTEXT PREVIEW",
    fieldContextPreviewEmpty: "[World: {name}] {context}",
    ctaForge: "[ FORGE_WORLD ]",
    ctaForging: "[ FORGING… ]",
    walletRequired: "[ CONNECT_WALLET_REQUIRED ]",
    walletRequiredDesc: "Connect your Freighter wallet to create a world.",
    connectWallet: "[ CONNECT_WALLET ]",
    connecting: "[ CONNECTING… ]",
    tones: {
      enigmatic:  "enigmatic — dark, literary, mysterious",
      epic:       "epic — heroic, grand, mythological",
      scientific: "scientific — analytical, precise, cold",
      folkloric:  "folkloric — oral tradition, poetic, ancient",
    },
    errorSave: "Failed to save world.",
    successRedirect: "World forged. Redirecting…",
    // Manage tab
    manageTitle: "◈ [ MY_WORLDS ]",
    manageEmpty: "[ NO_WORLDS_YET ]",
    manageEmptyDesc: "You have no active worlds.",
    manageCreateLink: "Create your first world →",
    editBtn: "[ EDIT ]",
    viewBtn: "[ VIEW ]",
    saveBtn: "[ SAVE ]",
    savingBtn: "[ SAVING… ]",
    cancelBtn: "[ CANCEL ]",
    analyticsTitle: "◈ [ ANALYTICS ]",
    mostActive: "MOST ACTIVE WORLD",
    totalNarratives: "TOTAL NARRATIVES",
    lastNarrative: "LAST NARRATIVE",
    none: "—",
    artifactsLabel: "ARTIFACTS",
    timelineTitle: "◈ [ STORY_TIMELINE ]",
    timelineLoading: "[ LOADING_TIMELINE ]",
    timelineEmpty: "[ NO_LORE_NODES ]",
    timelineNode: "LORE_NODE",
  },
  es: {
    title: "◈ WORLD_STUDIO",
    subtitle: "Universos narrativos construidos en PHASE. Cada colección es un mundo. Cada mint expande la historia.",
    tabs: {
      explore: "[ EXPLORAR_MUNDOS ]",
      create:  "[ CREAR_MUNDO ]",
      manage:  "[ MIS_MUNDOS ]",
    },
    stats: {
      worldsActive:       "MUNDOS ACTIVOS",
      totalArtifacts:     "ARTEFACTOS TOTALES",
      narrativesGenerated:"NARRATIVAS GENERADAS",
      collectors:         "COLECCIONISTAS",
    },
    noWorlds:   "[ SIN_MUNDOS_ACTIVOS ]",
    noWorldsDesc: "Aún no existen mundos narrativos.",
    noWorldsDesc2: "Crea uno desde la pestaña",
    noWorldsLink: "Crear Mundo",
    noWorldsTab:  ".",
    recentNarratives: "◈ [ NARRATIVAS_RECIENTES ]",
    noNarratives: "[ SIN_NARRATIVAS_AÚN ]",
    enterWorld: "[ ENTRAR_AL_MUNDO ]",
    worldActive: "[ MUNDO_ACTIVO ]",
    collectionLabel: "COLECCIÓN",
    narrativesLabel: "NARRATIVAS",
    // Create tab
    createTitle: "◈ [ FORJAR_NUEVO_MUNDO ]",
    createSubtitle: "Define un contexto de universo. Cada mint en esta colección lo heredará.",
    fieldWorldName: "Nombre del Mundo",
    fieldWorldNameHint: "Máximo 80 caracteres",
    fieldCollection: "Vincular a Colección",
    fieldCollectionHint: "Solo se muestran colecciones sin mundo activo.",
    fieldCollectionLoading: "Cargando tus colecciones…",
    fieldCollectionNone: "Sin colecciones disponibles",
    fieldCollectionNoneHint: "Todas tus colecciones ya tienen un mundo. ",
    fieldCollectionForgeLink: "Crear nueva colección →",
    fieldTone: "Tono del Narrador",
    fieldContext: "Contexto del Universo",
    fieldContextHint: "Cada mint en esta colección heredará este contexto. Gemini lo usa para generar lore coherente para cada artefacto.",
    fieldContextPreviewLabel: "VISTA PREVIA CONTEXTO GEMINI",
    fieldContextPreviewEmpty: "[Mundo: {nombre}] {contexto}",
    ctaForge: "[ FORJAR_MUNDO ]",
    ctaForging: "[ FORJANDO… ]",
    walletRequired: "[ WALLET_REQUERIDA ]",
    walletRequiredDesc: "Conecta tu wallet Freighter para crear un mundo.",
    connectWallet: "[ CONECTAR_WALLET ]",
    connecting: "[ CONECTANDO… ]",
    tones: {
      enigmatic:  "enigmático — oscuro, literario, misterioso",
      epic:       "épico — heroico, grandioso, mitológico",
      scientific: "científico — analítico, preciso, frío",
      folkloric:  "folclórico — tradición oral, poético, antiguo",
    },
    errorSave: "Error al guardar el mundo.",
    successRedirect: "Mundo forjado. Redirigiendo…",
    // Manage tab
    manageTitle: "◈ [ MIS_MUNDOS ]",
    manageEmpty: "[ SIN_MUNDOS_AÚN ]",
    manageEmptyDesc: "No tienes mundos activos.",
    manageCreateLink: "Crea tu primer mundo →",
    editBtn: "[ EDITAR ]",
    viewBtn: "[ VER ]",
    saveBtn: "[ GUARDAR ]",
    savingBtn: "[ GUARDANDO… ]",
    cancelBtn: "[ CANCELAR ]",
    analyticsTitle: "◈ [ ANALÍTICAS ]",
    mostActive: "MUNDO MÁS ACTIVO",
    totalNarratives: "TOTAL NARRATIVAS",
    lastNarrative: "ÚLTIMA NARRATIVA",
    none: "—",
    artifactsLabel: "ARTEFACTOS",
    timelineTitle: "◈ [ LÍNEA_TEMPORAL ]",
    timelineLoading: "[ CARGANDO_LÍNEA ]",
    timelineEmpty: "[ SIN_NODOS_DE_LORE ]",
    timelineNode: "NODO_DE_LORE",
  },
} as const

// Union of both locales — used as prop type in child components so both EN and ES are valid
type CopyT = (typeof copy)[keyof typeof copy]

// ── Shared style tokens ────────────────────────────────────────────────────────
const NAV_LINK =
  "inline-flex min-h-[36px] items-center border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-400 transition-colors hover:border-violet-500/50 hover:text-violet-300"
const NAV_LINK_ACTIVE =
  "inline-flex min-h-[36px] items-center border border-violet-600/50 bg-violet-950/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-violet-300"
const INPUT_BASE =
  "w-full border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-[12px] text-zinc-200 placeholder-zinc-700 outline-none focus:border-violet-500/50 transition-colors"
const BTN_PRIMARY =
  "inline-flex min-h-[36px] items-center gap-2 border border-violet-500/60 bg-violet-950/30 px-5 py-2 text-[10px] font-bold uppercase tracking-widest text-violet-300 transition-colors hover:border-violet-400 hover:bg-violet-900/40 hover:text-violet-100 disabled:opacity-40 disabled:cursor-not-allowed"
const BTN_GHOST =
  "inline-flex min-h-[36px] items-center border border-zinc-700 bg-zinc-900/40 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = "explore" | "create" | "manage"

type WorldsApiResponse = {
  items: WorldsListItem[]
  globalStats: WorldsGlobalStats
}

type StoryTimelineNode = {
  token_id: number
  narrative: string
  created_at: number
}

// ── Main page component ────────────────────────────────────────────────────────
function WorldStudioInner() {
  const { lang } = useLang()
  const t = copy[lang]
  const router = useRouter()
  const searchParams = useSearchParams()

  const rawTab = searchParams.get("tab")
  const activeTab: Tab =
    rawTab === "create" || rawTab === "manage" ? rawTab : "explore"

  function setTab(tab: Tab) {
    const params = new URLSearchParams(searchParams.toString())
    params.set("tab", tab)
    router.push(`?${params.toString()}`, { scroll: false })
  }

  // World data — fetched once for all tabs
  const [worlds, setWorlds] = useState<WorldsListItem[]>([])
  const [globalStats, setGlobalStats] = useState<WorldsGlobalStats | null>(null)
  const [loadingWorlds, setLoadingWorlds] = useState(true)

  useEffect(() => {
    setLoadingWorlds(true)
    fetch("/api/world")
      .then((r) => r.json() as Promise<WorldsApiResponse>)
      .then(({ items, globalStats: gs }) => {
        setWorlds(items)
        setGlobalStats(gs)
      })
      .catch(() => {})
      .finally(() => setLoadingWorlds(false))
  }, [])

  return (
    <div className="min-h-screen bg-background font-mono text-foreground">
      <div className="grid-bg pointer-events-none fixed inset-0 opacity-40" aria-hidden />

      {/* Header */}
      <header className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-violet-800/40 bg-zinc-950/90 px-4 py-3 backdrop-blur-sm md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/" className={NAV_LINK}>← Home</Link>
          <Link href="/explore" className={NAV_LINK}>Explore</Link>
          <span className={NAV_LINK_ACTIVE} aria-current="page">[ WORLD ]</span>
        </div>
        <span className="text-center text-[10px] font-bold uppercase tracking-[0.28em] text-violet-200">
          {t.title}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <LangToggle variant="phosphor" />
          <Link href="/forge" className={NAV_LINK}>Forge</Link>
          <Link href="/chamber" className={NAV_LINK}>Chamber</Link>
          <Link href="/dashboard" className={NAV_LINK}>Market</Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-7xl px-4 py-10 md:py-12">
        <div className="border-4 border-double border-violet-400/55 bg-[oklch(0.05_0_0)] shadow-[0_0_32px_rgba(139,92,246,0.06)]">

          {/* Title bar */}
          <div className="border-b border-violet-400/30 px-6 py-5 md:px-8">
            <h1 className="text-[13px] font-bold uppercase tracking-[0.28em] text-violet-200">
              {t.title}
            </h1>
            <p className="mt-1.5 max-w-xl text-[10px] leading-relaxed text-violet-300/70">
              {t.subtitle}
            </p>
          </div>

          {/* Tab bar */}
          <div className="flex flex-wrap gap-px border-b border-violet-400/20 bg-violet-900/10">
            {(["explore", "create", "manage"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setTab(tab)}
                className={[
                  "px-5 py-3 text-[10px] font-bold uppercase tracking-widest transition-colors",
                  activeTab === tab
                    ? "border-b-2 border-violet-400 text-violet-200 bg-violet-950/40"
                    : "text-violet-500/60 hover:text-violet-300",
                ].join(" ")}
              >
                {t.tabs[tab]}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-6 md:p-8">
            {activeTab === "explore" && (
              <ExploreTab
                worlds={worlds}
                globalStats={globalStats}
                loading={loadingWorlds}
                t={t}
              />
            )}
            {activeTab === "create" && (
              <CreateTab
                worlds={worlds}
                onWorldCreated={(id) => {
                  router.push(`/world/${id}`)
                }}
                t={t}
                lang={lang}
              />
            )}
            {activeTab === "manage" && (
              <ManageTab
                worlds={worlds}
                onWorldUpdated={(updated) => {
                  setWorlds((prev) =>
                    prev.map((w) => (w.collectionId === updated.collectionId ? updated : w)),
                  )
                }}
                onNavigateCreate={() => setTab("create")}
                t={t}
                lang={lang}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

export default function WorldStudioPage() {
  return (
    <Suspense>
      <WorldStudioInner />
    </Suspense>
  )
}

// ── Tab 1: EXPLORE ─────────────────────────────────────────────────────────────
function ExploreTab({
  worlds,
  globalStats,
  loading,
  t,
}: {
  worlds: WorldsListItem[]
  globalStats: WorldsGlobalStats | null
  loading: boolean
  t: CopyT
}) {
  // 5 most recent narratives across all worlds
  const recentNarratives = worlds
    .flatMap((w) =>
      w.latestNarrative
        ? [{ collectionId: w.collectionId, world_name: w.world_name, narrative: w.latestNarrative }]
        : [],
    )
    .slice(0, 5)

  return (
    <div className="space-y-10">
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            { label: t.stats.worldsActive,        value: globalStats?.worldsActive        ?? "···" },
            { label: t.stats.totalArtifacts,       value: globalStats?.totalArtifacts      ?? "···" },
            { label: t.stats.narrativesGenerated,  value: globalStats?.narrativesGenerated ?? "···" },
            { label: t.stats.collectors,           value: globalStats?.collectors          ?? "···" },
          ] as const
        ).map(({ label, value }) => (
          <div
            key={label}
            className="flex flex-col gap-1.5 border border-violet-500/25 bg-violet-950/15 px-4 py-3"
          >
            <span className="text-[9px] uppercase tracking-[0.22em] text-violet-500/60">{label}</span>
            <span className="text-[22px] font-bold leading-none tracking-tight text-violet-300">
              {loading ? "···" : String(value)}
            </span>
          </div>
        ))}
      </div>

      {/* Worlds grid */}
      {loading ? (
        <div className="py-16 text-center text-[10px] uppercase tracking-widest text-violet-500/40">
          [ LOADING… ]
        </div>
      ) : worlds.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-20">
          <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-violet-400/80">
            {t.noWorlds}
          </p>
          <p className="text-[11px] leading-relaxed text-violet-300/60">
            {t.noWorldsDesc}{" "}
            <span className="text-violet-300/40">{t.noWorldsDesc2}</span>
          </p>
        </div>
      ) : (
        <ul
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
        >
          {worlds.map((w) => (
            <WorldCard key={w.collectionId} world={w} t={t} />
          ))}
        </ul>
      )}

      {/* Recent narratives feed */}
      <div>
        <h2 className="mb-5 text-[11px] font-bold uppercase tracking-[0.28em] text-violet-400">
          {t.recentNarratives}
        </h2>
        {recentNarratives.length === 0 ? (
          <p className="py-8 text-center text-[10px] uppercase tracking-widest text-violet-500/40">
            {t.noNarratives}
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-violet-400/10">
            {recentNarratives.map((n, i) => (
              <li key={i} className="flex flex-col gap-1.5 py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="border border-violet-500/30 bg-violet-950/40 px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-violet-400">
                    {t.collectionLabel}_#{n.collectionId}
                  </span>
                  <span className="text-[9px] uppercase tracking-widest text-violet-500/50">
                    {n.world_name}
                  </span>
                </div>
                <p className="text-[12px] italic leading-relaxed text-violet-200/75">
                  {n.narrative}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function WorldCard({ world, t }: { world: WorldsListItem; t: CopyT }) {
  return (
    <li className="list-none">
      <Link
        href={`/world/${world.collectionId}`}
        className="group flex h-full flex-col gap-3 border border-violet-500/30 bg-black/50 p-4 transition-all duration-200 hover:border-violet-400/60 hover:shadow-[0_0_20px_rgba(139,92,246,0.10)]"
      >
        <span className="w-fit border border-violet-400/50 bg-violet-950/50 px-2 py-0.5 text-[8px] uppercase tracking-widest text-violet-300">
          {t.worldActive}
        </span>
        <p className="text-[16px] font-medium tracking-wide text-violet-100 transition-colors group-hover:text-violet-50">
          {world.world_name}
        </p>
        <p className="text-[12px] leading-relaxed text-violet-300/60">
          {world.world_prompt.length > 120
            ? `${world.world_prompt.slice(0, 120)}…`
            : world.world_prompt}
        </p>
        <div className="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.15em] text-violet-500/70">
          <span>{t.collectionLabel} · #{world.collectionId}</span>
          <span>{t.narrativesLabel} · {world.narrativeCount}</span>
        </div>
        {world.latestNarrative && (
          <div className="border-l-2 border-violet-400/40 pl-3">
            <p className="line-clamp-3 text-[11px] italic leading-relaxed text-violet-200/70">
              {world.latestNarrative}
            </p>
          </div>
        )}
        <div className="mt-auto pt-2">
          <span className="inline-flex items-center gap-1.5 border border-violet-500/40 bg-violet-950/30 px-3 py-1.5 text-[9px] uppercase tracking-widest text-violet-300 transition-colors group-hover:border-violet-400/60 group-hover:bg-violet-900/30 group-hover:text-violet-100">
            {t.enterWorld}
          </span>
        </div>
      </Link>
    </li>
  )
}

export function StoryTimeline({
  nodes = [],
  loading = false,
  limit = 50,
  t,
}: {
  nodes?: StoryTimelineNode[]
  loading?: boolean
  limit?: number
  t: CopyT
}) {
  if (loading) {
    return (
      <div className="py-6 text-center text-[9px] uppercase tracking-widest text-violet-500/40">
        {t.timelineLoading}
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div className="py-6 text-center text-[9px] uppercase tracking-widest text-violet-500/40">
        {t.timelineEmpty}
      </div>
    )
  }

  const sorted = [...nodes].sort((a, b) => Number(a.created_at) - Number(b.created_at))
  const visible = limit > 0 ? sorted.slice(-limit) : sorted

  return (
    <div className="mt-4 space-y-3 border-t border-violet-500/20 pt-3">
      <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-violet-500/60">
        {t.timelineTitle}
      </p>
      <ol className="relative ml-1 flex flex-col gap-4 border-l border-violet-500/30 pl-4">
        {visible.map((node) => (
          <li key={node.token_id} className="relative">
            <span className="absolute -left-[21px] top-1.5 h-2 w-2 rotate-45 border border-violet-400 bg-violet-950" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="border border-violet-500/30 bg-violet-950/40 px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-violet-400">
                {t.timelineNode} #{node.token_id}
              </span>
            </div>
            <p className="mt-1.5 text-[12px] italic leading-relaxed text-violet-200/75">
              {node.narrative}
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ── Tab 2: CREATE ──────────────────────────────────────────────────────────────
function CreateTab({
  worlds,
  onWorldCreated,
  t,
  lang,
}: {
  worlds: WorldsListItem[]
  onWorldCreated: (collectionId: number) => void
  t: CopyT
  lang: "en" | "es"
}) {
  const { address, connecting, connect } = useWallet()

  const [myCollectionIds, setMyCollectionIds] = useState<number[]>([])
  const [loadingCollections, setLoadingCollections] = useState(false)

  const [worldName, setWorldName] = useState("")
  const [collectionId, setCollectionId] = useState<number | "">("")
  const [tone, setTone] = useState<NarratorTone>("enigmatic")
  const [worldPrompt, setWorldPrompt] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existingWorldIds = new Set(worlds.map((w) => w.collectionId))
  const availableIds = myCollectionIds.filter((id) => !existingWorldIds.has(id))

  useEffect(() => {
    if (!address) return
    setLoadingCollections(true)
    fetchCreatorCollectionIds(address)
      .then(setMyCollectionIds)
      .catch(() => {})
      .finally(() => setLoadingCollections(false))
  }, [address])

  // Reset collectionId if it's no longer available
  useEffect(() => {
    if (collectionId !== "" && !availableIds.includes(collectionId)) {
      setCollectionId("")
    }
  }, [availableIds, collectionId])

  const contextPreview =
    worldName.trim() || worldPrompt.trim()
      ? `[World: ${worldName.trim() || "…"}] ${worldPrompt.trim() || "…"}`
      : lang === "es"
        ? t.fieldContextPreviewEmpty
        : t.fieldContextPreviewEmpty

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!address || collectionId === "" || !worldName.trim() || !worldPrompt.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection_id: collectionId,
          world_name: worldName.trim(),
          world_prompt: worldPrompt.trim(),
          narrator_tone: tone,
        }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setError(body.error ?? t.errorSave)
        return
      }
      onWorldCreated(collectionId as number)
    } catch {
      setError(t.errorSave)
    } finally {
      setSaving(false)
    }
  }

  if (!address) {
    return (
      <div className="flex flex-col items-center gap-6 py-24">
        <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-violet-400/80">
          {t.walletRequired}
        </p>
        <p className="text-[11px] text-violet-300/60">{t.walletRequiredDesc}</p>
        <button
          type="button"
          disabled={connecting}
          onClick={() => void connect().catch(() => {})}
          className={BTN_PRIMARY}
        >
          {connecting ? t.connecting : t.connectWallet}
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <h2 className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.28em] text-violet-300">
        {t.createTitle}
      </h2>
      <p className="mb-8 text-[10px] leading-relaxed text-violet-400/60">{t.createSubtitle}</p>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
        {/* World name */}
        <div>
          <label className="mb-1.5 block text-[9px] uppercase tracking-widest text-zinc-500">
            {t.fieldWorldName}
          </label>
          <input
            type="text"
            value={worldName}
            onChange={(e) => setWorldName(e.target.value)}
            maxLength={80}
            placeholder={t.fieldWorldNameHint}
            disabled={saving}
            className={INPUT_BASE}
          />
          <p className="mt-1 text-right text-[9px] text-zinc-700">{worldName.length}/80</p>
        </div>

        {/* Collection select */}
        <div>
          <label className="mb-1.5 block text-[9px] uppercase tracking-widest text-zinc-500">
            {t.fieldCollection}
          </label>
          {loadingCollections ? (
            <p className="text-[10px] text-violet-400/50">{t.fieldCollectionLoading}</p>
          ) : availableIds.length === 0 ? (
            <div className="space-y-1">
              <p className="text-[10px] text-violet-400/50">{t.fieldCollectionNone}</p>
              <p className="text-[10px] text-violet-300/40">
                {t.fieldCollectionNoneHint}
                <Link href="/forge" className="text-violet-400 hover:text-violet-200 transition-colors">
                  {t.fieldCollectionForgeLink}
                </Link>
              </p>
            </div>
          ) : (
            <>
              <select
                value={collectionId}
                onChange={(e) => setCollectionId(e.target.value === "" ? "" : Number(e.target.value))}
                disabled={saving}
                className={INPUT_BASE + " cursor-pointer"}
              >
                <option value="">—</option>
                {availableIds.map((id) => (
                  <option key={id} value={id}>
                    Collection #{id}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[9px] text-zinc-700">{t.fieldCollectionHint}</p>
            </>
          )}
        </div>

        {/* Narrator tone */}
        <div>
          <label className="mb-1.5 block text-[9px] uppercase tracking-widest text-zinc-500">
            {t.fieldTone}
          </label>
          <select
            value={tone}
            onChange={(e) => setTone(e.target.value as NarratorTone)}
            disabled={saving}
            className={INPUT_BASE + " cursor-pointer"}
          >
            {(["enigmatic", "epic", "scientific", "folkloric"] as const).map((v) => (
              <option key={v} value={v}>
                {t.tones[v]}
              </option>
            ))}
          </select>
        </div>

        {/* Universe context */}
        <div>
          <label className="mb-1.5 block text-[9px] uppercase tracking-widest text-zinc-500">
            {t.fieldContext}
          </label>
          <textarea
            value={worldPrompt}
            onChange={(e) => setWorldPrompt(e.target.value)}
            maxLength={1000}
            rows={5}
            placeholder={t.fieldContextHint}
            disabled={saving}
            className={INPUT_BASE + " resize-none"}
          />
          <p className="mt-1 text-right text-[9px] text-zinc-700">{worldPrompt.length}/1000</p>

          {/* Live preview */}
          <div className="mt-3 border border-violet-500/20 bg-violet-950/10 p-3">
            <p className="mb-1.5 text-[8px] uppercase tracking-widest text-violet-500/50">
              {t.fieldContextPreviewLabel}
            </p>
            <p className="text-[11px] leading-relaxed text-violet-300/70 font-mono">
              {contextPreview}
            </p>
          </div>
        </div>

        {error && (
          <p className="text-[10px] text-red-400/80">{error}</p>
        )}

        <button
          type="submit"
          disabled={
            saving ||
            !worldName.trim() ||
            collectionId === "" ||
            !worldPrompt.trim() ||
            availableIds.length === 0
          }
          className={BTN_PRIMARY}
        >
          {saving ? t.ctaForging : t.ctaForge}
        </button>
      </form>
    </div>
  )
}

// ── Tab 3: MANAGE ──────────────────────────────────────────────────────────────
function ManageTab({
  worlds,
  onWorldUpdated,
  onNavigateCreate,
  t,
  lang,
}: {
  worlds: WorldsListItem[]
  onWorldUpdated: (w: WorldsListItem) => void
  onNavigateCreate: () => void
  t: CopyT
  lang: "en" | "es"
}) {
  const { address, connecting, connect } = useWallet()
  const [myCollectionIds, setMyCollectionIds] = useState<number[]>([])
  const [loadingCollections, setLoadingCollections] = useState(false)

  useEffect(() => {
    if (!address) return
    setLoadingCollections(true)
    fetchCreatorCollectionIds(address)
      .then(setMyCollectionIds)
      .catch(() => {})
      .finally(() => setLoadingCollections(false))
  }, [address])

  if (!address) {
    return (
      <div className="flex flex-col items-center gap-6 py-24">
        <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-violet-400/80">
          {t.walletRequired}
        </p>
        <p className="text-[11px] text-violet-300/60">{t.walletRequiredDesc}</p>
        <button
          type="button"
          disabled={connecting}
          onClick={() => void connect().catch(() => {})}
          className={BTN_PRIMARY}
        >
          {connecting ? t.connecting : t.connectWallet}
        </button>
      </div>
    )
  }

  if (loadingCollections) {
    return (
      <div className="py-16 text-center text-[10px] uppercase tracking-widest text-violet-500/40">
        [ LOADING… ]
      </div>
    )
  }

  const myWorldIds = new Set(myCollectionIds)
  const myWorlds = worlds.filter((w) => myWorldIds.has(w.collectionId))

  // Analytics
  const mostActive = myWorlds.reduce<WorldsListItem | null>(
    (best, w) => (best === null || w.narrativeCount > best.narrativeCount ? w : best),
    null,
  )
  const totalNarratives = myWorlds.reduce((sum, w) => sum + w.narrativeCount, 0)
  const lastNarrative = myWorlds
    .filter((w) => w.latestNarrative)
    .sort((a, b) => b.created_at - a.created_at)[0]?.latestNarrative ?? null

  return (
    <div className="space-y-10">
      <h2 className="text-[12px] font-bold uppercase tracking-[0.28em] text-violet-300">
        {t.manageTitle}
      </h2>

      {myWorlds.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-20">
          <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-violet-400/80">
            {t.manageEmpty}
          </p>
          <p className="text-[11px] text-violet-300/60">{t.manageEmptyDesc}</p>
          <button type="button" onClick={onNavigateCreate} className={BTN_PRIMARY}>
            {t.manageCreateLink}
          </button>
        </div>
      ) : (
        <ul className="space-y-4">
          {myWorlds.map((w) => (
            <ManageCard
              key={w.collectionId}
              world={w}
              onUpdated={onWorldUpdated}
              t={t}
              lang={lang}
            />
          ))}
        </ul>
      )}

      {/* Analytics strip */}
      {myWorlds.length > 0 && (
        <div className="border-t border-violet-400/20 pt-8">
          <h3 className="mb-5 text-[11px] font-bold uppercase tracking-[0.28em] text-violet-400">
            {t.analyticsTitle}
          </h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label={t.mostActive} value={mostActive?.world_name ?? t.none} />
            <Stat label={t.totalNarratives} value={String(totalNarratives)} />
            <Stat label={t.lastNarrative} value={lastNarrative ?? t.none} truncate />
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  truncate = false,
}: {
  label: string
  value: string
  truncate?: boolean
}) {
  return (
    <div className="border border-violet-500/20 bg-violet-950/10 p-4">
      <p className="mb-2 text-[9px] uppercase tracking-[0.22em] text-violet-500/60">{label}</p>
      <p
        className={[
          "text-[13px] font-medium text-violet-200 leading-snug",
          truncate ? "line-clamp-2" : "",
        ].join(" ")}
      >
        {value}
      </p>
    </div>
  )
}

// ── ManageCard with inline edit modal ─────────────────────────────────────────
function ManageCard({
  world,
  onUpdated,
  t,
  lang,
}: {
  world: WorldsListItem
  onUpdated: (w: WorldsListItem) => void
  t: CopyT
  lang: "en" | "es"
}) {
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(world.world_name)
  const [editPrompt, setEditPrompt] = useState(world.world_prompt)
  const [editTone, setEditTone] = useState<NarratorTone>(world.narrator_tone ?? "enigmatic")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when edit opens
  const openEdit = useCallback(() => {
    setEditName(world.world_name)
    setEditPrompt(world.world_prompt)
    setEditTone(world.narrator_tone ?? "enigmatic")
    setError(null)
    setEditing(true)
  }, [world])

  async function handleSave() {
    if (!editName.trim() || !editPrompt.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection_id: world.collectionId,
          world_name: editName.trim(),
          world_prompt: editPrompt.trim(),
          narrator_tone: editTone,
        }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setError(body.error ?? t.errorSave)
        return
      }
      onUpdated({ ...world, world_name: editName.trim(), world_prompt: editPrompt.trim(), narrator_tone: editTone })
      setEditing(false)
    } catch {
      setError(t.errorSave)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="list-none border border-violet-500/25 bg-black/40 p-4">
      {!editing ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5 min-w-0">
            <p className="text-[14px] font-medium text-violet-100">{world.world_name}</p>
            <p className="text-[11px] text-violet-300/60 line-clamp-2 max-w-lg">{world.world_prompt}</p>
            <div className="flex flex-wrap gap-3 text-[10px] uppercase tracking-[0.15em] text-violet-500/60">
              <span>{t.collectionLabel} · #{world.collectionId}</span>
              <span>{t.narrativesLabel} · {world.narrativeCount}</span>
              {world.narrator_tone && (
                <span className="border border-violet-500/25 px-1.5 py-0.5 text-[8px]">
                  {world.narrator_tone.toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={openEdit} className={BTN_GHOST}>
              {t.editBtn}
            </button>
            <Link href={`/world/${world.collectionId}`} className={BTN_GHOST}>
              {t.viewBtn}
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-[9px] uppercase tracking-widest text-zinc-500">
              {t.fieldWorldName}
            </label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={80}
              disabled={saving}
              className={INPUT_BASE}
            />
          </div>
          <div>
            <label className="mb-1 block text-[9px] uppercase tracking-widest text-zinc-500">
              {t.fieldTone}
            </label>
            <select
              value={editTone}
              onChange={(e) => setEditTone(e.target.value as NarratorTone)}
              disabled={saving}
              className={INPUT_BASE + " cursor-pointer"}
            >
              {(["enigmatic", "epic", "scientific", "folkloric"] as const).map((v) => (
                <option key={v} value={v}>{t.tones[v]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[9px] uppercase tracking-widest text-zinc-500">
              {t.fieldContext}
            </label>
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              maxLength={1000}
              rows={4}
              disabled={saving}
              className={INPUT_BASE + " resize-none"}
            />
          </div>
          {error && <p className="text-[10px] text-red-400/80">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !editName.trim() || !editPrompt.trim()}
              className={BTN_PRIMARY}
            >
              {saving ? t.savingBtn : t.saveBtn}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className={BTN_GHOST}
            >
              {t.cancelBtn}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
