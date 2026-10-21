import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assignExperimentVariant,
  EXPERIMENT_CONTROL_VARIANT_ID,
  ExperimentError,
  experimentBucket,
  experimentSubjectKey,
  FORGE_PRICE_EXPERIMENT_ID,
  getExperimentSummary,
  loadForgeExperimentConfig,
  parseExperimentConfig,
  resolveForgeExperimentCopyKey,
  resolveForgeRequiredAmountStroops,
} from "@/lib/experiments"
import { REQUIRED_AMOUNT } from "@/lib/phase-protocol"

const WALLET = "GAXGYD5H4J5XQQ0W6NXKJ6TRJZ4NXBTSNSGQ2MGE43LQX4KJQK5V5V5V"

function config(overrides: Record<string, unknown> = {}) {
  return {
    experimentId: FORGE_PRICE_EXPERIMENT_ID,
    enabled: true,
    salt: "test-salt",
    holdoutPercent: 0,
    variants: [
      { id: "control", weight: 1 },
      { id: "price_cut", weight: 9999, priceStroops: "5000000", copyKey: "price_cut" },
    ],
    ...overrides,
  }
}

describe("experiments (spike 612 / phase-174)", () => {
  let dataDir: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-experiments-"))
    process.env.PHASE_SERVER_DATA_DIR = dataDir
    for (const key of ["FEATURE_PHASE_174", "NEXT_PUBLIC_FEATURE_PHASE_174", "PHASE_EXPERIMENT_CONFIG", "PHASE_EXPERIMENT_SALT"]) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.FEATURE_PHASE_174 = "1"
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dataDir, { recursive: true, force: true })
  })

  it("deterministic bucket depends on salt, experiment and subject", () => {
    const a = experimentBucket("s1", "exp", WALLET)
    const b = experimentBucket("s1", "exp", WALLET)
    const c = experimentBucket("s2", "exp", WALLET)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(10_000)
    expect(c).not.toBe(a)
  })

  it("subject keys are sha256 hex and never the raw wallet", () => {
    const key = experimentSubjectKey(WALLET)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(key).not.toContain(WALLET)
  })

  it("rejects invalid configs with VALIDATION_FAILED", () => {
    expect(() => parseExperimentConfig({ experimentId: "x", variants: [] })).toThrowError(ExperimentError)
  })

  it("fails safe to control when no config is set", async () => {
    const resolution = await resolveForgeRequiredAmountStroops(WALLET)
    expect(resolution.amountStroops).toBe(REQUIRED_AMOUNT)
    expect(resolution.variantId).toBe(EXPERIMENT_CONTROL_VARIANT_ID)
  })

  it("fails safe to control when PHASE_EXPERIMENT_CONFIG is garbage", async () => {
    process.env.PHASE_EXPERIMENT_CONFIG = "{not json"
    expect(loadForgeExperimentConfig()).toBeNull()
    const resolution = await resolveForgeRequiredAmountStroops(WALLET)
    expect(resolution.amountStroops).toBe(REQUIRED_AMOUNT)
  })

  it("resolves the variant price for an assigned subject", async () => {
    process.env.PHASE_EXPERIMENT_CONFIG = JSON.stringify(config())
    const bucket = experimentBucket("test-salt", FORGE_PRICE_EXPERIMENT_ID, WALLET)
    const resolution = await resolveForgeRequiredAmountStroops(WALLET)
    // Weight 1 vs 9999: only bucket 0 lands on control.
    if (bucket === 0) {
      expect(resolution.amountStroops).toBe(REQUIRED_AMOUNT)
    } else {
      expect(resolution.variantId).toBe("price_cut")
      expect(resolution.amountStroops).toBe("5000000")
    }
  })

  it("control variant resolves to REQUIRED_AMOUNT", async () => {
    process.env.PHASE_EXPERIMENT_CONFIG = JSON.stringify(
      config({
        variants: [
          { id: "control", weight: 10_000 },
          { id: "price_cut", weight: 1, priceStroops: "5000000" },
        ],
      }),
    )
    const resolution = await resolveForgeRequiredAmountStroops(WALLET)
    expect(resolution.amountStroops).toBe(REQUIRED_AMOUNT)
  })

  it("holdout subjects get the control price", async () => {
    process.env.PHASE_EXPERIMENT_CONFIG = JSON.stringify(config({ holdoutPercent: 90 }))
    // Find a subject whose bucket falls inside the holdout slice.
    let holdoutSubject = ""
    for (let i = 0; i < 200; i++) {
      const candidate = `SESSION-${i}`
      if (experimentBucket("test-salt", FORGE_PRICE_EXPERIMENT_ID, candidate) < 9000) {
        holdoutSubject = candidate
        break
      }
    }
    expect(holdoutSubject).not.toBe("")
    const resolution = await resolveForgeRequiredAmountStroops(holdoutSubject)
    expect(resolution.holdout).toBe(true)
    expect(resolution.amountStroops).toBe(REQUIRED_AMOUNT)
  })

  it("assignments are sticky across salt rotation and weight changes", async () => {
    process.env.PHASE_EXPERIMENT_CONFIG = JSON.stringify(config())
    const first = await assignExperimentVariant(parseExperimentConfig(config()), WALLET)

    process.env.PHASE_EXPERIMENT_SALT = "rotated-salt"
    const rotated = config({
      salt: "rotated-salt",
      variants: [
        { id: "control", weight: 10_000 },
        { id: "price_cut", weight: 1, priceStroops: "5000000" },
      ],
    })
    const second = await assignExperimentVariant(parseExperimentConfig(rotated), WALLET)
    expect(second.variantId).toBe(first.variantId)
    expect(second.sticky).toBe(true)
  })

  it("experiment summary counts variants without exposing subjects", async () => {
    process.env.PHASE_EXPERIMENT_CONFIG = JSON.stringify(config())
    await resolveForgeRequiredAmountStroops(WALLET)
    await resolveForgeRequiredAmountStroops("GSECONDWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2")
    const summary = await getExperimentSummary(FORGE_PRICE_EXPERIMENT_ID)
    expect(summary.totalAssignments).toBe(2)
    const total = Object.values(summary.byVariant).reduce((a, b) => a + b, 0) + summary.holdout
    expect(total).toBe(2)
  })

  it("flag off throws FLAG_DISABLED from assignExperimentVariant", async () => {
    delete process.env.FEATURE_PHASE_174
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_174
    await expect(assignExperimentVariant(parseExperimentConfig(config()), WALLET)).rejects.toMatchObject({
      name: "ExperimentError",
      code: "FLAG_DISABLED",
    })
  })

  it("copy key resolution returns control when flag off", async () => {
    delete process.env.FEATURE_PHASE_174
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_174
    const key = await resolveForgeExperimentCopyKey(WALLET)
    expect(key).toBe(EXPERIMENT_CONTROL_VARIANT_ID)
  })
})
