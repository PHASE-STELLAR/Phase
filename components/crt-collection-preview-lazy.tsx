"use client"

/**
 * Issue #728: Lazy-loaded CRT collection preview with intersection-based loading,
 * hover prefetch, and a static placeholder to prevent layout shift.
 *
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_270 / FEATURE_PHASE_270
 * Rollback: unset the flag — eager import restored; no persisted state.
 */

import { Suspense, lazy, useEffect, useRef, useState, type CSSProperties } from "react"
import { isFeatureEnabled } from "@/lib/feature-flags"

// Static placeholder matching the preview's outer container to prevent CLS
const PLACEHOLDER_STYLE: CSSProperties = {
  backgroundColor: "#050508",
  minHeight: "100dvh",
  width: "100%",
}

function CrtPreviewPlaceholder() {
  return (
    <div style={PLACEHOLDER_STYLE} aria-busy="true" aria-label="Loading preview" />
  )
}

// Eager import used when the flag is off (legacy behavior)
import { CrtCollectionPreview } from "@/components/crt-collection-preview"

// Lazy import used when the flag is on
const LazyCrtCollectionPreview = lazy(() =>
  import("@/components/crt-collection-preview").then((m) => ({
    default: m.CrtCollectionPreview,
  }))
)

type Props = React.ComponentProps<typeof CrtCollectionPreview>

export function CrtCollectionPreviewLazy(props: Props) {
  const [shouldLoad, setShouldLoad] = useState(false)
  const [prefetched, setPrefetched] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const flagOn = isFeatureEnabled("phase-270" as any)

  // Flag off: static (eager) preview only, no lazy loading
  if (!flagOn) {
    return <CrtCollectionPreview {...props} />
  }

  // Flag on: intersection-gated lazy load with hover prefetch
  return (
    <div
      ref={containerRef}
      onMouseEnter={() => {
        if (!prefetched) {
          // Prefetch the chunk on hover intent
          import("@/components/crt-collection-preview")
          setPrefetched(true)
        }
      }}
    >
      <LazyLoadTrigger
        onVisible={() => setShouldLoad(true)}
        shouldLoad={shouldLoad}
        props={props}
      />
    </div>
  )
}

function LazyLoadTrigger({
  onVisible,
  shouldLoad,
  props,
}: {
  onVisible: () => void
  shouldLoad: boolean
  props: Props
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current || shouldLoad) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onVisible()
            observer.disconnect()
            break
          }
        }
      },
      { rootMargin: "200px" }
    )
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [onVisible, shouldLoad])

  if (!shouldLoad) {
    return (
      <div ref={ref}>
        <CrtPreviewPlaceholder />
      </div>
    )
  }

  return (
    <Suspense fallback={<CrtPreviewPlaceholder />}>
      <LazyCrtCollectionPreview {...props} />
    </Suspense>
  )
}
