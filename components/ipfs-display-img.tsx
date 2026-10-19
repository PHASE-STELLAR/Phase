"use client"

import Image from "next/image"
import { ipfsHttpsGatewayUrls } from "@/lib/phase-protocol"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { useEffect, useMemo, useState, type ReactNode } from "react"

type Props = {
  uri: string
  alt?: string
  className?: string
  loading?: "lazy" | "eager"
  variant?: "thumbnail" | "preview" | "og" | "square" | "landscape"
  focalPoint?: { x: number; y: number }
  /** Se llama cuando ningún gateway devolvió imagen válida. */
  onExhausted?: () => void
  /**
   * Rendered in place of the image when the URI is empty or every gateway
   * failed. Without it the component renders nothing, which collapses a slot
   * in an ordered hang (phase-142) and shifts every later work.
   */
  fallback?: ReactNode
  priority?: boolean
  sizes?: string
  width?: number
  height?: number
}

export function IpfsDisplayImg({ uri, alt = "", className, loading = "lazy", variant, focalPoint, onExhausted, priority, sizes, width = 640, height = 640 }: Props) {
  const candidates = useMemo(() => {
    const urls = ipfsHttpsGatewayUrls(uri)
    if (!variant) return urls
    return urls.map((u) => {
      const glue = u.includes("?") ? "&" : "?"
      const fx = focalPoint?.x !== undefined ? `&fx=${focalPoint.x.toFixed(2)}` : ""
      const fy = focalPoint?.y !== undefined ? `&fy=${focalPoint.y.toFixed(2)}` : ""
      return `${u}${glue}variant=${variant}${fx}${fy}`
    })
  }, [uri, variant, focalPoint])
  const [idx, setIdx] = useState(0)
  const [exhausted, setExhausted] = useState(false)

  useEffect(() => {
    setIdx(0)
    setExhausted(false)
  }, [uri])

  const src = candidates[idx] ?? ""

  if (!uri.trim() || !src || exhausted) return fallback ? <>{fallback}</> : null

  const optimized = isFeatureEnabled("phase-171")

  return optimized ? (
    <Image
      key={`${uri}:${idx}`}
      src={src}
      alt={alt}
      className={className}
      width={width}
      height={height}
      sizes={sizes ?? "(max-width: 768px) 100vw, 33vw"}
      priority={priority}
      loading={priority ? "eager" : loading}
      decoding="async"
      unoptimized={false}
      style={{ objectFit: "cover", aspectRatio: `${width} / ${height}` }}
      referrerPolicy="no-referrer"
      onError={() => {
        if (idx + 1 < candidates.length) setIdx((i) => i + 1)
        else {
          if (fallback) setExhausted(true)
          onExhausted?.()
        }
      }}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- legacy flag-off path
    <img
      key={`${uri}:${idx}`}
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      referrerPolicy="no-referrer"
      onError={() => {
        if (idx + 1 < candidates.length) {
          setIdx((i) => i + 1)
        } else {
          if (fallback) setExhausted(true)
          onExhausted?.()
        }
      }}
    />
  )
}
