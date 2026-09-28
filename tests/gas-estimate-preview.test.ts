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

async function run() {
  await testFlagEnabled()
  await testCalculateAllOperationTypes()
  await testBufferedMultiplier()
  await testListingSubmissionHelper()
  await testValidationErrors()
  await testFlagDisabledBlocksCalculation()
  await testWiringAudit()
  console.log("\nAll gas-estimate preview (phase-78) tests passed.\n")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
