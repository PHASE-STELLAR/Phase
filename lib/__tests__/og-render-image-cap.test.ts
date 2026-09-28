/**
 * Module #24: fetchImageBuffer must not buffer unbounded remote images —
 * that is the root cause of the OG lambda hitting Vercel's memory ceiling.
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { fetchImageBuffer } from "@/lib/og-render-utils"

function streamResponse(totalBytes: number, chunkSize: number, headers: Record<string, string> = {}): Response {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close()
        return
      }
      const n = Math.min(chunkSize, totalBytes - sent)
      controller.enqueue(new Uint8Array(n))
      sent += n
    },
  })
  return new Response(stream, { status: 200, headers })
}

describe("fetchImageBuffer size cap", () => {
  it("returns the buffer for an image under the cap", async () => {
    const origFetch = global.fetch
    // @ts-ignore mock
    global.fetch = async () => streamResponse(1024, 256, { "content-length": "1024" })
    const buf = await fetchImageBuffer("https://gateway.test/img.png", 5000, 4096)
    assert.ok(buf)
    assert.equal(buf!.byteLength, 1024)
    global.fetch = origFetch
  })

  it("rejects via Content-Length before reading the body", async () => {
    const origFetch = global.fetch
    let bodyRead = false
    // @ts-ignore mock
    global.fetch = async () => {
      const resp = streamResponse(10 * 1024 * 1024, 65536, { "content-length": String(10 * 1024 * 1024) })
      const origGetReader = resp.body!.getReader.bind(resp.body)
      resp.body!.getReader = () => {
        bodyRead = true
        return origGetReader()
      }
      return resp
    }
    const buf = await fetchImageBuffer("https://gateway.test/huge.png", 5000, 1024 * 1024)
    assert.equal(buf, null)
    assert.equal(bodyRead, false)
    global.fetch = origFetch
  })

  it("cuts off an oversized body even without a Content-Length header", async () => {
    const origFetch = global.fetch
    // @ts-ignore mock
    global.fetch = async () => streamResponse(5 * 1024 * 1024, 65536)
    const buf = await fetchImageBuffer("https://gateway.test/unbounded.png", 5000, 1024 * 1024)
    assert.equal(buf, null)
    global.fetch = origFetch
  })
})
