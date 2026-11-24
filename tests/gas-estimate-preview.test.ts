/**
 * phase-78: gas-estimate preview before listing submission — tests
 * Run: npx tsx tests/gas-estimate-preview.test.ts
 */
import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_78 = "1"
process.env.FEATURE_PHASE_78 = "1"

import {
  GasEstimatePreviewError,
  auditGasEstimateWiring,
  calculateGasEstimatePreview,
  isPhase78Enabled,
  previewListingSubmissionGas,
} from "@/lib/phase-nft-metadata-build"
import {
  GAS_ESTIMATE_TTL_MS,
  MAX_GAS_FEE_STROOPS,
  MIN_GAS_FEE_STROOPS,
  computeGasInputDigest,
  isGasEstimatePreviewEnabled,
  isGasEstimateStale,
  simulateGasEstimate,
} from "@/lib/gas-estimate-preview"
import { pickCopy } from "@/lib/phase-copy"

async function testFlagEnabled() {
  assert.equal(isPhase78Enabled(), true)
  console.log("✓ phase-78 flag enabled via env")
}

async function testCalculateAllOperationTypes() {
  const operations = [
    "create_listing",
    "cancel_listing",
    "accept_offer",
    "mint_token",
    "transfer_nft",
    "update_price",
  ] as const

  for (const op of operations) {
    const preview = calculateGasEstimatePreview({ operationType: op })
    assert.equal(preview.operationType, op)
    assert.ok(preview.baseFeeStroops >= 100)
    assert.ok(preview.resourceFeeStroops > 0)
    assert.ok(preview.totalFeeStroops > preview.baseFeeStroops)
    assert.ok(typeof preview.totalFeeXlm === "string")
    assert.ok(parseFloat(preview.totalFeeXlm) > 0)
    assert.ok(preview.breakdown.cpuFeeStroops > 0)
    assert.ok(preview.breakdown.storageFeeStroops > 0)
  }
  console.log("✓ gas previews calculated across all Soroban contract operations")
}

async function testBufferedMultiplier() {
  const standard = calculateGasEstimatePreview({ operationType: "create_listing", bufferedMultiplier: 1.0 })
  const buffered = calculateGasEstimatePreview({ operationType: "create_listing", bufferedMultiplier: 1.5 })

  assert.equal(standard.confidenceLevel, "conservative")
  assert.equal(buffered.confidenceLevel, "buffered")
  assert.ok(buffered.totalFeeStroops > standard.totalFeeStroops)
  assert.equal(buffered.breakdown.bufferStroops, buffered.totalFeeStroops - (buffered.baseFeeStroops + buffered.resourceFeeStroops))
  console.log("✓ buffered multiplier properly computes safety headroom")
}

async function testListingSubmissionHelper() {
  const preview = previewListingSubmissionGas({ tokenId: 1, pricePhaselq: 50 })
  assert.equal(preview.operationType, "create_listing")
  assert.ok(preview.totalFeeStroops > 0)
  console.log(`✓ listing submission helper returns preview (${preview.totalFeeXlm} XLM)`)
}

async function testValidationErrors() {
  let threw = false
  try {
    calculateGasEstimatePreview({ operationType: "invalid_op" })
  } catch (e) {
    threw = e instanceof GasEstimatePreviewError && e.code === "VALIDATION_FAILED"
  }
  assert.equal(threw, true)
  console.log("✓ invalid operation throws VALIDATION_FAILED")
}

async function testFlagDisabledBlocksCalculation() {
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_78
  delete process.env.FEATURE_PHASE_78
  assert.equal(isPhase78Enabled(), false)

  let threw = false
  try {
    calculateGasEstimatePreview({ operationType: "create_listing" })
  } catch (e) {
    threw = e instanceof GasEstimatePreviewError && e.code === "FLAG_DISABLED"
  }
  assert.equal(threw, true)

  // Can bypass with force: true
  const forced = calculateGasEstimatePreview({ operationType: "create_listing" }, { force: true })
  assert.equal(forced.operationType, "create_listing")

  process.env.NEXT_PUBLIC_FEATURE_PHASE_78 = "1"
  process.env.FEATURE_PHASE_78 = "1"
  console.log("✓ calculation blocked when phase-78 disabled unless force provided")
}

