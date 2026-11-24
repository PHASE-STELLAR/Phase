"use client"

import { useEffect, useState } from "react"
import { useLang } from "@/components/lang-context"
import { pickCopy } from "@/lib/phase-copy"
import {
  buildExplorerUrl,
  isExplorerEnabled,
  type TxEnrichment,
} from "@/lib/explorer-links"
import { cn } from "@/lib/utils"

type Props = {
  /** Public transaction hash. No wallet address or memo is ever sent. */
  hash: string
  compact?: boolean
}

type State =
  | { phase: "loading" }
  | { phase: "ready"; data: TxEnrichment }
  | { phase: "unavailable" }

/**
 * phase-220 — explorer link + read-only enrichment with graceful fallback.
 * With the flag off it renders the raw hash and nothing else.
 */
export function ExplorerEnrichmentPanel({ hash, compact = false }: Props) {
  const { lang } = useLang()
  const copy = pickCopy(lang).gatedIntegrations.explorer
  const [enabled, setEnabled] = useState(false)
  const [state, setState] = useState<State>({ phase: "loading" })
  const [href, setHref] = useState<string | null>(null)

  useEffect(() => {
    const active = isExplorerEnabled()
    setEnabled(active)
    if (!active) return
    const link = buildExplorerUrl({ entity: "tx", id: hash })
    setHref(link.ok ? link.url : null)

    const controller = new AbortController()
    setState({ phase: "loading" })
    void fetch(`/api/explorer/enrichment?kind=tx&id=${encodeURIComponent(hash)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => (res.ok ? ((await res.json()) as { ok: boolean; data?: TxEnrichment }) : null))
      .then((payload) => {
        if (controller.signal.aborted) return
        if (payload?.ok && payload.data) setState({ phase: "ready", data: payload.data })
        else setState({ phase: "unavailable" })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ phase: "unavailable" })
      })
    return () => controller.abort()
  }, [hash])

  if (!enabled) {
    return (
      <code className={cn("block break-all font-mono text-[9px] text-cyan-300/70", compact && "text-[8px]")}>
        {hash}
      </code>
    )
  }

  return (
    <div
      className={cn(
        "rounded border border-cyan-500/30 bg-cyan-950/20 px-2 py-1.5 font-mono text-[9px] text-cyan-200",
        compact && "text-[8px]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="uppercase tracking-widest text-cyan-300/80">{copy.enrichmentTitle}</span>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
            {copy.viewOnExpert}
          </a>
        ) : null}
      </div>
      <code className="mt-1 block break-all text-cyan-100/85">{hash}</code>
      {state.phase === "loading" ? <p className="mt-1 text-cyan-300/70">{copy.enrichmentLoading}</p> : null}
      {state.phase === "ready" ? (
        <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-cyan-100/80">
          <dt className="text-cyan-300/70">{copy.enrichmentStatus}:</dt>
          <dd>{state.data.successful ? "OK" : "FAILED"}</dd>
          <dt className="text-cyan-300/70">{copy.enrichmentLedger}:</dt>
          <dd className="tabular-nums">{state.data.ledger}</dd>
        </dl>
      ) : null}
      {state.phase === "unavailable" ? (
        <p className="mt-1 text-amber-300/85">{copy.enrichmentUnavailable}</p>
      ) : null}
    </div>
  )
}
