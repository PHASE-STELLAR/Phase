import { useRouter } from "next/navigation"
import { useCallback, useEffect } from "react"
import { isFeatureEnabled } from "@/lib/feature-flags"

interface PrefetchConfig {
  enabled?: boolean
  delay?: number
}

const prefetchedRoutes = new Set<string>()

export function canPrefetchSameOriginUrl(rawHref: string, origin: string): string | null {
  try {
    const url = new URL(rawHref, origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.origin !== origin) return null
    if (isFeatureEnabled("phase-248") && url.pathname.startsWith("/link/")) return null
    return url.pathname + url.search
  } catch {
    return null
  }
}

export function useLinkPrefetch(config: PrefetchConfig = {}) {
  const { enabled = true, delay = 50 } = config
  const router = useRouter()

  const prefetchRoute = useCallback(
    (href: string) => {
      if (!enabled || prefetchedRoutes.has(href)) return

      const timeoutId = setTimeout(() => {
        try {
          router.prefetch(href)
          prefetchedRoutes.add(href)
        } catch {
          // Prefetch failed silently
        }
      }, delay)

      return () => clearTimeout(timeoutId)
    },
    [router, enabled, delay]
  )

  const setupIntentBasedPrefetch = useCallback(() => {
    if (!enabled) return

    const maybePrefetchTarget = (target: EventTarget | null) => {
      const link = (target as HTMLElement | null)?.closest("a[href]") as HTMLAnchorElement | null
      if (!link?.href) return
      const path = canPrefetchSameOriginUrl(link.href, window.location.origin)
      if (path) prefetchRoute(path)
    }

    const handleLinkHover = (e: MouseEvent) => maybePrefetchTarget(e.target)
    const handleTouchStart = (e: TouchEvent) => maybePrefetchTarget(e.target)

    document.addEventListener("mouseover", handleLinkHover, { passive: true })
    document.addEventListener("touchstart", handleTouchStart, { passive: true })

    return () => {
      document.removeEventListener("mouseover", handleLinkHover)
      document.removeEventListener("touchstart", handleTouchStart)
    }
  }, [enabled, prefetchRoute])

  useEffect(() => {
    const cleanup = setupIntentBasedPrefetch()
    return cleanup
  }, [setupIntentBasedPrefetch])

  return { prefetchRoute }
}

export function useRoutePreload(routes: string[], options: PrefetchConfig = {}) {
  const { prefetchRoute } = useLinkPrefetch(options)

  useEffect(() => {
    routes.forEach((route) => {
      prefetchRoute(route)
    })
  }, [routes, prefetchRoute])
}
