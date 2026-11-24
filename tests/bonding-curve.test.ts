import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const scratch = mkdtempSync(path.join(tmpdir(), "phase-curve-test-"))
process.env.PHASE_DATA_DIR = scratch
process.env.PHASE_DATA_ROOT = scratch
process.env.NEXT_PUBLIC_FEATURE_PHASE_148 = "1"
process.env.FEATURE_PHASE_148 = "1"

import {
  priceAtSupply,
  quoteMint,
  quoteBurn,
  setBondingCurveParams,
  getBondingCurveParams,
  recordBondingCurveMint,
  recordBondingCurveBurn,
} from "@/lib/bonding-curve"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

function testFormulas() {
  const base = 10_000_000n // 1 PHASELQ
  const slope = 100_000n   // 0.01 PHASELQ

  // price(0) = base = 10_000_000
  assert.equal(priceAtSupply(base, slope, 0), 10_000_000n)
  // price(5) = 10_000_000 + 5 * 100_000 = 10_500_000
  assert.equal(priceAtSupply(base, slope, 5), 10_500_000n)

  const params = {
    collectionId: 999,
    basePriceStroops: base,
    slopeStroops: slope,
    currentSupply: 0,
    maxSupply: 1000,
    reserveStroops: 0n,
  }

  // Mint 2 from 0:
  // unit 0: 10_000_000
  // unit 1: 10_100_000
  // total = 20_100_000
  const mintQuote = quoteMint(params, 2)
  assert.equal(mintQuote.totalPriceStroops, "20100000")
  assert.equal(mintQuote.newSupply, 2)
}

function testDatabaseOperations() {
  resetSecurityCounters()
  const collectionId = 42
  setBondingCurveParams({
    collectionId,
    basePriceStroops: 10_000_000n,
    slopeStroops: 100_000n,
    currentSupply: 0,
    maxSupply: 500,
    reserveStroops: 0n,
  })

  const stored = getBondingCurveParams(collectionId)
  assert.ok(stored)
  assert.equal(stored.currentSupply, 0)

  // Commit mint
  const mintRes = recordBondingCurveMint(collectionId, 2)
  assert.equal(mintRes.newSupply, 2)
  assert.equal(mintRes.totalPriceStroops, "20100000")
  assert.ok(getSecurityCounter("bonding_curve_mint") >= 1)

  const afterMint = getBondingCurveParams(collectionId)
  assert.equal(afterMint?.currentSupply, 2)
  assert.equal(afterMint?.reserveStroops, 20_100_000n)

  // Commit burn 1
  const burnRes = recordBondingCurveBurn(collectionId, 1)
  assert.equal(burnRes.newSupply, 1)
  assert.equal(burnRes.totalRefundStroops, "10100000")
  assert.ok(getSecurityCounter("bonding_curve_burn") >= 1)

  const afterBurn = getBondingCurveParams(collectionId)
  assert.equal(afterBurn?.currentSupply, 1)
  assert.equal(afterBurn?.reserveStroops, 10_000_000n)
}

testFormulas()
testDatabaseOperations()
