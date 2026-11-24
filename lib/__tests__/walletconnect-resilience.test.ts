import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    location: { pathname: "/chamber", search: "?id=7", hash: "#proof" },
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

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_PHASE_167
    else process.env.FEATURE_PHASE_167 = originalFlag
    vi.unstubAllGlobals()
  })

  it("is flag gated and documents rollback", () => {
    expect(isWcResilienceEnabled()).toBe(true)
    expect(wcResilienceRollbackNote()).toContain("phase-167")
    delete process.env.FEATURE_PHASE_167
    expect(isWcResilienceEnabled()).toBe(false)
    process.env.FEATURE_PHASE_167 = "1"
  })

  it("resolves relays and chains", () => {
    expect(resolveRelayUrls({})).toEqual([DEFAULT_WC_RELAY_URL, FALLBACK_WC_RELAY_URL])
    expect(resolveAllowedChains("testnet")[0]).toBe(STELLAR_CHAIN_TESTNET)
    expect(resolveAllowedChains("mainnet")[0]).toBe(STELLAR_CHAIN_PUBNET)
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
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value).toBe("connected")
      expect(res.failovers).toBe(1)
      expect(res.relayUrl).toBe(FALLBACK_WC_RELAY_URL)
    }
    expect(attempts.length).toBe(2)
    expect(getSecurityCounter("relay_failover")).toBe(1)
  })

  it("rejects a wrong-chain session before it is used", () => {
    expect(validateWcChain(STELLAR_CHAIN_TESTNET, "testnet").valid).toBe(true)
    expect(validateWcChain(STELLAR_CHAIN_PUBNET, "testnet").valid).toBe(false)
    expect(getSecurityCounter("wc_chain_mismatch_blocked")).toBe(1)
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
    expect(restoreWcSession({ metadata: meta, now }).restored).toBe(true)
    expect(getSecurityCounter("session_restored")).toBe(1)
    expect(restoreWcSession({ metadata: { ...meta, chain: STELLAR_CHAIN_PUBNET }, now }).restored).toBe(false)
    expect(restoreWcSession({ metadata: { ...meta, expiry: 1 }, now }).restored).toBe(false)
    expect(getSecurityCounter("session_restored")).toBe(1)
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
    expect(getWcSessionMetadata()?.topic).toBe("t")
    expect(isWcSessionExpired(meta)).toBe(false)
    expect(isWcSessionExpired({ ...meta, expiry: now - 1 })).toBe(true)
    clearWcSessionMetadata()
    expect(getWcSessionMetadata()).toBeNull()
  })

  it("returns deep links to an internal route only", () => {
    recordMobileDeepLinkReturn()
    expect(consumeDeepLinkReturn()).toBe("/chamber?id=7#proof")
    expect(consumeDeepLinkReturn()).toBeNull()
    expect(normalizeDeepLinkReturnPath("https://evil.example/steal")).toBeNull()
    expect(normalizeDeepLinkReturnPath("//evil.example")).toBeNull()
    expect(getSecurityCounter("deep_link_return")).toBe(1)
  })

  it("builds mobile deep links and bounded backoff", () => {
    expect(buildMobileWalletDeepLink("LOBSTR Mobile")).toBe("lobstr://wc")
    expect(buildMobileWalletDeepLink("xBull Wallet")).toBe("xbull://wc")
    expect(buildMobileWalletDeepLink("Unknown")).toBeNull()
    expect(buildMobileWalletDeepLink("Custom", "https://custom.app/wc")).toBe("https://custom.app/wc")
    expect(calculateReconnectBackoff(1)).toBeGreaterThanOrEqual(1000)
    expect(calculateReconnectBackoff(20)).toBeLessThanOrEqual(35000)
  })
})
