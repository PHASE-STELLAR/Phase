"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { LangToggle } from "@/components/lang-toggle"
import { useLang } from "@/components/lang-context"
import { PhaseProtectedPreview } from "@/components/phase-protected-preview"
import { useWallet } from "@/components/wallet-provider"
import { ExploreErrorBoundary } from "@/components/explore-error-boundary"
import { cn } from "@/lib/utils"
import {
  filterWorldOnly,
  parseExploreResponse,
  type ExploreItem,
  type ExploreResponse,
  type ExploreValidationError,
} from "@/lib/explore-domain"
import { useToastQueue } from "@/hooks/use-toast-queue"

const navLink =
  "inline-flex min-h-[36px] items-center border-2 border-cyan-400/50 bg-cyan-950/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-cyan-100 shadow-[0_0_14px_rgba(34,211,238,0.12)] transition-colors hover:border-cyan-300 hover:bg-cyan-900/40 hover:text-white"

const PREVIEW_LABELS = {
  pendingFusion: "[ PREVIEW_ONLY ]",
  unverifiedCopy: "[ UNVERIFIED ]",
  chainVerifiedSeal: "[ VERIFIED ]",
}

const perPage = 24

function SkeletonCard() {
  return (
    <div className="flex flex-col border-2 border-cyan-500/20 bg-black/40 animate-pulse">
      <div className="aspect-[4/3] w-full bg-cyan-950/40" />
      <div className="flex flex-col gap-2 p-3">
        <div className="h-3 w-3/4 rounded bg-cyan-900/50" />
        <div className="h-2.5 w-1/2 rounded bg-cyan-900/30" />
        <div className="h-2 w-1/3 rounded bg-cyan-900/20" />
      </div>
    </div>
  )
}

