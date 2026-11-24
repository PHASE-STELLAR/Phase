import { useRouter } from "next/navigation"
import { useCallback, useEffect } from "react"

interface PrefetchConfig {
  enabled?: boolean
  delay?: number
}

const prefetchedRoutes = new Set<string>()

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

    const handleLinkHover = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const link = target.closest("a[href]") as HTMLAnchorElement | null
      if (link?.href && !link.href.includes("javascript:")) {
        try {
          const url = new URL(link.href)
          if (url.origin === window.location.origin) {
            prefetchRoute(url.pathname + url.search)
          }
        } catch {
          // Invalid URL
        }
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement
      const link = target.closest("a[href]") as HTMLAnchorElement | null
      if (link?.href && !link.href.includes("javascript:")) {
        try {
          const url = new URL(link.href)
          if (url.origin === window.location.origin) {
            prefetchRoute(url.pathname + url.search)
          }
        } catch {
          // Invalid URL
        }
      }
    }

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
