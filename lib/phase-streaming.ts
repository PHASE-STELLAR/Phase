import { cache } from "react"
import { unstable_noStore as noStore } from "next/cache"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"

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

export function readableStreamFromAsyncIterable(
  source: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
  options: { readTimeoutMs?: number } = {},
): ReadableStream<Uint8Array> {
  const iterator = Symbol.asyncIterator in source
    ? source[Symbol.asyncIterator]()
    : source[Symbol.iterator]()
  const encoder = new TextEncoder()
  const timeoutMs = options.readTimeoutMs ?? 30_000
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearReadTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      clearReadTimer()
      try {
        const next = await iterator.next()
        if (next.done) {
          closed = true
          controller.close()
          return
        }
        controller.enqueue(typeof next.value === "string" ? encoder.encode(next.value) : next.value)
        timer = setTimeout(() => {
          if (closed) return
          closed = true
          void iterator.return?.()
          incSecurityCounter("phase_stream_read_timeouts")
          controller.error(new Error("STREAM_READ_TIMEOUT"))
        }, timeoutMs)
      } catch (error) {
        closed = true
        controller.error(error)
      }
    },
    async cancel() {
      clearReadTimer()
      if (closed) return
      closed = true
      incSecurityCounter("phase_stream_closed")
      await iterator.return?.()
    },
  })
}
