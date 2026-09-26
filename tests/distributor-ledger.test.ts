/**
 * Distributor ledger: concurrent refill double-spend (issue #231) — tests
 * Run: npx tsx tests/distributor-ledger.test.ts
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const scratch = mkdtempSync(path.join(tmpdir(), "phase-ledger-"))
process.env.PHASE_DATA_DIR = scratch
process.env.PHASE_DATA_ROOT = scratch

import {
  availableBalance,
  commitRefill,
  distributorLedgerStats,
  ensureDistributorLedger,
  readLedger,
  releaseRefill,
  reserveFunds,
  resetLedgerForTests,
  setLedgerBalance,
} from "@/lib/distributor-ledger"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const DISTRIBUTOR = "GBRPYHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX"
const RESERVE = 5_000_000n
const FEE_RESERVE = 1_000_000n

function seed(balance: bigint) {
  resetLedgerForTests(DISTRIBUTOR)
  ensureDistributorLedger(DISTRIBUTOR, {
    balanceStroops: Number(balance),
    reserveStroops: Number(RESERVE),
    feeReserveStroops: Number(FEE_RESERVE),
  })
}

function testAvailableSubtractsReserveAndPending() {
  seed(100_000_000n) // 10 PHASELQ
  // available = balance - reserve - feeReserve - pending
  assert.equal(availableBalance(DISTRIBUTOR), 100_000_000n - RESERVE - FEE_RESERVE)
}

function testReserveIsRefusedWhenInsufficient() {
  seed(6_000_000n) // below reserve + fee reserve
  const result = reserveFunds({ distributor: DISTRIBUTOR, amountStroops: "50000000", purpose: "auto_refill" })
  assert.equal(result.ok, false, "an unaffordable refill must be refused")
  assert.equal(result.ok === false && result.code, "INSUFFICIENT_AVAILABLE")
}

function testUnknownDistributorIsRefused() {
  resetLedgerForTests()
  const result = reserveFunds({ distributor: "GUNKNOWN", amountStroops: "1", purpose: "x" })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, "UNKNOWN_DISTRIBUTOR")
}

function testTwoConcurrentReservationsCannotBothSpend() {
  // The double-spend in #231: two refills each see the same available balance
  // and both proceed. With a check-and-hold in one IMMEDIATE transaction,
  // exactly one may hold the funds.
  seed(100_000_000n) // available = 94_000_000
  const half = "50000000" // each wants 50 PHASELQ, only 47 available

  const first = reserveFunds({ distributor: DISTRIBUTOR, amountStroops: half, purpose: "auto_refill" })
  const second = reserveFunds({ distributor: DISTRIBUTOR, amountStroops: half, purpose: "auto_refill" })

  assert.equal(first.ok, true, "the first reservation should win")
  assert.equal(second.ok, false, "the second must not also reserve the same funds")
  assert.equal(second.ok === false && second.code, "INSUFFICIENT_AVAILABLE")
}

function testConcurrentReservationsRespectPending() {
  // Two refills that each fit individually but not together.
  seed(100_000_000n) // available 94_000_000
  const each = "40000000"

  const a = reserveFunds({ distributor: DISTRIBUTOR, amountStroops: each, purpose: "auto_refill" })
  const b = reserveFunds({ distributor: DISTRIBUTOR, amountStroops: each, purpose: "auto_refill" })
  const c = reserveFunds({ distributor: DISTRIBUTOR, amountStroops: each, purpose: "auto_refill" })

  assert.equal(a.ok, true)
  assert.equal(b.ok, true, "40 + 40 <= 94 fits")
  assert.equal(c.ok, false, "the third exceeds the remaining 14")
}

function testReleaseFreesTheHold() {
  seed(100_000_000n)
  const hold = reserveFunds({ distributor: DISTRIBUTOR, amountStroops: "60000000", purpose: "auto_refill" })
  assert.equal(hold.ok, true)
  assert.equal(availableBalance(DISTRIBUTOR), 34_000_000n)

  const released = releaseRefill(hold.ok ? hold.holdId : "")
  assert.equal(released, true)
  // After release the full available balance is spendable again.
  assert.equal(availableBalance(DISTRIBUTOR), 94_000_000n)
}

function testCommitIsIdempotent() {
  seed(100_000_000n)
  const hold = reserveFunds({ distributor: DISTRIBUTOR, amountStroops: "10000000", purpose: "auto_refill" })
  assert.equal(hold.ok, true)
  const id = hold.ok ? hold.holdId : ""

  assert.equal(commitRefill(id, "hash-1"), true)
  assert.equal(commitRefill(id, "hash-2"), false, "a committed hold cannot commit twice")
  assert.equal(releaseRefill(id), false, "a committed hold cannot be released")
}

function testStaleBalanceIsCounted() {
  seed(100_000_000n)
  resetSecurityCounters()
  // A balance last written 5 minutes ago is stale for settlement decisions.
  distributorLedgerStats(DISTRIBUTOR, Date.now() + 300_000)
  assert.ok(getSecurityCounter("distributor_available_balance_stale") > 0)
}

function testSetLedgerBalanceBumpsVersion() {
  seed(100_000_000n)
  const before = readLedger(DISTRIBUTOR)!
  setLedgerBalance(DISTRIBUTOR, "200000000")
  const after = readLedger(DISTRIBUTOR)!
  assert.equal(after.balance_stroops, 200000000)
  assert.ok(after.version > before.version, "an observed balance must bump version")
}

async function main() {
  testAvailableSubtractsReserveAndPending(); console.log("✓ available = balance - reserve - feeReserve - pending")
  testReserveIsRefusedWhenInsufficient(); console.log("✓ refuses an unaffordable refill")
  testUnknownDistributorIsRefused(); console.log("✓ refuses an unknown distributor")
  testTwoConcurrentReservationsCannotBothSpend(); console.log("✓ two concurrent refills cannot both spend (no double-spend)")
  testConcurrentReservationsRespectPending(); console.log("✓ concurrent reservations respect pending holds")
  testReleaseFreesTheHold(); console.log("✓ a released hold frees the funds")
  testCommitIsIdempotent(); console.log("✓ commit is idempotent, cannot follow release")
  testStaleBalanceIsCounted(); console.log("✓ a stale balance is counted")
  testSetLedgerBalanceBumpsVersion(); console.log("✓ observed balance bumps version")
  rmSync(scratch, { recursive: true, force: true })
  console.log("\nAll distributor-ledger tests passed.")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
