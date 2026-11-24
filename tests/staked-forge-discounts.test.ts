import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_147 = "1"
process.env.FEATURE_PHASE_147 = "1"

import {
  getStakedFeeTier,
  calculateDiscountedForgeFee,
  FORGE_FEE_TIERS,
} from "@/lib/staked-forge-discounts"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

function testTierResolution() {
  assert.equal(getStakedFeeTier(0n).name, "Standard")
  assert.equal(getStakedFeeTier(50_000_000n).name, "Standard")
  assert.equal(getStakedFeeTier(100_000_000n).name, "Bronze")
  assert.equal(getStakedFeeTier(500_000_000n).name, "Silver")
  assert.equal(getStakedFeeTier(2_000_000_000n).name, "Gold")
  assert.equal(getStakedFeeTier(10_000_000_000n).name, "Obsidian")
  assert.equal(getStakedFeeTier(50_000_000_000n).name, "Obsidian")
}

function testCalculateDiscountedForgeFee() {
  resetSecurityCounters()
  // Standard tier (0% discount)
  const standardCalc = calculateDiscountedForgeFee(1_000_000n, 0n)
  assert.equal(standardCalc.originalFeeStroops, "1000000")
  assert.equal(standardCalc.discountedFeeStroops, "1000000")
  assert.equal(standardCalc.discountAppliedStroops, "0")

  // Gold tier (50% discount)
  const goldCalc = calculateDiscountedForgeFee(1_000_000n, 2_000_000_000n)
  assert.equal(goldCalc.originalFeeStroops, "1000000")
  assert.equal(goldCalc.discountedFeeStroops, "500000")
  assert.equal(goldCalc.discountAppliedStroops, "500000")
  assert.equal(goldCalc.tier.name, "Gold")
  assert.ok(getSecurityCounter("staked_fee_discount_applied") >= 1)

  // Obsidian tier (75% discount)
  const obsCalc = calculateDiscountedForgeFee(10_000_000n, 10_000_000_000n)
  assert.equal(obsCalc.discountedFeeStroops, "2500000")
  assert.equal(obsCalc.discountAppliedStroops, "7500000")
}

testTierResolution()
testCalculateDiscountedForgeFee()
