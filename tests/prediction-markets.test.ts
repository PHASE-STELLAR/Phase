import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const scratch = mkdtempSync(path.join(tmpdir(), "phase-pred-test-"))
process.env.PHASE_DATA_DIR = scratch
process.env.PHASE_DATA_ROOT = scratch
process.env.NEXT_PUBLIC_FEATURE_PHASE_149 = "1"
process.env.FEATURE_PHASE_149 = "1"

import {
  createPredictionMarket,
  buyPredictionShares,
  resolvePredictionMarket,
  claimPredictionPayout,
  listPredictionMarkets,
  getPositionsForWallet,
} from "@/lib/prediction-markets"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const ALICE = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
const BOB = "GC3C4AKRBQLHOJ45U4XGNCESAMCRAFODXKCEOG7TFAXK5RZWCR4GWRPFP"

function testMarketLifecycle() {
  resetSecurityCounters()
  const closesAt = Date.now() + 3600_000
  const market = createPredictionMarket(
    "Will Drop #10 sell out within 24 hours?",
    "drop_outcome",
    closesAt,
    10,
    10_000_000n, // 1 PHASELQ seed pool
  )

  assert.equal(market.status, "active")
  assert.equal(market.outcomeYesPool, "5000000")
  assert.equal(market.outcomeNoPool, "5000000")
  assert.ok(getSecurityCounter("prediction_market_created") >= 1)

  // Alice bets 10_000_000 on YES
  const aliceRes = buyPredictionShares(market.id, ALICE, "YES", 10_000_000n)
  assert.equal(aliceRes.ok, true)
  assert.ok(aliceRes.position)
  assert.equal(aliceRes.position.outcome, "YES")
  assert.ok(aliceRes.position.shares > 0)
  assert.ok(getSecurityCounter("prediction_position_opened") >= 1)

  // Bob bets 5_000_000 on NO
  const bobRes = buyPredictionShares(market.id, BOB, "NO", 5_000_000n)
  assert.equal(bobRes.ok, true)

  // Verify positions
  const alicePositions = getPositionsForWallet(ALICE)
  assert.equal(alicePositions.length, 1)

  // Resolve to YES
  const resolveRes = resolvePredictionMarket(market.id, "YES")
  assert.equal(resolveRes.ok, true)
  assert.ok(getSecurityCounter("prediction_market_resolved") >= 1)

  // Alice claims payout
  const claimRes = claimPredictionPayout(aliceRes.position.id, ALICE)
  assert.equal(claimRes.ok, true)
  assert.ok(BigInt(claimRes.payoutStroops || "0") > 0n)
  assert.ok(getSecurityCounter("prediction_payout_claimed") >= 1)

  // Bob tries to claim on losing outcome
  const bobClaim = claimPredictionPayout(bobRes.position!.id, BOB)
  assert.equal(bobClaim.ok, false)
  assert.match(bobClaim.error ?? "", /losing outcome/i)
}

testMarketLifecycle()
