"use client"

import { useEffect, useRef, useState } from "react"

interface AnimatedNoiseProps {
  opacity?: number
  className?: string
}

const GRAIN_SVG =
  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

export function AnimatedNoise({ opacity = 0.05, className }: AnimatedNoiseProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(true)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)")
    setPrefersReducedMotion(mql.matches)

    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches)
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const shouldAnimate = isVisible && !prefersReducedMotion

  return (
    <div
      ref={containerRef}
      className={className}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity: shouldAnimate ? opacity : 0,
        mixBlendMode: "overlay",
        backgroundImage: GRAIN_SVG,
        backgroundRepeat: "repeat",
        backgroundSize: "256px 256px",
        animation: shouldAnimate
          ? "animated-noise-drift 0.35s steps(4) infinite"
          : "none",
      }}
    />
  )
}
