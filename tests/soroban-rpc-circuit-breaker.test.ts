import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  getUpstreamCircuitStatus,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  checkProxyRateLimit,
} from "../app/api/soroban-rpc/route.js"

describe("app/api/soroban-rpc - Circuit Breaker & Rate Limiter (Issue #164)", () => {
  it("initializes circuit breaker in CLOSED state", () => {
    const url = "https://soroban-testnet.stellar.org/test-cb-1"
    const status = getUpstreamCircuitStatus(url)
    assert.equal(status.state, "CLOSED")
    assert.equal(status.failures, 0)
  })

  it("trips circuit breaker to OPEN upon receiving HTTP 429", () => {
    const url = "https://soroban-testnet.stellar.org/test-cb-2"
    recordUpstreamFailure(url, true)
    const status = getUpstreamCircuitStatus(url)
    assert.equal(status.state, "OPEN")
    assert.ok(status.nextAttempt > Date.now())
  })

  it("trips circuit breaker to OPEN after reaching failure threshold", () => {
    const url = "https://soroban-testnet.stellar.org/test-cb-3"
    recordUpstreamFailure(url, false)
    recordUpstreamFailure(url, false)
    assert.equal(getUpstreamCircuitStatus(url).state, "CLOSED")
    recordUpstreamFailure(url, false)
    assert.equal(getUpstreamCircuitStatus(url).state, "OPEN")
  })

  it("resets circuit breaker to CLOSED on success", () => {
    const url = "https://soroban-testnet.stellar.org/test-cb-4"
    recordUpstreamFailure(url, false)
    recordUpstreamSuccess(url)
    const status = getUpstreamCircuitStatus(url)
    assert.equal(status.state, "CLOSED")
    assert.equal(status.failures, 0)
  })

  it("enforces proxy rate limiting per client IP", () => {
    const testIp = "192.168.1.100"
    for (let i = 0; i < 60; i++) {
      assert.equal(checkProxyRateLimit(testIp), true)
    }
    // 61st request should be rate limited
    assert.equal(checkProxyRateLimit(testIp), false)
  })
})
