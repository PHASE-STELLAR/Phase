import { describe, it, expect, beforeEach } from "vitest"
import {
  resolveStellarNetwork,
  StellarNetworkConfigError,
  isPhase238Enabled,
  isMainnetDryRun,
  assertNonMainnetFixture,
  verifyMainnetCutoverReadiness,
  STELLAR_PASSPHRASES,
} from "@/lib/stellar-network"

describe("stellar network and cutover ceremony (phase-238)", () => {
  const validToken = "phase-mainnet-cutover-token-2026-auth"
  const validIssuer = "G" + "A".repeat(55)
  const validContract = "C" + "B".repeat(55)

  beforeEach(() => {
    delete process.env.STELLAR_NETWORK
    delete process.env.STELLAR_NETWORK_PASSPHRASE
    delete process.env.PHASE_MAINNET_CUTOVER_ACK
    delete process.env.PHASE_MAINNET_CONFIRMATION_TOKEN
    delete process.env.PHASE_MAINNET_DRY_RUN
    delete process.env.FEATURE_PHASE_238
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_238
  })

  it("resolves testnet by default with canonical passphrase", () => {
    const resolved = resolveStellarNetwork({})
    expect(resolved.network).toBe("testnet")
    expect(resolved.passphrase).toBe(STELLAR_PASSPHRASES.testnet)
  })

  it("rejects unknown network strings", () => {
    expect(() => resolveStellarNetwork({ STELLAR_NETWORK: "fakenet" })).toThrow(
      StellarNetworkConfigError,
    )
  })

  it("allows mainnet when flag is off if ACK=1 is provided", () => {
    const resolved = resolveStellarNetwork({
      STELLAR_NETWORK: "mainnet",
      PHASE_MAINNET_CUTOVER_ACK: "1",
    })
    expect(resolved.network).toBe("mainnet")
    expect(resolved.passphrase).toBe(STELLAR_PASSPHRASES.mainnet)
  })

  it("requires confirmation token when phase-238 flag is active", () => {
    const env = {
      FEATURE_PHASE_238: "1",
      STELLAR_NETWORK: "mainnet",
      PHASE_MAINNET_CUTOVER_ACK: "1",
    }
    expect(() => resolveStellarNetwork(env)).toThrow(
      /PHASE_MAINNET_CONFIRMATION_TOKEN/,
    )

    // Token too short (< 16 chars)
    expect(() =>
      resolveStellarNetwork({ ...env, PHASE_MAINNET_CONFIRMATION_TOKEN: "short-token" }),
    ).toThrow(/minimum 16 characters required/)

    // Valid confirmation token passes
    const resolved = resolveStellarNetwork({
      ...env,
      PHASE_MAINNET_CONFIRMATION_TOKEN: validToken,
    })
    expect(resolved.network).toBe("mainnet")
  })

  it("detects dry-run mode correctly", () => {
    expect(isMainnetDryRun({ FEATURE_PHASE_238: "1", PHASE_MAINNET_DRY_RUN: "1" })).toBe(true)
    expect(isMainnetDryRun({ FEATURE_PHASE_238: "1", PHASE_MAINNET_DRY_RUN: "0" })).toBe(false)
    expect(isMainnetDryRun({ FEATURE_PHASE_238: "0", PHASE_MAINNET_DRY_RUN: "1" })).toBe(false)
  })

  it("fences testnet-only fixtures from mainnet", () => {
    const env = { FEATURE_PHASE_238: "1", STELLAR_NETWORK: "mainnet" }
    expect(() => assertNonMainnetFixture("faucet-seeder", env)).toThrow(
      /fenced and forbidden in mainnet/,
    )

    // Passes on testnet
    expect(() =>
      assertNonMainnetFixture("faucet-seeder", { FEATURE_PHASE_238: "1", STELLAR_NETWORK: "testnet" }),
    ).not.toThrow()
  })

  it("verifies mainnet cutover readiness checklist", () => {
    const incomplete = verifyMainnetCutoverReadiness({
      env: {
        FEATURE_PHASE_238: "1",
      },
    })
    expect(incomplete.ready).toBe(false)
    expect(incomplete.errors.length).toBeGreaterThan(0)

    const readyChecklist = verifyMainnetCutoverReadiness({
      issuerPublicKey: validIssuer,
      contractId: validContract,
      confirmationToken: validToken,
      env: {
        FEATURE_PHASE_238: "1",
        PHASE_MAINNET_CUTOVER_ACK: "1",
        PHASE_MAINNET_DRY_RUN: "1",
      },
    })
    expect(readyChecklist.ready).toBe(true)
    expect(readyChecklist.issuerValid).toBe(true)
    expect(readyChecklist.contractValid).toBe(true)
    expect(readyChecklist.tokenValid).toBe(true)
    expect(readyChecklist.isDryRun).toBe(true)
  })
})
