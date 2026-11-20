"use client"

import { useEffect, useState } from "react"
import { isFeatureEnabled } from "@/lib/feature-flags"
import type { ExplorerMetadataStatus } from "@/lib/explorer-metadata"

export type ExplorerMetadataBadgeProps = {
  collectionId?: number
  committedDigest?: string
}

type BadgeState = {
  verified: boolean
  stale: boolean
  status: ExplorerMetadataStatus
}

export function ExplorerMetadataBadge({ collectionId, committedDigest }: ExplorerMetadataBadgeProps) {
  const enabled = isFeatureEnabled("phase-250")
  const [state, setState] = useState<BadgeState | null>(null)

  useEffect(() => {
    if (!enabled || !collectionId || collectionId <= 0) {
      setState(null)
      return
    }
    const controller = new AbortController()
    const params = new URLSearchParams({ collection_id: String(collectionId) })
    if (committedDigest) params.set("digest", committedDigest)

    void fetch(`/api/explorer-verify?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as { verified?: boolean; stale?: boolean; status?: ExplorerMetadataStatus }
        setState({
          verified: Boolean(data.verified) && !data.stale && data.status === "verified",
          stale: Boolean(data.stale),
          status: data.status ?? "unavailable",
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ verified: false, stale: false, status: "unavailable" })
        }
      })

    return () => controller.abort()
  }, [enabled, collectionId, committedDigest])

  if (!enabled || !collectionId || !state) return null

  if (state.verified && !state.stale) {
    return (
      <span
        data-testid="explorer-verified-badge"
        className="inline-flex items-center rounded border border-emerald-500/50 bg-emerald-950/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300"
      >
        Explorer Verified
      </span>
    )
  }

  if (state.stale) {
    return (
      <span
        data-testid="explorer-stale-badge"
        className="inline-flex items-center rounded border border-amber-500/50 bg-amber-950/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300"
      >
        Metadata Stale
      </span>
    )
  }

  return null
}
