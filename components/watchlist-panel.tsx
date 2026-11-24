"use client"

import { useCallback, useEffect, useState } from "react"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { pickCopy, type AppLang } from "@/lib/phase-copy"
import type { WatchlistItem } from "@/lib/watchlist-store"

export interface WatchlistPanelProps {
  wallet?: string
  lang?: AppLang
}

export function WatchlistPanel({ wallet, lang = "en" }: WatchlistPanelProps) {
  const enabled = isFeatureEnabled("phase-255", wallet ? { wallet } : undefined)
  const copy = pickCopy(lang).watchlist

  const [items, setItems] = useState<WatchlistItem[]>([])
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled || !wallet) return
    const res = await fetch(`/api/watchlist?lang=${lang}`, { cache: "no-store" })
    if (!res.ok) return
    const data = (await res.json()) as { items?: WatchlistItem[]; version?: number }
    setItems(data.items ?? [])
    setVersion(data.version ?? 0)
  }, [enabled, wallet, lang])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleRemove = async (collectionId: number, tokenId: number) => {
    setError(null)
    const res = await fetch(`/api/watchlist?lang=${lang}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collectionId, tokenId, expectedVersion: version }),
    })
    if (res.status === 409) {
      setError(copy.conflictError)
      await refresh()
      return
    }
    if (res.ok) {
      const data = (await res.json()) as { items?: WatchlistItem[]; version?: number }
      setItems(data.items ?? [])
      setVersion(data.version ?? version + 1)
    }
  }

  // Flag off = watchlist UI hidden
  if (!enabled) return null

  return (
    <section
      data-testid="watchlist-panel"
      className="rounded-xl border border-zinc-800 bg-zinc-950/90 p-4 text-xs text-zinc-200 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-zinc-100">{copy.title}</h3>
        <span className="font-mono text-[11px] text-zinc-500">v{version}</span>
      </div>

      {error && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-300">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-zinc-500">{copy.emptyState}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.itemKey}
              className="flex items-center justify-between rounded border border-zinc-800/80 bg-zinc-900/60 px-3 py-2"
            >
              <div className="space-y-0.5">
                <div className="font-mono font-medium text-zinc-100">
                  #{item.collectionId}:{item.tokenId}
                </div>
                <div className="text-[11px] text-zinc-400">
                  {item.targetPrice !== undefined
                    ? `${copy.targetPriceLabel}: ${item.targetPrice}`
                    : item.dropThresholdPct !== undefined
                      ? `${copy.dropPctLabel}: ${item.dropThresholdPct}%`
                      : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={
                    item.armed
                      ? "rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300"
                      : "rounded bg-violet-500/15 px-2 py-0.5 text-[11px] text-violet-300"
                  }
                >
                  {item.armed ? copy.armedStatus : copy.alertedStatus}
                </span>
                <button
                  type="button"
                  onClick={() => void handleRemove(item.collectionId, item.tokenId)}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                >
                  {copy.removeAction}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
