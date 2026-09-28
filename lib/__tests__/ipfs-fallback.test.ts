import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { fetchWithIpfsFallback, resolveIpfsFallbackConfig } from "@/lib/phase-nft-metadata-build"
import { recordGatewayLatency, resetGatewayHealth } from "@/lib/gateway-health"

describe("phase-123 ipfs fallback", () => {
  it("resolves config with defaults", () => {
    const cfg = resolveIpfsFallbackConfig({})
    assert.ok(cfg.gateways.length > 0)
    assert.ok(cfg.timeoutMs >= 500)
  })

  it("validates empty ipfs path", async () => {
    const res = await fetchWithIpfsFallback("", { config: { timeoutMs: 500 } })
    assert.equal(res.ok, false)
  })

  it("falls back across gateways on failure", async () => {
    const origFetch = global.fetch
    let calls = 0
    global.fetch = async () => {
      calls++
      throw new Error("network fail")
    }
    const res = await fetchWithIpfsFallback("QmTest", { config: { gateways: ["https://a.test/ipfs", "https://b.test/ipfs"], timeoutMs: 200 } })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.perGateway.length, 2)
    assert.equal(calls, 2)
    global.fetch = origFetch
  })

  it("returns first successful gateway", async () => {
    const origFetch = global.fetch
    global.fetch = async (url: string | URL | Request) => {
      if (String(url).includes("a.test")) throw new Error("fail")
      return new Response(new ArrayBuffer(4), { status: 200, headers: { "content-type": "image/png" } })
    }
    const res = await fetchWithIpfsFallback("QmOk", { config: { gateways: ["https://a.test/ipfs", "https://b.test/ipfs"], timeoutMs: 500 } })
    assert.equal(res.ok, true)
    if (res.ok) assert.ok(res.gateway.includes("b.test"))
    global.fetch = origFetch
  })

  it("tries the higher-scored gateway first when phase-121 health data exists", async () => {
    resetGatewayHealth()
    process.env.FEATURE_PHASE_121 = "1"
    recordGatewayLatency("https://slow.test/ipfs", 4000, true)
    recordGatewayLatency("https://fast.test/ipfs", 100, true)

    const origFetch = global.fetch
    const calledOrder: string[] = []
    global.fetch = async (url: string | URL | Request) => {
      calledOrder.push(String(url))
      return new Response(new ArrayBuffer(4), { status: 200, headers: { "content-type": "image/png" } })
    }

    const res = await fetchWithIpfsFallback("QmRank", {
      config: { gateways: ["https://slow.test/ipfs", "https://fast.test/ipfs"], timeoutMs: 500 },
    })

    assert.equal(res.ok, true)
    if (res.ok) assert.ok(res.gateway.includes("fast.test"))
    assert.ok(calledOrder[0]?.includes("fast.test"))

    global.fetch = origFetch
    resetGatewayHealth()
    delete process.env.FEATURE_PHASE_121
  })
})
