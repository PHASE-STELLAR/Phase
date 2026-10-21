import { describe, it, expect, beforeEach } from "vitest"
import {
  wcResilienceRollbackNote,
  DEFAULT_WC_RELAY_URL,
  getWalletConnectRelayUrl,
  resolveAllowedChains,
  saveWcSessionMetadata,
  getWcSessionMetadata,
  clearWcSessionMetadata,
  isWcSessionExpired,
  validateWcChain,
  buildMobileWalletDeepLink,
  calculateReconnectBackoff,
  STELLAR_CHAIN_TESTNET,
  STELLAR_CHAIN_PUBNET,
  type WcSessionMetadata,
} from "@/lib/walletconnect-resilience"
import { resetSecurityCounters, getSecurityCounter } from "@/lib/security-counters"

describe("spike 623: WalletConnect v2 mobile session resilience (phase-167)", () => {
  beforeEach(() => {
    resetSecurityCounters()
    clearWcSessionMetadata()
  })

  it("exposes rollback notes mentioning phase-167", () => {
    expect(wcResilienceRollbackNote()).toContain("phase-167")
  })

  it("resolves the primary relay websocket URL", () => {
    expect(getWalletConnectRelayUrl()).toBe(DEFAULT_WC_RELAY_URL)
  })

  it("resolves allowed chains according to active network", () => {
    const testnetChains = resolveAllowedChains("testnet")
    expect(testnetChains).toContain(STELLAR_CHAIN_TESTNET)
    expect(testnetChains[0]).toBe(STELLAR_CHAIN_TESTNET)

    const mainnetChains = resolveAllowedChains("mainnet")
    expect(mainnetChains).toContain(STELLAR_CHAIN_PUBNET)
    expect(mainnetChains[0]).toBe(STELLAR_CHAIN_PUBNET)
  })

  it("validates chain matching and blocks mismatches with security counter", () => {
    const validTestnet = validateWcChain(STELLAR_CHAIN_TESTNET, "testnet")
    expect(validTestnet.valid).toBe(true)

    const validPubnet = validateWcChain(STELLAR_CHAIN_PUBNET, "mainnet")
    expect(validPubnet.valid).toBe(true)

    const mismatch = validateWcChain(STELLAR_CHAIN_PUBNET, "testnet")
    expect(mismatch.valid).toBe(false)
    expect(mismatch.error).toContain("chain mismatch")
    expect(getSecurityCounter("wc_chain_mismatch_blocked")).toBe(1)
  })

  it("persists session metadata and calculates expiration", () => {
    const now = Date.now()
    const validSession: WcSessionMetadata = {
      topic: "test-topic-123",
      peerName: "LOBSTR Wallet",
      chain: STELLAR_CHAIN_TESTNET,
      expiry: Math.floor((now + 3600000) / 1000), // 1 hour in future (seconds)
      connectedAt: now,
      lastActiveAt: now,
    }

    saveWcSessionMetadata(validSession)
    const retrieved = getWcSessionMetadata()
    expect(retrieved?.topic).toBe("test-topic-123")
    expect(retrieved?.peerName).toBe("LOBSTR Wallet")
    expect(isWcSessionExpired(retrieved)).toBe(false)

    const expiredSession: WcSessionMetadata = {
      ...validSession,
      expiry: Math.floor((now - 10000) / 1000), // 10 seconds ago
    }
    expect(isWcSessionExpired(expiredSession)).toBe(true)

    clearWcSessionMetadata()
    expect(getWcSessionMetadata()).toBeNull()
  })

  it("builds mobile wallet deep links correctly", () => {
    expect(buildMobileWalletDeepLink("LOBSTR Mobile")).toBe("lobstr://wc")
    expect(buildMobileWalletDeepLink("xBull Wallet Mobile")).toBe("xbull://wc")
    expect(buildMobileWalletDeepLink("Unknown Peer")).toBeNull()
    expect(buildMobileWalletDeepLink("Custom", "https://custom.app/wc")).toBe("https://custom.app/wc")
  })

  it("calculates exponential backoff with ceiling", () => {
    const delay1 = calculateReconnectBackoff(1)
    expect(delay1).toBeGreaterThanOrEqual(1000)
    expect(delay1).toBeLessThanOrEqual(2500)

    const delay5 = calculateReconnectBackoff(5)
    expect(delay5).toBeGreaterThan(delay1)

    const delayHigh = calculateReconnectBackoff(20)
    expect(delayHigh).toBeLessThanOrEqual(35000)
  })
})
