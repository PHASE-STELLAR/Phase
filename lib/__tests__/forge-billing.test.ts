import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Keypair } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  checkForgeQuota,
  forgeBillingRetryAfterSeconds,
  FORGE_BILLING_TIER_IDS,
  forgeBillingTierLimits,
  getForgeBillingUsage,
  recordForgeBillingEvent,
  resolveBillingTier,
  walletBillingHash,
} from "@/lib/forge/billing"

const WALLET = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("phase-test-forge-billing").digest(),
).publicKey()
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)

describe("forge billing (spike 615 / phase-177)", () => {
  let dataDir: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-forge-billing-"))
    process.env.PHASE_SERVER_DATA_DIR = dataDir
    for (const key of [
      "FEATURE_PHASE_177",
      "NEXT_PUBLIC_FEATURE_PHASE_177",
      "PHASE_FORGE_BILLING_TIERS",
      "PHASE_FORGE_BILLING_DEFAULT_TIER",
    ]) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.FEATURE_PHASE_177 = "1"
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dataDir, { recursive: true, force: true })
  })

  it("wallet billing hash is sha256 hex, never the raw wallet", () => {
    const hash = walletBillingHash(WALLET)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).not.toContain(WALLET)
  })

  it("tier limits read from env with safe defaults", () => {
    const defaults = forgeBillingTierLimits()
    expect(defaults.standard).toBe(5)
    process.env.PHASE_FORGE_BILLING_TIERS = JSON.stringify({ standard: 2, bogus: 99 })
    const overridden = forgeBillingTierLimits()
    expect(overridden.standard).toBe(2)
    process.env.PHASE_FORGE_BILLING_TIERS = "{broken"
    expect(forgeBillingTierLimits().standard).toBe(5)
  })

  it("resolveBillingTier defaults to standard", () => {
    expect(resolveBillingTier(WALLET)).toBe("standard")
    process.env.PHASE_FORGE_BILLING_DEFAULT_TIER = "gold"
    expect(resolveBillingTier(WALLET)).toBe("gold")
    process.env.PHASE_FORGE_BILLING_DEFAULT_TIER = "nope"
    expect(resolveBillingTier(WALLET)).toBe("standard")
  })

  it("allows until the daily limit is exhausted, then 429 semantics", async () => {
    process.env.PHASE_FORGE_BILLING_TIERS = JSON.stringify({ standard: 2 })
    for (let i = 0; i < 2; i++) {
      const result = await recordForgeBillingEvent(
        { wallet: WALLET, jobId: `job-${i}`, settlementTxHash: `tx-${i}` },
        { now: NOW },
      )
      expect(result.recorded).toBe(true)
    }
    const quota = await checkForgeQuota(WALLET, { now: NOW })
    expect(quota.allowed).toBe(false)
    expect(quota.used).toBe(2)
    expect(quota.limit).toBe(2)
    expect(quota.remaining).toBe(0)
    expect(forgeBillingRetryAfterSeconds(quota)).toBeGreaterThanOrEqual(60)
  })

  it("is idempotent by jobId (serverless retry safe)", async () => {
    const first = await recordForgeBillingEvent({ wallet: WALLET, jobId: "job-1" }, { now: NOW })
    const second = await recordForgeBillingEvent({ wallet: WALLET, jobId: "job-1" }, { now: NOW })
    expect(first.recorded).toBe(true)
    expect(second.duplicate).toBe(true)
    expect(second.recorded).toBe(false)
    const usage = await getForgeBillingUsage(WALLET, { now: NOW })
    expect(usage.count).toBe(1)
  })

  it("flag off always allows and records nothing", async () => {
    delete process.env.FEATURE_PHASE_177
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_177
    process.env.PHASE_FORGE_BILLING_TIERS = JSON.stringify({ standard: 1 })
    await recordForgeBillingEvent({ wallet: WALLET, jobId: "job-1" }, { now: NOW })
    const quota = await checkForgeQuota(WALLET, { now: NOW })
    expect(quota.allowed).toBe(true)
    expect(quota.used).toBe(0)
  })

  it("rejects malformed events", async () => {
    await expect(recordForgeBillingEvent({ wallet: "not-a-wallet", jobId: "" })).rejects.toMatchObject({
      name: "ForgeBillingError",
      code: "VALIDATION_FAILED",
    })
  })

  it("resets at the next UTC day", async () => {
    process.env.PHASE_FORGE_BILLING_TIERS = JSON.stringify({ standard: 1 })
    await recordForgeBillingEvent({ wallet: WALLET, jobId: "job-1" }, { now: NOW })
    const nextDay = NOW + 24 * 60 * 60 * 1000
    const quota = await checkForgeQuota(WALLET, { now: nextDay })
    expect(quota.allowed).toBe(true)
    expect(quota.used).toBe(0)
  })

  it("tier ids stay a closed set", () => {
    expect([...FORGE_BILLING_TIER_IDS]).toEqual(["standard", "bronze", "silver", "gold", "obsidian"])
  })
})
