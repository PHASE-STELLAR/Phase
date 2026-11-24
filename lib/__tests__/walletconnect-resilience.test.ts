import { beforeEach, describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  DEFAULT_WC_RELAY_URL,
  FALLBACK_WC_RELAY_URL,
  STELLAR_CHAIN_PUBNET,
  STELLAR_CHAIN_TESTNET,
  buildMobileWalletDeepLink,
  calculateReconnectBackoff,
  clearWcSessionMetadata,
  consumeDeepLinkReturn,
  getWcSessionMetadata,
  isWcResilienceEnabled,
  isWcSessionExpired,
  normalizeDeepLinkReturnPath,
  recordMobileDeepLinkReturn,
  resolveAllowedChains,
  resolveRelayUrls,
  restoreWcSession,
  saveWcSessionMetadata,
  validateWcChain,
  wcResilienceRollbackNote,
  withRelayFailover,
  type WcSessionMetadata,
} from "@/lib/walletconnect-resilience"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

function installWindow(): Map<string, string> {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      location: { pathname: "/chamber", search: "?id=7", hash: "#proof" },
    },
  })
  return store
}

describe("phase-167 WalletConnect resilience", () => {
  const originalFlag = process.env.FEATURE_PHASE_167

  beforeEach(() => {
    process.env.FEATURE_PHASE_167 = "1"
    resetSecurityCounters()
    installWindow()
    clearWcSessionMetadata()
  })

  it("is flag gated and documents rollback", () => {
    assert.equal(isWcResilienceEnabled(), true)
    assert.match(wcResilienceRollbackNote(), /phase-167/)
    delete process.env.FEATURE_PHASE_167
    assert.equal(isWcResilienceEnabled(), false)
    process.env.FEATURE_PHASE_167 = "1"
  })

  it("resolves relays and chains", () => {
    assert.equal(getRelay(), DEFAULT_WC_RELAY_URL)
    assert.deepEqual(resolveRelayUrls({}), [DEFAULT_WC_RELAY_URL, FALLBACK_WC_RELAY_URL])
    assert.equal(resolveAllowedChains("testnet")[0], STELLAR_CHAIN_TESTNET)
    assert.equal(resolveAllowedChains("mainnet")[0], STELLAR_CHAIN_PUBNET)
  })

  it("fails over across relays and records the closed counter", async () => {
    const attempts: string[] = []
    const res = await withRelayFailover(
      async (relay) => {
        attempts.push(relay)
        if (relay === DEFAULT_WC_RELAY_URL) throw new Error("relay down")
        return "connected"
      },
      { relays: resolveRelayUrls({}) },
    )
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.value, "connected")
      assert.equal(res.failovers, 1)
      assert.equal(res.relayUrl, FALLBACK_WC_RELAY_URL)
    }
    assert.equal(attempts.length, 2)
    assert.equal(getSecurityCounter("relay_failover"), 1)
  })

  it("rejects a wrong-chain session before it is used", () => {
    assert.equal(validateWcChain(STELLAR_CHAIN_TESTNET, "testnet").valid, true)
    assert.equal(validateWcChain(STELLAR_CHAIN_PUBNET, "testnet").valid, false)
    assert.equal(getSecurityCounter("wc_chain_mismatch_blocked"), 1)
  })

  it("restores only valid persisted sessions and counts session_restored", () => {
    const now = Date.now()
    const meta: WcSessionMetadata = {
      topic: "topic-1",
      peerName: "LOBSTR",
      chain: STELLAR_CHAIN_TESTNET,
      expiry: Math.floor((now + 3_600_000) / 1000),
      connectedAt: now,
      lastActiveAt: now,
    }
    assert.equal(restoreWcSession({ metadata: meta, now }).restored, true)
    assert.equal(getSecurityCounter("session_restored"), 1)
    assert.equal(restoreWcSession({ metadata: { ...meta, chain: STELLAR_CHAIN_PUBNET }, now }).restored, false)
    assert.equal(restoreWcSession({ metadata: { ...meta, expiry: 1 }, now }).restored, false)
    assert.equal(getSecurityCounter("session_restored"), 1)
  })

  it("persists session metadata and computes expiry in seconds or ms", () => {
    const now = Date.now()
    const meta: WcSessionMetadata = {
      topic: "t",
      chain: STELLAR_CHAIN_TESTNET,
      expiry: Math.floor((now + 60_000) / 1000),
      connectedAt: now,
      lastActiveAt: now,
    }
    saveWcSessionMetadata(meta)
    assert.equal(getWcSessionMetadata()?.topic, "t")
    assert.equal(isWcSessionExpired(meta), false)
    assert.equal(isWcSessionExpired({ ...meta, expiry: now - 1 }), true)
    clearWcSessionMetadata()
    assert.equal(getWcSessionMetadata(), null)
  })

  it("returns deep links to an internal route only", () => {
    recordMobileDeepLinkReturn()
    assert.equal(consumeDeepLinkReturn(), "/chamber?id=7#proof")
    assert.equal(consumeDeepLinkReturn(), null)
    assert.equal(normalizeDeepLinkReturnPath("https://evil.example/steal"), null)
    assert.equal(normalizeDeepLinkReturnPath("//evil.example"), null)
    assert.equal(getSecurityCounter("deep_link_return"), 1)
  })

  it("builds mobile deep links and bounded backoff", () => {
    assert.equal(buildMobileWalletDeepLink("LOBSTR Mobile"), "lobstr://wc")
    assert.equal(buildMobileWalletDeepLink("xBull Wallet"), "xbull://wc")
    assert.equal(buildMobileWalletDeepLink("Unknown"), null)
    assert.equal(buildMobileWalletDeepLink("Custom", "https://custom.app/wc"), "https://custom.app/wc")
    assert.ok(calculateReconnectBackoff(1) >= 1000)
    assert.ok(calculateReconnectBackoff(20) <= 35000)
  })
})

function getRelay(): string {
  return resolveRelayUrls({ NEXT_PUBLIC_WALLETCONNECT_RELAY_URL: DEFAULT_WC_RELAY_URL })[0]!
}
