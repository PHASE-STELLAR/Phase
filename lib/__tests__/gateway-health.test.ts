import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { recordGatewayLatency, getGatewayHealthSnapshot, resetGatewayHealth } from "@/lib/gateway-health"

describe("phase-121 gateway health", () => {
  beforeEach(() => resetGatewayHealth())

  it("scores fast gateway higher than slow", () => {
    process.env.FEATURE_PHASE_121 = "1"
    recordGatewayLatency("https://fast.test/ipfs", 120, true)
    recordGatewayLatency("https://fast.test/ipfs", 130, true)
    recordGatewayLatency("https://slow.test/ipfs", 4500, true)
    recordGatewayLatency("https://slow.test/ipfs", 4800, true)
    const snap = getGatewayHealthSnapshot()
    const fast = snap.gateways.find((g) => g.gateway.includes("fast.test"))
    const slow = snap.gateways.find((g) => g.gateway.includes("slow.test"))
    assert.ok(fast)
    assert.ok(slow)
    assert.ok(fast!.score > slow!.score)
    assert.ok(fast!.avgLatencyMs < slow!.avgLatencyMs)
    process.env.FEATURE_PHASE_121 = ""
  })

  it("uptime affects score", () => {
    process.env.FEATURE_PHASE_121 = "1"
    recordGatewayLatency("https://flaky.test/ipfs", 200, true)
    recordGatewayLatency("https://flaky.test/ipfs", 200, false)
    recordGatewayLatency("https://flaky.test/ipfs", 200, false)
    const snap = getGatewayHealthSnapshot()
    const flaky = snap.gateways.find((g) => g.gateway.includes("flaky.test"))
    assert.ok(flaky)
    assert.ok(Math.abs(flaky!.uptime - 0.333) < 0.1)
    assert.ok(flaky!.score < 70)
    process.env.FEATURE_PHASE_121 = ""
  })

  it("snapshot is sorted by score", () => {
    process.env.FEATURE_PHASE_121 = "1"
    resetGatewayHealth()
    recordGatewayLatency("https://a.test/ipfs", 100, true)
    recordGatewayLatency("https://b.test/ipfs", 5000, true)
    const snap = getGatewayHealthSnapshot()
    const filtered = snap.gateways.filter((g) => g.totalRequests > 0)
    assert.ok(filtered[0]!.score >= filtered[1]!.score)
    process.env.FEATURE_PHASE_121 = ""
  })
})
