"use client"

import type { ReactNode } from "react"
import { useLinkPrefetch } from "@/hooks/use-link-prefetch"

export function LinkPrefetchProvider({ children }: { children: ReactNode }) {
  useLinkPrefetch({ enabled: true, delay: 50 })
  return <>{children}</>
}