export default function ExplorePage() {
  const { lang } = useLang()
  const { address } = useWallet()

  const [data, setData] = useState<ExploreResponse | null>(null)
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle")
  const [page, setPage] = useState(1)
  const [worldOnly, setWorldOnly] = useState(false)
  const toasts = useToastQueue()
  // Monotonic request id guard: only the most recent request may commit state,
  // so a slow, stale response can no longer overwrite a newer snapshot.
  const loadSeq = useRef(0)

  const load = useCallback(async (p: number) => {
    const seq = ++loadSeq.current
    setLoadState("loading")
    try {
      const res = await fetch(`/api/explore?page=${p}&perPage=${perPage}`, { cache: "no-store" })
      if (!res.ok) {
        if (seq === loadSeq.current) {
          setLoadState("error")
          toasts.error(`RPC_ERROR_HTTP_${res.status}`, { title: "EXPLORE" })
        }
        return
      }
      // Type-safe schema validation in the isolated domain module.
      const json = parseExploreResponse(await res.json())
      if (seq !== loadSeq.current) return
      setData(json)
      setLoadState("idle")
    } catch (err) {
      if (seq !== loadSeq.current) return
      setLoadState("error")
      const isValidation = (err as ExploreValidationError)?.code === "EXPLORE_VALIDATION_ERROR"
      toasts.error(isValidation ? "SCHEMA_REJECTED" : "RPC_ERROR_UNTYPED", { title: "EXPLORE" })
    }
  }, [perPage, toasts])

  useEffect(() => {
    void load(page)
  }, [load, page])

  const totalPages = data ? Math.max(1, Math.ceil(data.total / perPage)) : 1
  const isEs = lang === "es"

  const visibleItems = worldOnly ? filterWorldOnly(data?.items ?? []) : (data?.items ?? [])

  return (
    <div className="min-h-screen bg-background font-mono text-foreground">
      <div className="grid-bg pointer-events-none fixed inset-0 opacity-40" aria-hidden />

      {/* Header */}
      <header className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b-4 border-double border-cyan-400/55 px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/" className={navLink}>
            {isEs ? "← Inicio" : "← Home"}
          </Link>
        </div>
        <span className="text-center text-[10px] font-bold uppercase tracking-[0.28em] text-cyan-200">
          ◈ PHASE · {isEs ? "EXPLORAR" : "EXPLORE"}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <LangToggle variant="phosphor" />
          <Link href="/world" className={navLink}>
            {isEs ? "Mundos" : "World"}
          </Link>
          <Link href="/forge" className={navLink}>
            {isEs ? "Forja" : "Forge"}
          </Link>
          <Link href="/dashboard" className={navLink}>
            {isEs ? "Mercado" : "Market"}
          </Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-7xl px-4 py-10 md:py-12">
        <div className="border-4 border-double border-cyan-400/55 bg-[oklch(0.05_0_0)] shadow-[0_0_32px_rgba(0,255,255,0.06)]">

          {/* Page title bar */}
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-cyan-400/30 px-6 py-5 md:px-8">
            <div>
              <h1 className="tactical-phosphor text-[13px] font-bold uppercase tracking-[0.28em] text-cyan-200">
                ◈ {isEs ? "ARTEFACTOS DE LA COMUNIDAD" : "COMMUNITY_ARTIFACTS"}
              </h1>
              <p className="mt-1.5 max-w-xl text-[10px] leading-relaxed text-cyan-300/70">
                {isEs
                  ? "NFTs minteados en el protocolo PHASE. Las imágenes están protegidas — conectá tu wallet en Chamber para ver la versión sin marca de agua."
                  : "NFTs minted on the PHASE protocol. Images are protected — connect your wallet in Chamber to see the unwatermarked version."}
              </p>
            </div>

            {data && (
              <div className="flex flex-col items-end gap-1 text-right">
                <p className="text-[9px] uppercase tracking-[0.22em] text-cyan-500/60">
                  {isEs ? "TOTAL ESTABILIZADOS" : "TOTAL STABILIZED"}
                </p>
                <p className="text-[22px] font-bold leading-none tracking-tight text-cyan-300">
                  {data.total}
                </p>
                <p className="text-[9px] uppercase tracking-widest text-cyan-500/50">
                  {isEs ? `PÁG. ${page} / ${totalPages}` : `PAGE ${page} / ${totalPages}`}
                </p>
                {data.quest_expiry_windows_enabled && (
                  <p className="text-[8px] uppercase tracking-widest text-cyan-500/40">
                    {isEs ? "· ventanas de expiración activas" : "· expiry windows active"}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Filter bar */}
          <div className="flex items-center gap-3 border-b border-cyan-400/20 px-6 py-3 md:px-8">
            <span className="text-[9px] uppercase tracking-[0.22em] text-cyan-500/60">
              {isEs ? "FILTRAR" : "FILTER"}
            </span>
            <button
              type="button"
              onClick={() => setWorldOnly((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 border px-2.5 py-1 text-[9px] uppercase tracking-widest transition-colors",
                worldOnly
                  ? "border-cyan-400/70 bg-cyan-900/50 text-cyan-200 shadow-[0_0_10px_rgba(34,211,238,0.15)]"
                  : "border-cyan-500/30 bg-transparent text-cyan-500/60 hover:border-cyan-400/50 hover:text-cyan-400",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full transition-colors",
                  worldOnly ? "bg-cyan-400" : "bg-cyan-700",
                )}
              />
              {isEs ? "Mundos narrativos" : "Narrative worlds"}
            </button>
            {worldOnly && (
              <button
                type="button"
                onClick={() => setWorldOnly(false)}
                className="text-[9px] uppercase tracking-widest text-cyan-500/50 hover:text-cyan-400 transition-colors"
              >
                {isEs ? "× limpiar" : "× clear"}
              </button>
            )}
          </div>

          {/* Content */}
          <div className="p-6 md:p-8">
            {/* Skeleton loading */}
            {loadState === "loading" && (
              <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            )}

            {loadState === "error" && (
              <div className="flex flex-col items-center justify-center gap-3 py-20">
                <p className="font-mono text-[10px] uppercase tracking-widest text-red-400/90">
                  {isEs ? "[ ERROR_RPC — REINTENTÁ ]" : "[ RPC_ERROR — RETRY ]"}
                </p>
                <button
                  type="button"
                  onClick={() => void load(page)}
                  className={navLink}
                >
                  {isEs ? "Reintentar" : "Retry"}
                </button>
              </div>
            )}

            {loadState === "idle" && data && visibleItems.length === 0 && (
              <p className="py-10 text-center font-mono text-[10px] uppercase tracking-widest text-cyan-500/60">
                {isEs ? "NO_SE_DETECTAN_ARTEFACTOS" : "NO_ARTIFACTS_DETECTED"}
              </p>
            )}

            {loadState === "idle" && data && visibleItems.length > 0 && (
              <>
                <ExploreErrorBoundary>
                  <ul className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                    {visibleItems.map((item) => (
                      <ArtifactCard
                        key={item.tokenId}
                        item={item}
                        address={address}
                        isEs={isEs}
                      />
                    ))}
                  </ul>
                </ExploreErrorBoundary>

                {totalPages > 1 && (
                  <div className="mt-8 flex items-center justify-center gap-4">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => { setPage((p) => Math.max(1, p - 1)); window.scrollTo({ top: 0, behavior: "smooth" }) }}
                      className={cn(navLink, "disabled:cursor-not-allowed disabled:opacity-40")}
                    >
                      ← {isEs ? "Ant." : "Prev"}
                    </button>
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-400/80">
                      {page} / {totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={page >= totalPages}
                      onClick={() => { const next = Math.min(totalPages, page + 1); setPage(next); toasts.info(`${isEs ? "Cargando página" : "Loading page"} ${next}`, { title: "EXPLORE" }); window.scrollTo({ top: 0, behavior: "smooth" }) }}
                      className={cn(navLink, "disabled:cursor-not-allowed disabled:opacity-40")}
                    >
                      {isEs ? "Sig." : "Next"} →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function ArtifactCard({
  item,
  address,
  isEs,
}: {
  item: ExploreItem
  address: string | null | undefined
  isEs: boolean
}) {
  const hasCollectionLink = item.collectionId != null && item.collectionId > 0

  return (
    <li className="group flex flex-col border-2 border-cyan-500/30 bg-black/50 transition-all duration-200 hover:border-cyan-400/60 hover:shadow-[0_0_20px_rgba(34,211,238,0.08)]">
      {/* Image — links to detail page */}
      <Link
        href={`/collection/${item.tokenId}`}
        className="relative block border-b border-cyan-500/20 transition-opacity group-hover:opacity-95"
        tabIndex={0}
        aria-label={`Ver artefacto ${item.name}`}
      >
        <PhaseProtectedPreview
          uri={item.image}
          ownerTruncated={item.ownerTruncated}
          viewerAddress={address}
          labels={PREVIEW_LABELS}
        />
        {/* Hover overlay */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/30 group-hover:opacity-100">
          <span className="border border-cyan-400/60 bg-black/70 px-2 py-1 text-[9px] uppercase tracking-widest text-cyan-300">
            {isEs ? "Ver detalle" : "View detail"}
          </span>
        </div>
      </Link>

      {/* Metadata */}
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <Link
          href={`/collection/${item.tokenId}`}
          className="line-clamp-2 text-[11px] font-semibold uppercase tracking-wide text-cyan-50 transition-colors hover:text-cyan-300"
        >
          {item.name}
        </Link>

        <p className="tactical-phosphor text-[9px] font-bold uppercase tracking-wider text-cyan-500">
          #{item.tokenId}
        </p>

        {item.worldName && (
          <span className="inline-block w-fit border border-cyan-400/40 bg-cyan-950/50 px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-cyan-400">
            ◈ {item.worldName}
          </span>
        )}

        {item.duplicateOfTokenId && (
          <span className="inline-block w-fit border border-amber-400/40 bg-amber-950/30 px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-amber-300">
            {isEs ? `Duplicado de #${item.duplicateOfTokenId}` : `Duplicate of #${item.duplicateOfTokenId}`}
          </span>
        )}

        <p className="mt-auto pt-1.5 text-[9px] text-cyan-500/60">
          {isEs ? "Titular" : "Holder"}{" "}
          <span className="font-mono text-cyan-300/70">{item.ownerTruncated}</span>
        </p>

        {hasCollectionLink && (
          <div className="pt-1">
            <Link
              href={`/chamber?collection=${item.collectionId}`}
              className={cn(
                "inline-flex w-full items-center justify-center border border-cyan-500/35 bg-cyan-950/30 px-2 py-1.5 text-[9px] uppercase tracking-widest text-cyan-400 transition-colors hover:border-cyan-400/60 hover:bg-cyan-900/30 hover:text-cyan-200",
              )}
            >
              {isEs ? "Abrir Chamber" : "Open Chamber"}
            </Link>
          </div>
        )}
      </div>
    </li>
  )
}
