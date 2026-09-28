import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import {
  resolveCidGateway,
  recordCidGatewayOutcome,
  scoreGateway,
  getCidGatewayCacheStats,
  extractIpfsCidPath,
  CidResolutionError,
  __resetCidGatewayCacheForTests,
} from "@/lib/signal-store"

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"

describe("phase-136 CID gateway resolution cache", () => {
  beforeEach(() => {
    __resetCidGatewayCacheForTests()
    process.env.FEATURE_PHASE_136 = "1"
  })

  it("flag off: deterministic first-gateway pick, no caching", () => {
    process.env.FEATURE_PHASE_136 = ""
    const r = resolveCidGateway(CID)
    assert.equal(r.fromCache, false)
    assert.match(r.url, /^https:\/\/w3s\.link\/ipfs\//)
    assert.equal(getCidGatewayCacheStats().entries, 0)
  })

  it("caches resolution per CID within TTL", () => {
    const first = resolveCidGateway(CID, { now: 1_000 })
    assert.equal(first.fromCache, false)
    const second = resolveCidGateway(CID, { now: 2_000 })
    assert.equal(second.fromCache, true)
    assert.equal(second.url, first.url)
    assert.equal(second.gateway, first.gateway)
  })

  it("re-resolves after the TTL expires", () => {
    const first = resolveCidGateway(CID, { now: 1_000, ttlMs: 60_000 })
    const later = resolveCidGateway(CID, { now: 1_000 + 60_001 })
    assert.equal(first.fromCache, false)
    assert.equal(later.fromCache, false)
  })

  it("health score rewards fast + successful gateways", () => {
    recordCidGatewayOutcome({ gateway: "https://w3s.link/ipfs", ok: true, latencyMs: 80 })
    recordCidGatewayOutcome({ gateway: "https://w3s.link/ipfs", ok: true, latencyMs: 90 })
    recordCidGatewayOutcome({ gateway: "https://dweb.link/ipfs", ok: false, latencyMs: 9_000 })
    recordCidGatewayOutcome({ gateway: "https://dweb.link/ipfs", ok: false, latencyMs: 9_000 })
    assert.ok(scoreGateway("https://w3s.link/ipfs") > scoreGateway("https://dweb.link/ipfs"))
  })

  it("a recorded failure evicts cache entries pinned to that gateway", () => {
    const r = resolveCidGateway(CID, { now: 1_000 })
    assert.equal(getCidGatewayCacheStats().entries, 1)
    recordCidGatewayOutcome({ gateway: r.gateway, ok: false, latencyMs: 12_000 })
    assert.equal(getCidGatewayCacheStats().entries, 0)
  })

  it("picks the healthiest gateway on a cold cache", () => {
    for (let i = 0; i < 5; i++) {
      recordCidGatewayOutcome({ gateway: "https://w3s.link/ipfs", ok: false, latencyMs: 11_000 })
      recordCidGatewayOutcome({ gateway: "https://ipfs.io/ipfs", ok: true, latencyMs: 60 })
    }
    const r = resolveCidGateway(CID)
    assert.equal(r.gateway, "https://ipfs.io/ipfs")
  })

  it("rejects a malformed CID with a typed error", () => {
    assert.throws(() => resolveCidGateway("  not a cid !!"), (err: unknown) => {
      assert.ok(err instanceof CidResolutionError)
      assert.equal((err as CidResolutionError).code, "VALIDATION_FAILED")
      return true
    })
  })

  it("ignores malformed outcome payloads without throwing", () => {
    assert.doesNotThrow(() => recordCidGatewayOutcome({ gateway: "nope", ok: "yes" }))
    assert.doesNotThrow(() => recordCidGatewayOutcome(null))
  })

  it("extractIpfsCidPath pulls the CID from ipfs:// and gateway URLs, else null", () => {
    assert.equal(extractIpfsCidPath(`ipfs://${CID}`), CID)
    assert.equal(extractIpfsCidPath(`https://gateway.pinata.cloud/ipfs/${CID}`), CID)
    assert.equal(extractIpfsCidPath(`https://w3s.link/ipfs/${CID}/art.png`), `${CID}/art.png`)
    assert.equal(extractIpfsCidPath("https://cdn.example.com/ipfs-themed/pic.png"), null)
    assert.equal(extractIpfsCidPath(undefined), null)
  })
})
