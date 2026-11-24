// @ts-nocheck
import { describe, it, beforeEach, afterEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  DEFAULT_SEAL_SVG,
  clearForgeSealCache,
  deriveSealDigest,
  getForgeSealCacheSize,
  getForgeSealCounters,
  renderDeterministicSealWithFallback,
  resetForgeSealCounters,
  verifyServedSeal,
} from "@/lib/forge-seal-image"

describe("forge-seal-image (phase-259 / #712)", () => {
  beforeEach(() => {
    process.env.FEATURE_PHASE_259 = "1"
    clearForgeSealCache()
    resetForgeSealCounters()
  })

  afterEach(() => {
    delete process.env.FEATURE_PHASE_259
    clearForgeSealCache()
    resetForgeSealCounters()
  })

  it("identical metadata with different key ordering yields identical digest and seal", async () => {
    const artifact = new Uint8Array([1, 2, 3, 4, 5])
    const d1 = deriveSealDigest(artifact, { name: "A", creator: "B", traits: { z: 2, a: 1 } })
    const d2 = deriveSealDigest(artifact, { traits: { a: 1, z: 2 }, creator: "B", name: "A" })
    assert.equal(d1, d2)

    const r1 = await renderDeterministicSealWithFallback(artifact, { name: "A", creator: "B" })
    assert.equal(r1.fromCache, false)
    assert.equal(r1.fallback, false)

    const r2 = await renderDeterministicSealWithFallback(artifact, { creator: "B", name: "A" })
    assert.equal(r2.fromCache, true)
    assert.equal(r2.sealDigest, r1.sealDigest)
    assert.deepEqual(r2.bytes, r1.bytes)

    const c = getForgeSealCounters()
    assert.equal(c.seal_cache_miss, 1)
    assert.equal(c.seal_cache_hit, 1)
    assert.equal(c.seal_rendered, 1)
  })

  it("rejects a tampered seal and increments seal_tamper_rejected", async () => {
    const artifact = new Uint8Array([9, 8, 7])
    const res = await renderDeterministicSealWithFallback(artifact, { id: "x" })
    const tampered = new Uint8Array(res.bytes)
    tampered[0] = tampered[0]! ^ 0xff

    const check = verifyServedSeal(tampered, res.artifactDigest!, res.sealDigest)
    assert.equal(check.valid, false)
    assert.equal(check.reason, "SEAL_DIGEST_MISMATCH")
    assert.equal(getForgeSealCounters().seal_tamper_rejected, 1)
  })

  it("falls back to default seal when renderer fails", async () => {
    const artifact = new Uint8Array([10, 20, 30])
    const res = await renderDeterministicSealWithFallback(
      artifact,
      { id: "fail" },
      {
        renderer: () => {
          throw new Error("renderer offline")
        },
      },
    )
    assert.equal(res.fallback, true)
    assert.equal(new TextDecoder().decode(res.bytes), DEFAULT_SEAL_SVG)
    assert.equal(getForgeSealCounters().seal_renderer_fallback, 1)
  })

  it("returns default seal and leaves cache inert when flag is off", async () => {
    process.env.FEATURE_PHASE_259 = "0"
    const artifact = new Uint8Array([42, 43])
    const res = await renderDeterministicSealWithFallback(artifact, { id: "off" })
    assert.equal(res.artifactDigest, null)
    assert.equal(res.fallback, true)
    assert.equal(new TextDecoder().decode(res.bytes), DEFAULT_SEAL_SVG)
    assert.equal(getForgeSealCacheSize(), 0)
    assert.equal(getForgeSealCounters().seal_flag_disabled, 1)
  })
})
