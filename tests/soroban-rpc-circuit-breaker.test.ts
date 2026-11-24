import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  getUpstreamCircuitStatus,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  checkProxyRateLimit,
  canProbeHalfOpenCircuit,
  completeHalfOpenProbe,
  getCircuitBreakerHealth,
} from "../app/api/soroban-rpc/route.js"

describe("app/api/soroban-rpc - Circuit Breaker & Rate Limiter (Issue #738)", () => {
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

  it("transitions to HALF_OPEN after cooldown expires", () => {
    const url = "https://soroban-testnet.stellar.org/test-cb-5"
    recordUpstreamFailure(url, true)
    assert.equal(getUpstreamCircuitStatus(url).state, "OPEN")

    // Simulate time passing by manually manipulating nextAttempt
    const status = getUpstreamCircuitStatus(url)
    status.nextAttempt = Date.now() - 1

    // Next call should detect time has passed and transition to HALF_OPEN
    const updated = getUpstreamCircuitStatus(url)
    assert.equal(updated.state, "HALF_OPEN")
  })

  it("bounds half-open probes to prevent overwhelming recovery", () => {
    const url = "https://soroban-testnet.stellar.org/test-cb-6"
    recordUpstreamFailure(url, true)
    const status = getUpstreamCircuitStatus(url)
    status.state = "HALF_OPEN"
    status.nextAttempt = Date.now() - 1

    // First probe should succeed
    assert.equal(canProbeHalfOpenCircuit(url), true)
    assert.equal(getUpstreamCircuitStatus(url).probesInFlight, 1)

    // Second probe should be bounded
    assert.equal(canProbeHalfOpenCircuit(url), false)

    // After completing first probe, next can begin
    completeHalfOpenProbe(url)
    assert.equal(canProbeHalfOpenCircuit(url), true)
  })

  it("exposes health status without PII", () => {
    const url1 = "https://soroban-testnet.stellar.org/test-health-1"
    const url2 = "https://soroban-testnet.stellar.org/test-health-2"

    recordUpstreamFailure(url1, false)
    recordUpstreamSuccess(url2)

    const health = getCircuitBreakerHealth()
    assert.equal(health.enabled, true)
    assert.ok(Array.isArray(health.upstreams))

    // Verify no full URLs are exposed
    const healthJson = JSON.stringify(health)
    assert.ok(!healthJson.includes("soroban-testnet.stellar.org"))
  })

  it("recovers from half-open to closed on success", () => {
    const url = "https://soroban-testnet.stellar.org/test-cb-7"
    recordUpstreamFailure(url, true)
    assert.equal(getUpstreamCircuitStatus(url).state, "OPEN")

    const status = getUpstreamCircuitStatus(url)
    status.state = "HALF_OPEN"
    status.nextAttempt = Date.now() - 1

    recordUpstreamSuccess(url)
    assert.equal(getUpstreamCircuitStatus(url).state, "CLOSED")
    assert.equal(getUpstreamCircuitStatus(url).failures, 0)
  })
})
