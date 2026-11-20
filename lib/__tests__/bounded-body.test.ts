import { describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { BoundedBodyError, readBoundedBody, readBoundedBytes } from "@/lib/bounded-body"
import { middleware } from "@/middleware"

describe("bounded request bodies", () => {
  it("reads exact-size bodies as bytes and text", async () => {
    const response = new Response(new Uint8Array([65, 66, 67]))
    expect(await readBoundedBody(response.clone(), 3)).toBe("ABC")
    expect(Array.from(await readBoundedBytes(response, 3))).toEqual([65, 66, 67])
  })

  it("rejects a body that crosses the byte cap", async () => {
    await expect(readBoundedBody(new Response("large"), 4)).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
    })
  })

  it("rejects a stream that stops producing data before its read timeout", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined)
      },
    }))
    await expect(readBoundedBody(response, 10, 5)).rejects.toBeInstanceOf(BoundedBodyError)
    await expect(readBoundedBody(new Response("x"), 1, 5)).resolves.toBe("x")
  })

  it("returns typed 413 for a write request over the phase-264 cap", async () => {
    const previousFlag = process.env.FEATURE_PHASE_264
    process.env.FEATURE_PHASE_264 = "1"
    try {
      const request = new NextRequest("https://phase.test/api/profile", {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
      })
      const response = await middleware(request)
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ code: "BODY_TOO_LARGE" })
    } finally {
      if (previousFlag === undefined) delete process.env.FEATURE_PHASE_264
      else process.env.FEATURE_PHASE_264 = previousFlag
    }
  })
})
