import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const scratch = mkdtempSync(path.join(tmpdir(), "phase-buyback-test-"))
process.env.PHASE_DATA_DIR = scratch
process.env.PHASE_DATA_ROOT = scratch
process.env.NEXT_PUBLIC_FEATURE_PHASE_146 = "1"
process.env.FEATURE_PHASE_146 = "1"

import {
  executeBuybackAndBurn,
  getBuybackStats,
  listBuybackEvents,
} from "@/lib/buyback-burn"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

function testExecuteBuybackAndBurn() {
  resetSecurityCounters()
  const result = executeBuybackAndBurn(10_000_000n, "protocol_treasury", "0xabc123")
  assert.equal(result.ok, true)
  assert.ok(result.event)
  assert.equal(result.event.amountSpentStroops, "10000000")
  assert.equal(result.event.phaselqBurnedStroops, "10000000")
  assert.equal(result.event.txHash, "0xabc123")
  assert.ok(getSecurityCounter("buyback_burn_executed") >= 1)

  const stats = getBuybackStats()
  assert.ok(BigInt(stats.totalSpentStroops) >= 10_000_000n)
  assert.ok(BigInt(stats.totalBurnedStroops) >= 10_000_000n)
  assert.ok(stats.eventCount >= 1)

  const events = listBuybackEvents()
  assert.ok(events.length >= 1)
  assert.equal(events[0].id, result.event.id)
}

function testRejectNonPositiveAmount() {
  const result = executeBuybackAndBurn(0n)
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /positive/i)
}

testExecuteBuybackAndBurn()
testRejectNonPositiveAmount()