async function testWiringAudit() {
  const audit = auditGasEstimateWiring()
  assert.equal(audit.ok, true)
  assert.ok(audit.note.includes("gas-estimate preview OK"))
  console.log("✓ wiring audit succeeds")
}

async function testPhase256SigningPreview() {
  // 1. Flag off = no preview step
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_256
  delete process.env.FEATURE_PHASE_256
  assert.equal(isGasEstimatePreviewEnabled(), false)
  const offRes = await simulateGasEstimate({ operationType: "create_listing" })
  assert.equal(offRes, null)

  // 2. Flag on: bounded estimate + updates when inputs change
  process.env.NEXT_PUBLIC_FEATURE_PHASE_256 = "1"
  assert.equal(isGasEstimatePreviewEnabled(), true)

  const simA = await simulateGasEstimate(
    { operationType: "create_listing", payloadSizeBytes: 512 },
    {
      nowMs: 1_000_000,
      simulator: async () => ({ baseFeeStroops: 100, minResourceFeeStroops: 2400 }),
    },
  )
  const simB = await simulateGasEstimate(
    { operationType: "mint_token", payloadSizeBytes: 2048 },
    {
      nowMs: 1_000_000,
      simulator: async () => ({ baseFeeStroops: 100, minResourceFeeStroops: 9800 }),
    },
  )
  assert.ok(simA && simB)
  assert.equal(simA.status, "simulated")
  assert.equal(simA.isGuarantee, false)
  assert.notEqual(simA.inputDigest, simB.inputDigest)
  assert.ok(simB.estimatedFeeStroops > simA.estimatedFeeStroops)
  assert.ok(simA.maxFeeStroops >= MIN_GAS_FEE_STROOPS && simA.maxFeeStroops <= MAX_GAS_FEE_STROOPS)
  assert.equal(
    computeGasInputDigest({ operationType: "create_listing", payloadSizeBytes: 512 }),
    simA.inputDigest,
  )

  // 3. Stale estimate is labeled after TTL
  assert.equal(isGasEstimateStale(simA, 1_000_000 + 5_000), false)
  assert.equal(isGasEstimateStale(simA, 1_000_000 + GAS_ESTIMATE_TTL_MS), true)

  // 4. Simulation failure shows an honest fallback
  const fallback = await simulateGasEstimate(
    { operationType: "accept_offer" },
    {
      nowMs: 2_000_000,
      simulator: async () => {
        throw new Error("soroban_rpc_timeout")
      },
    },
  )
  assert.ok(fallback)
  assert.equal(fallback.status, "fallback")
  assert.equal(fallback.isGuarantee, false)
  assert.equal(fallback.fallbackReason, "soroban_rpc_timeout")
  assert.ok(fallback.maxFeeStroops >= MIN_GAS_FEE_STROOPS)

  // 5. EN/ES copy present
  assert.ok(pickCopy("en").gasEstimatePreview.disclaimer.length > 0)
  assert.ok(pickCopy("es").gasEstimatePreview.disclaimer.length > 0)

  console.log("✓ phase-256 gas estimate preview (flag gate, input change, staleness, fallback, EN/ES) passed")
}

async function run() {
  await testFlagEnabled()
  await testCalculateAllOperationTypes()
  await testBufferedMultiplier()
  await testListingSubmissionHelper()
  await testValidationErrors()
  await testFlagDisabledBlocksCalculation()
  await testWiringAudit()
  await testPhase256SigningPreview()
  console.log("\nAll gas-estimate preview (phase-78 + phase-256) tests passed.\n")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
