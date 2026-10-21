import { cache } from "react"
import { unstable_noStore as noStore } from "next/cache"
import { isFeatureEnabled } from "@/lib/feature-flags"

/** Shared RSC primitives for latency-heavy pages. Disabled flags preserve legacy rendering. */
export function preparePhaseStreaming(): void {
  if (isFeatureEnabled("phase-170")) noStore()
}

/** React.cache dedupes metadata reads within one server render request. */
export const cachePhaseRead = <TArgs extends readonly unknown[], TResult>(
  reader: (...args: TArgs) => Promise<TResult>,
) => cache(reader)

export function phaseReadHeaders(): HeadersInit {
  return isFeatureEnabled("phase-170")
    ? { "Cache-Control": "private, no-store", Vary: "RSC, Next-Router-State-Tree" }
    : {}
}
