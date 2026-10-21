import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const scratch = mkdtempSync(path.join(tmpdir(), "phase-agent-mm-test-"))
process.env.PHASE_DATA_DIR = scratch
process.env.PHASE_DATA_ROOT = scratch
process.env.NEXT_PUBLIC_FEATURE_PHASE_151 = "1"
process.env.FEATURE_PHASE_151 = "1"

import {
  calculateAgentQuotes,
  publishAgentQuote,
  getAgentQuotes,
  cancelAgentQuote,
} from "@/lib/agent-market-maker"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const AGENT_WALLET = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

function testQuoteFormulas() {
  const mid = 10_000_000n // 1 PHASELQ
  // Balanced inventory: 5/10
  const balanced = calculateAgentQuotes(mid, 400, 5, 10)
  assert.equal(balanced.inventorySkewPct, 50)
  assert.equal(balanced.inventoryLimitExceeded, false)
  // Bid < mid < Ask
  assert.ok(BigInt(balanced.bidPriceStroops) < mid)
  assert.ok(BigInt(balanced.askPriceStroops) > mid)

  // Max inventory: 10/10
  const full = calculateAgentQuotes(mid, 400, 10, 10)
  assert.equal(full.inventoryLimitExceeded, true)
}

function testPublishAndCancelQuote() {
  resetSecurityCounters()

  // Normal quote
  const res = publishAgentQuote({
    agentWallet: AGENT_WALLET,
    collectionId: 77,
    midPriceStroops: 10_000_000n,
    bidSize: 2,
    askSize: 2,
    inventoryUnits: 3,
    maxInventoryUnits: 10,
  })

  assert.equal(res.ok, true)
  assert.ok(res.quote)
  assert.equal(res.quote.collectionId, 77)
  assert.equal(res.quote.bidSize, 2)
  assert.ok(getSecurityCounter("agent_quotes_published") >= 1)

  // Retrieve quote
  const quotes = getAgentQuotes(77, AGENT_WALLET)
  assert.ok(quotes.length >= 1)
  assert.equal(quotes[0].id, res.quote.id)

  // Cancel quote
  const cancelled = cancelAgentQuote(res.quote.id, AGENT_WALLET)
  assert.equal(cancelled, true)

  // Inventory limit breach: inventory 10/10 with bidSize > 0
  const breach = publishAgentQuote({
    agentWallet: AGENT_WALLET,
    collectionId: 77,
    midPriceStroops: 10_000_000n,
    bidSize: 2,
    askSize: 2,
    inventoryUnits: 10,
    maxInventoryUnits: 10,
  })
  assert.equal(breach.ok, false)
  assert.match(breach.error ?? "", /inventory limit breached/i)
  assert.ok(getSecurityCounter("agent_inventory_limit_breaches") >= 1)
}

testQuoteFormulas()
testPublishAndCancelQuote()
