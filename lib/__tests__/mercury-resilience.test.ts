import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  fetchTokenIdsWithResilience,
  globalMercuryBreaker,
  MercuryCircuitBreaker,
} from "@/lib/mercury-classic"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const CONTRACT = "CA7NTESTCONTRACTID12345678901234567890123456789012345678"
const WALLET = "GBRPYHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX"

describe("phase-236 Mercury vs RPC fallback adapter", () => {
  beforeEach(() => {
    resetSecurityCounters()
    globalMercuryBreaker.reset()
    process.env.FEATURE_PHASE_236 = "1"
    process.env.NEXT_PUBLIC_FEATURE_PHASE_236 = "1"
    delete process.env.MERCURY_JWT
  })

  afterEach(() => {
    delete process.env.FEATURE_PHASE_236
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_236
    delete process.env.MERCURY_JWT
  })

  it("routes strictly to RPC when feature flag is off", async () => {
    process.env.FEATURE_PHASE_236 = "0"
    process.env.NEXT_PUBLIC_FEATURE_PHASE_236 = "0"
    process.env.MERCURY_JWT = "test-jwt"

    const rpcFn = async () => [1, 2, 3]
    const res = await fetchTokenIdsWithResilience(CONTRACT, WALLET, rpcFn)
    expect(res.source).toBe("soroban-rpc")
    expect(res.tokenIds).toEqual([1, 2, 3])
  })

  it("falls back to RPC when Mercury is unconfigured", async () => {
    delete process.env.MERCURY_JWT
    const rpcFn = async () => [10, 20]
    const res = await fetchTokenIdsWithResilience(CONTRACT, WALLET, rpcFn)
    expect(res.source).toBe("soroban-rpc-fallback")
    expect(res.tokenIds).toEqual([10, 20])
  })

  it("trips circuit breaker after consecutive failures and recovers after cooldown", () => {
    const breaker = new MercuryCircuitBreaker(3, 50) // 50ms cooldown
    expect(breaker.canAttemptMercury()).toBe(true)

    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.state).toBe("closed")

    breaker.recordFailure()
    expect(breaker.state).toBe("open")
    expect(breaker.canAttemptMercury()).toBe(false)

    // After cooldown
    breaker.lastFailureTime = Date.now() - 60
    expect(breaker.canAttemptMercury()).toBe(true)
    expect(breaker.state).toBe("half-open")

    breaker.recordSuccess()
    expect(breaker.state).toBe("closed")
  })
})
