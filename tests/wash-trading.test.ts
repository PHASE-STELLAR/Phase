/**
 * phase-77: wash-trading detection heuristics for listings — tests
 * Run: npx tsx tests/wash-trading.test.ts
 */
import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_77 = "1"
process.env.FEATURE_PHASE_77 = "1"

import {
  WashTradingDetectionError,
  analyzeWashTradingRisk,
  auditWashTradingWiring,
  detectCircularTrades,
  detectRapidFlips,
  detectSelfTrading,
  isPhase77Enabled,
  type TradeRecord,
} from "@/lib/stellar"

const WALLET_A = "GA" + "A".repeat(54)
const WALLET_B = "GB" + "B".repeat(53) + "A"
const WALLET_C = "GC" + "C".repeat(53) + "B"

async function testFlagEnabled() {
  assert.equal(isPhase77Enabled(), true)
  console.log("✓ phase-77 flag enabled via env")
}

async function testSelfTradingDetection() {
  const trades: TradeRecord[] = [
    {
      tradeId: "t-self-1",
      tokenId: 1,
      collectionId: 0,
      sellerWallet: WALLET_A,
      buyerWallet: WALLET_A, // Same wallet
      pricePhaselq: 500,
      timestamp: 1000,
    },
  ]

  const detected = detectSelfTrading(trades)
  assert.equal(detected.flaggedIds.length, 1)
  assert.equal(detected.flaggedIds[0], "t-self-1")

  const analysis = analyzeWashTradingRisk({ tokenId: 1, collectionId: 0, trades })
  assert.equal(analysis.isSuspicious, true)
  assert.ok(analysis.detectedPatterns.includes("self_trading"))
  assert.ok(analysis.riskScore >= 50)
  console.log("✓ self-trading correctly flagged with high risk score")
}

async function testCircularTradeDetection() {
  const trades: TradeRecord[] = [
    {
      tradeId: "t-circ-1",
      tokenId: 2,
      collectionId: 0,
      sellerWallet: WALLET_A,
      buyerWallet: WALLET_B,
      pricePhaselq: 100,
      timestamp: 1000,
    },
    {
      tradeId: "t-circ-2",
      tokenId: 2,
      collectionId: 0,
      sellerWallet: WALLET_B,
      buyerWallet: WALLET_A, // Back to A
      pricePhaselq: 110,
      timestamp: 5000,
    },
  ]

  const detected = detectCircularTrades(trades)
  assert.equal(detected.flaggedIds.length, 2)

  const analysis = analyzeWashTradingRisk({ tokenId: 2, collectionId: 0, trades })
  assert.equal(analysis.isSuspicious, true)
  assert.ok(analysis.detectedPatterns.includes("circular_trade"))
  assert.ok(analysis.riskScore >= 40)
  console.log("✓ circular trading (A -> B -> A) detected and flagged")
}

async function testRapidFlipDetection() {
  const trades: TradeRecord[] = [
    {
      tradeId: "t-flip-1",
      tokenId: 3,
      collectionId: 0,
      sellerWallet: WALLET_A,
      buyerWallet: WALLET_B,
      pricePhaselq: 50,
      timestamp: 1000,
    },
    {
      tradeId: "t-flip-2",
      tokenId: 3,
      collectionId: 0,
      sellerWallet: WALLET_B,
      buyerWallet: WALLET_C,
      pricePhaselq: 200, // 4x price surge in 5 minutes
      timestamp: 1000 + 300_000,
    },
  ]

  const detected = detectRapidFlips(trades)
  assert.equal(detected.flaggedIds.length, 2)

  const analysis = analyzeWashTradingRisk({ tokenId: 3, collectionId: 0, trades })
  assert.ok(analysis.detectedPatterns.includes("rapid_flip"))
  console.log("✓ rapid markup flip detected")
}

async function testCleanOrganicTrades() {
  const trades: TradeRecord[] = [
    {
      tradeId: "t-clean-1",
      tokenId: 4,
      collectionId: 0,
      sellerWallet: WALLET_A,
      buyerWallet: WALLET_B,
      pricePhaselq: 100,
      timestamp: 1000,
    },
    {
      tradeId: "t-clean-2",
      tokenId: 4,
      collectionId: 0,
      sellerWallet: WALLET_B,
      buyerWallet: WALLET_C,
      pricePhaselq: 105, // Normal hold time, normal price
      timestamp: 1000 + 7 * 86400000, // 7 days later
    },
  ]

  const analysis = analyzeWashTradingRisk({ tokenId: 4, collectionId: 0, trades })
  assert.equal(analysis.isSuspicious, false)
  assert.equal(analysis.detectedPatterns.length, 0)
  assert.equal(analysis.flaggedTradeIds.length, 0)
  console.log("✓ organic trade history receives clean assessment")
}

async function testFlagDisabledBlocksAnalysis() {
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_77
  delete process.env.FEATURE_PHASE_77
  assert.equal(isPhase77Enabled(), false)

  let threw = false
  try {
    analyzeWashTradingRisk({ tokenId: 1, trades: [] })
  } catch (e) {
    threw = e instanceof WashTradingDetectionError && e.code === "FLAG_DISABLED"
  }
  assert.equal(threw, true)

  // Can bypass with force: true
  const forced = analyzeWashTradingRisk({ tokenId: 1, trades: [] }, { force: true })
  assert.equal(forced.analyzedTradesCount, 0)

  process.env.NEXT_PUBLIC_FEATURE_PHASE_77 = "1"
  process.env.FEATURE_PHASE_77 = "1"
  console.log("✓ analysis blocked when phase-77 disabled unless force provided")
}

async function testWiringAudit() {
  const audit = auditWashTradingWiring()
  assert.equal(audit.ok, true)
  assert.ok(audit.note.includes("wash-trading heuristics OK"))
  console.log("✓ wiring audit succeeds")
}

async function run() {
  await testFlagEnabled()
  await testSelfTradingDetection()
  await testCircularTradeDetection()
  await testRapidFlipDetection()
  await testCleanOrganicTrades()
  await testFlagDisabledBlocksAnalysis()
  await testWiringAudit()
  console.log("\nAll wash-trading (phase-77) tests passed.\n")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
