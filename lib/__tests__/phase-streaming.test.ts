import { describe, expect, it } from "vitest"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"
import { readableStreamFromAsyncIterable } from "@/lib/phase-streaming"

describe("phase-264 streamed response handling", () => {
  it("releases an async iterator and counts client cancellation", async () => {
    resetSecurityCounters()
    let released = false
    async function* chunks() {
      try {
        yield "first"
        yield "second"
      } finally {
        released = true
      }
    }

    const reader = readableStreamFromAsyncIterable(chunks()).getReader()
    expect(await reader.read()).toMatchObject({ value: new TextEncoder().encode("first"), done: false })
    await reader.cancel()
    expect(released).toBe(true)
    expect(getSecurityCounter("phase_stream_closed")).toBe(1)
  })
})
