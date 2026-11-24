/**
 * Module #51 (phase-51) — race-safe faucet claim rate-limits.
 * Run: npx tsx tests/faucet-rate-limit.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import {
  FaucetRateLimitError,
  auditFaucetRateLimitWiring,
  createRedisRateLimitBackend,
  enforceFaucetClaimRateLimit,
  __resetFaucetRateLimitState,
  type RedisLikeClient,
} from "@/lib/profile-store"

const REQ = { key: "wallet:GABC", limit: 3, windowMs: 60_000, cost: 1 }

describe("phase-51 race-safe faucet rate-limits", () => {
  before(() => {
    process.env.FEATURE_PHASE_51 = "1"
  })
  after(() => {
    process.env.FEATURE_PHASE_51 = ""
  })
  beforeEach(() => __resetFaucetRateLimitState())

  it("allows up to the limit then denies", async () => {
    const a = await enforceFaucetClaimRateLimit(REQ)
    const b = await enforceFaucetClaimRateLimit(REQ)
    const c = await enforceFaucetClaimRateLimit(REQ)
    const d = await enforceFaucetClaimRateLimit(REQ)
    assert.deepEqual([a.allowed, b.allowed, c.allowed, d.allowed], [true, true, true, false])
    assert.equal(a.remaining, 2)
    assert.equal(d.retryAfterMs > 0, true)
    assert.equal(d.backend, "memory")
  })

  it("does not race: 20 concurrent claims count exactly once each", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => enforceFaucetClaimRateLimit(REQ)),
    )
    const allowed = results.filter((r) => r.allowed).length
    assert.equal(allowed, 3, `only the limit should pass, got ${allowed}`)
    const maxUsed = Math.max(...results.map((r) => r.used))
    assert.equal(maxUsed, 20)
  })

  it("resets after the window elapses", async () => {
    const t0 = 1_000_000
    await enforceFaucetClaimRateLimit(REQ, { now: t0 })
    await enforceFaucetClaimRateLimit(REQ, { now: t0 + 1 })
    await enforceFaucetClaimRateLimit(REQ, { now: t0 + 2 })
    const blocked = await enforceFaucetClaimRateLimit(REQ, { now: t0 + 3 })
    assert.equal(blocked.allowed, false)
    const afterWindow = await enforceFaucetClaimRateLimit(REQ, { now: t0 + REQ.windowMs + 1 })
    assert.equal(afterWindow.allowed, true)
    assert.equal(afterWindow.used, 1)
  })

  it("works against an injected redis-like client", async () => {
    const store = new Map<string, { value: number; expiresAt: number }>()
    const now = () => 5_000_000
    const client: RedisLikeClient = {
      async incrby(key, amount) {
        const cur = store.get(key)?.value ?? 0
        const next = cur + amount
        store.set(key, { value: next, expiresAt: store.get(key)?.expiresAt ?? 0 })
        return next
      },
      async pexpire(key, ms) {
        const e = store.get(key)
        if (e) e.expiresAt = now() + ms
        return 1
      },
      async pttl(key) {
        const e = store.get(key)
        return e ? e.expiresAt - now() : -2
      },
    }
    const backend = createRedisRateLimitBackend(client)
    const r1 = await enforceFaucetClaimRateLimit(REQ, { backend, now: now() })
    const r2 = await enforceFaucetClaimRateLimit(REQ, { backend, now: now() })
    const r3 = await enforceFaucetClaimRateLimit(REQ, { backend, now: now() })
    const r4 = await enforceFaucetClaimRateLimit(REQ, { backend, now: now() })
    assert.deepEqual([r1.allowed, r2.allowed, r3.allowed, r4.allowed], [true, true, true, false])
    assert.equal(r1.backend, "redis")
    assert.equal(r1.resetAt, now() + REQ.windowMs)
  })

  it("surfaces a backend failure as BACKEND_UNAVAILABLE", async () => {
    const backend = {
      name: "redis" as const,
      consume: async () => {
        throw new Error("ECONNREFUSED")
      },
    }
    await assert.rejects(
      () => enforceFaucetClaimRateLimit(REQ, { backend }),
      (e: unknown) => e instanceof FaucetRateLimitError && e.code === "BACKEND_UNAVAILABLE",
    )
  })

  it("rejects an invalid request", async () => {
    await assert.rejects(
      () => enforceFaucetClaimRateLimit({ key: "x", limit: 0, windowMs: 10 }),
      (e: unknown) => e instanceof FaucetRateLimitError && e.code === "VALIDATION_FAILED",
    )
  })

  it("throws FLAG_DISABLED when phase-51 is off", async () => {
    process.env.FEATURE_PHASE_51 = ""
    await assert.rejects(
      () => enforceFaucetClaimRateLimit(REQ),
      (e: unknown) => e instanceof FaucetRateLimitError && e.code === "FLAG_DISABLED",
    )
    process.env.FEATURE_PHASE_51 = "1"
  })

  it("diagnose-env wiring audit passes", () => {
    assert.equal(auditFaucetRateLimitWiring().ok, true)
  })
})
