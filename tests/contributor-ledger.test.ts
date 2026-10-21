/**
 * phase-116: contributor attribution & credit ledger — tests
 * Run: npx tsx tests/contributor-ledger.test.ts
 */
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

process.env.NEXT_PUBLIC_FEATURE_PHASE_116 = "1"
process.env.FEATURE_PHASE_116 = "1"
process.env.PHASE_SERVER_DATA_DIR = path.join(os.tmpdir(), `phase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)

import {
  addSignalContributor,
  getSignalContributors,
  computeCreditLedger,
  getGlobalCreditStats,
  ContributorLedgerError,
  isPhase116Enabled,
} from "@/lib/contributor-ledger"

// Use deterministic fake G addresses that pass regex ^G[A-Z2-7]{55}$ (valid base32)
function makeFakeG(suffix: string): string {
  const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let core = ""
  for (let i = 0; i < 55; i++) {
    const ch = suffix.charCodeAt(i % suffix.length) % 32
    core += base32[ch]!
  }
  return `G${core}`
}
let counter = 0
function randomG(): string {
  counter++
  return makeFakeG(`seed${counter}-${Date.now()}-${counter}`)
}
// Known valid Gs for variety (still pass regex)
const WALLET_A = "GA" + "A".repeat(54)

async function testAddAndLedger() {
  const sig = `sig-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
  const w1 = randomG()
  const w2 = randomG()
  const w3 = randomG()

  const r1 = await addSignalContributor(sig, { wallet: w1, displayName: "Alice", role: "author", shareBps: 5000, addedBy: w1, signature: null })
  assert.equal(r1.contributors.length, 1)
  assert.equal(r1.totalShareBps, 5000)

  const r2 = await addSignalContributor(sig, { wallet: w2, displayName: "Bob", role: "co_author", shareBps: 3000, addedBy: w1, signature: null })
  assert.equal(r2.totalShareBps, 8000)

  const r3 = await addSignalContributor(sig, { wallet: w3, displayName: "Cara", role: "editor", shareBps: 2000, addedBy: w1, signature: null })
  assert.equal(r3.totalShareBps, 10000)

  const ledger = await computeCreditLedger(sig)
  assert.equal(ledger.length, 3)
  assert.equal(ledger[0]?.wallet, w1)
  assert.equal(ledger[0]?.totalShareBps, 5000)

  const fetched = await getSignalContributors(sig)
  assert.equal(fetched?.signalId, sig)
  console.log("✓ add contributors & ledger")
}

async function testShareOverflow() {
  const sig = `sig-overflow-${Date.now()}`
  const w1 = randomG()
  const w2 = randomG()
  await addSignalContributor(sig, { wallet: w1, displayName: "A", role: "author", shareBps: 9000, addedBy: w1, signature: null })
  let threw = false
  try {
    await addSignalContributor(sig, { wallet: w2, displayName: "B", role: "co_author", shareBps: 2000, addedBy: w1, signature: null })
  } catch (e) {
    threw = e instanceof ContributorLedgerError && e.code === "SHARE_OVERFLOW"
  }
  assert.equal(threw, true)
  console.log("✓ share overflow blocked")
}

async function testDuplicate() {
  const sig = `sig-dup-${Date.now()}`
  const w1 = randomG()
  await addSignalContributor(sig, { wallet: w1, displayName: "A", role: "co_author", shareBps: 1000, addedBy: w1, signature: null })
  let threw = false
  try {
    await addSignalContributor(sig, { wallet: w1, displayName: "A", role: "co_author", shareBps: 500, addedBy: w1, signature: null })
  } catch (e) {
    threw = e instanceof ContributorLedgerError && e.code === "DUPLICATE"
  }
  assert.equal(threw, true)
  console.log("✓ duplicate blocked")
}

async function testGlobalStats() {
  const stats = await getGlobalCreditStats()
  assert.ok(stats.totalSignals >= 3, `signals ${stats.totalSignals} >=3`)
  assert.ok(stats.totalContributors >= 5, `contributors ${stats.totalContributors} >=5`)
  console.log("✓ global stats", stats)
}

async function testFlag() {
  assert.equal(isPhase116Enabled(), true)
  // when flag off, add should throw FLAG_DISABLED
  process.env.NEXT_PUBLIC_FEATURE_PHASE_116 = "0"
  process.env.FEATURE_PHASE_116 = "0"
  // need to re-import? flag reads env dynamically, so next call sees false
  let threw = false
  try {
    await addSignalContributor(`sig-flag-${Date.now()}`, { wallet: randomG(), displayName: "X", role: "author", shareBps: 100, addedBy: null, signature: null })
  } catch (e) {
    threw = e instanceof ContributorLedgerError && e.code === "FLAG_DISABLED"
  }
  assert.equal(threw, true)
  // restore
  process.env.NEXT_PUBLIC_FEATURE_PHASE_116 = "1"
  process.env.FEATURE_PHASE_116 = "1"
  console.log("✓ flag gating")
}

async function testValidation() {
  let threw = false
  try {
    await addSignalContributor("sig-bad", { wallet: "bad", displayName: "Bad", role: "author", shareBps: 100, addedBy: null, signature: null })
  } catch (e) {
    threw = e instanceof ContributorLedgerError && e.code === "VALIDATION_FAILED"
  }
  assert.equal(threw, true)
  console.log("✓ validation failed on bad wallet")
}

async function cleanup() {
  try {
    const dir = process.env.PHASE_SERVER_DATA_DIR!
    await fs.rm(dir, { recursive: true, force: true })
  } catch {}
}

async function main() {
  console.log("=== phase-116 tests ===")
  await testAddAndLedger()
  await testShareOverflow()
  await testDuplicate()
  await testGlobalStats()
  await testFlag()
  await testValidation()
  console.log("=== phase-116 all passed ===")
  await cleanup()
}

main().catch(async (e) => {
  console.error("phase-116 test failed:", e)
  await cleanup()
  process.exit(1)
})
