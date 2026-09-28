"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { nftGridOverscanPx } from "@/lib/nft-grid-virtualization"

// ??? phase-117: multi-gateway fallback client wiring ????????????????????????
// Preserves original lazy-load + initials fallback. When an image fails,
// tries alternate gateways for the same CID (redundancy).

const FALLBACK_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs",
  "https://w3s.link/ipfs",
  "https://dweb.link/ipfs",
  "https://ipfs.io/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
] as const

function extractCidPath(url: string): string | null {
  const m = url.match(/\/ipfs\/([A-Za-z0-9._\/-]+)/)
  if (m) return m[1]!
  const n = url.match(/ipfs:\/\/([A-Za-z0-9._\/-]+)/)
  if (n) return n[1]!
  return null
}

function buildFallbackUrls(original: string): string[] {
  const cidPath = extractCidPath(original)
  if (!cidPath) return []
  // rotate gateways that aren't already the current one
  const currentGw = original.match(/(https:\/\/[^\/]+\/ipfs)/)?.[1] ?? ""
  return FALLBACK_GATEWAYS.filter((g) => !original.startsWith(g) && g !== currentGw).map((g) => `${g}/${cidPath}`)
}

type AvatarData = {
  tokenId: number
  image?: string
  name: string
  locale?: string
}

// phase-137: structured error taxonomy — the avatar route may answer with
// { code, category, retryable } instead of a bare { avatar: null }. A retryable
// code (upstream timeout / unreachable gateway) earns one silent retry before
// the component settles on initials.
type AvatarErrorEnvelope = {
  avatar: AvatarData | null
  code?: string
  category?: string
  retryable?: boolean
}

async function fetchAvatarOnce(wallet: string, signal: AbortSignal): Promise<AvatarErrorEnvelope> {
  const r = await fetch(`/api/profile/avatar?wallet=${encodeURIComponent(wallet)}`, { signal })
  const data = (await r.json().catch(() => ({ avatar: null }))) as AvatarErrorEnvelope
  return data
}

function getInitials(wallet: string, displayName?: string): string {
  if (displayName?.trim()) {
    const words = displayName.trim().split(/\s+/)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return displayName.slice(0, 2).toUpperCase()
  }
  return wallet.slice(1, 3).toUpperCase()
}

type WalletAvatarProps = {
  wallet: string
  displayName?: string
  size?: number
  className?: string
}

export function WalletAvatar({
  wallet,
  displayName,
  size = 32,
  className = "",
}: WalletAvatarProps) {
  const [avatar, setAvatar] = useState<AvatarData | null>(null)
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(false)
  const [fallbackIndex, setFallbackIndex] = useState(0)
  const [fallbackUrls, setFallbackUrls] = useState<string[]>([])
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // IntersectionObserver for lazy loading.
  // phase-157 (Module #57): widen the overscan margin when grid virtualization
  // is enabled so avatars in a large scrolling grid mount just ahead of view
  // instead of all at once (or too late). Falls back to the legacy 50px.
  useEffect(() => {
    if (!ref.current) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: `${nftGridOverscanPx()}px` }
    )

    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])

  // Fetch avatar when visible
  useEffect(() => {
    if (!visible || !wallet) return

    const controller = new AbortController()
    let aborted = false
    setLoading(true)
    setFallbackIndex(0)
    setFallbackUrls([])
    setErrorCode(null)

    ;(async () => {
      try {
        let data = await fetchAvatarOnce(wallet, controller.signal)
        // phase-137: one silent retry when the taxonomy flags a retryable upstream blip
        if (!data.avatar && data.retryable) {
          setErrorCode(data.code ?? null)
          await new Promise((resolve) => setTimeout(resolve, 400))
          if (aborted) return
          data = await fetchAvatarOnce(wallet, controller.signal)
        }
        if (aborted) return
        setAvatar(data.avatar)
        setErrorCode(data.avatar ? null : data.code ?? null)
        if (data.avatar?.image) {
          setFallbackUrls(buildFallbackUrls(data.avatar.image))
        }
      } catch {
        // Silently fail - will show initials
      } finally {
        if (!aborted) setLoading(false)
      }
    })()

    return () => {
      aborted = true
      controller.abort()
    }
  }, [visible, wallet])

  const handleImgError = useCallback(() => {
    if (fallbackIndex < fallbackUrls.length && avatar?.image) {
      const nextUrl = fallbackUrls[fallbackIndex]
      setFallbackIndex((i) => i + 1)
      setAvatar((prev) => (prev ? { ...prev, image: nextUrl } : prev))
    }
  }, [fallbackIndex, fallbackUrls, avatar?.image])

  const initials = getInitials(wallet, displayName)
  const hasImage = avatar?.image && avatar.image.length > 0

  // Loading state: pulsing gray circle
  if (loading) {
    return (
      <div
        ref={ref}
        className={`shrink-0 rounded-full bg-zinc-800 animate-pulse ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  // Has NFT image: show circular image (phase-117: fallback on error)
  if (hasImage) {
    return (
      <div
        ref={ref}
        className={`shrink-0 rounded-full overflow-hidden border border-violet-700/40 ${className}`}
        style={{ width: size, height: size }}
        title={avatar?.locale ? `${avatar.name} (${avatar.locale})` : avatar?.name}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatar.image}
          alt={avatar.name}
          className="w-full h-full object-cover"
          onError={handleImgError}
          loading="lazy"
        />
      </div>
    )
  }

  // No NFT: show initials circle
  const fontSize = Math.max(8, Math.floor(size * 0.35))
  return (
    <div
      ref={ref}
      className={`shrink-0 rounded-full flex items-center justify-center font-bold text-white ${className}`}
      style={{
        width: size,
        height: size,
        background: "#534AB7",
        fontSize: `${fontSize}px`,
      }}
      data-avatar-error={errorCode ?? undefined}
      title={errorCode ? `Avatar unavailable (${errorCode})` : undefined}
    >
      {initials}
    </div>
  )
}