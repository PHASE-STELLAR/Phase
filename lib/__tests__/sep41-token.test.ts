import { describe, it, expect, beforeEach } from "vitest"
import { StrKey, Keypair } from "@stellar/stellar-sdk"
import {
  Sep41ClientAdapter,
  Sep41SacError,
  isPhase239Enabled,
} from "@/lib/sep41-token"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

describe("SEP-41 client adapter and SAC misuse prevention (phase-239)", () => {
  const validContractId = StrKey.encodeContract(Buffer.alloc(32, 1))
  const validAccountG = Keypair.random().publicKey()
  const validSpenderG = Keypair.random().publicKey()

  beforeEach(() => {
    resetSecurityCounters()
    process.env.FEATURE_PHASE_239 = "1"
  })

  it("checks feature flag status", () => {
    expect(isPhase239Enabled({ FEATURE_PHASE_239: "1" })).toBe(true)
    expect(isPhase239Enabled({ FEATURE_PHASE_239: "0" })).toBe(false)
  })

  it("blocks and warns when an account address G... is passed as contract ID", () => {
    expect(() => new Sep41ClientAdapter(validAccountG)).toThrow(Sep41SacError)
    expect(getSecurityCounter("sep41_sac_misuse_blocked")).toBe(1)
  })

  it("successfully instantiates adapter with valid C... contract ID", () => {
    const adapter = new Sep41ClientAdapter(validContractId)
    expect(adapter.getContractId()).toBe(validContractId)
    expect(adapter.getNetwork()).toBe("testnet")
  })

  it("reads token metadata", async () => {
    const adapter = new Sep41ClientAdapter(validContractId)
    const meta = await adapter.getMetadata()
    expect(meta.symbol).toBe("PHASE_LIQ")
    expect(meta.decimal).toBe(7)
  })

  it("reads balance and increments security counter", async () => {
    const adapter = new Sep41ClientAdapter(validContractId)
    const balance = await adapter.getBalance(validAccountG)
    expect(balance).toBeGreaterThan(0n)
    expect(getSecurityCounter("sep41_balance_read")).toBe(1)
  })

  it("blocks identical from and spender in allowance read", async () => {
    const adapter = new Sep41ClientAdapter(validContractId)
    await expect(adapter.getAllowance(validAccountG, validAccountG)).rejects.toThrow(
      Sep41SacError,
    )
    expect(getSecurityCounter("sep41_sac_misuse_blocked")).toBe(1)
  })

  it("reads allowance and increments counter for distinct addresses", async () => {
    const adapter = new Sep41ClientAdapter(validContractId)
    const allowance = await adapter.getAllowance(validAccountG, validSpenderG)
    expect(allowance).toBe(500_000_000n)
    expect(getSecurityCounter("sep41_allowance_read")).toBe(1)
  })

  it("generates deterministic testnet transaction proof with tx hash", () => {
    const adapter = new Sep41ClientAdapter(validContractId, "testnet")
    const proof = adapter.generateTestnetProof("transfer", {
      from: validAccountG,
      to: validSpenderG,
      amount: "1000",
    })
    expect(proof.network).toBe("testnet")
    expect(proof.txHash).toMatch(/^[a-f0-9]{64}$/)
    expect(getSecurityCounter("sep41_tx_proof_recorded")).toBe(1)
  })

  it("fences testnet proof generation on mainnet", () => {
    const adapter = new Sep41ClientAdapter(validContractId, "mainnet")
    expect(() =>
      adapter.generateTestnetProof("mint", {
        to: validAccountG,
        amount: "500",
      }),
    ).toThrow(/fenced from mainnet/)
  })
})
