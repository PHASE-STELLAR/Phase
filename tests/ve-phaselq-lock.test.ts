/**
 * ve-PHASELQ governance locking and fee-share (Spike 690 / phase-144) — tests
 * Run: npx tsx tests/ve-phaselq-lock.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(tmpdir(), "phase-ve-lock-"));
process.env.PHASE_SERVER_DATA_DIR = scratch;

import { resetDbForTests } from "@/lib/sqlite-db";
import {
  calculateVeWeight,
  createOrUpdateVeLock,
  readVeLock,
  distributeTreasuryFees,
  calculateClaimableFees,
  claimFees,
  withdrawVeLock,
  WEEK_MS,
  MAX_LOCK_WEEKS,
} from "@/lib/ve-phaselq";
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters";

const WALLET = "GBRPYHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX";

function testWeightCalculation() {
  const onePhaselq = 10_000_000n; // 1 PHASELQ in stroops

  // 4 years (208 weeks) lock yields 100% of principal ve-weight (1.0)
  assert.equal(calculateVeWeight(onePhaselq, MAX_LOCK_WEEKS), 1.0);

  // 1 year (52 weeks) lock yields 25% of principal (0.25)
  assert.equal(calculateVeWeight(onePhaselq, 52), 0.25);

  // 2 years (104 weeks) lock yields 50% of principal (0.50)
  assert.equal(calculateVeWeight(onePhaselq, 104), 0.5);

  // 0 weeks yields 0
  assert.equal(calculateVeWeight(onePhaselq, 0), 0);
}

function testLockCreationAndDecay() {
  resetSecurityCounters();
  resetDbForTests();
  const now = 1_700_000_000_000;
  const amount = 100_000_000n; // 10 PHASELQ

  const res = createOrUpdateVeLock(WALLET, amount, 104, now); // 2 years = 50% weight = 5.0 ve-weight
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.lock.veWeight, 5.0);
  assert.ok(getSecurityCounter("ve_lock_created") > 0);

  // Read at lock creation time
  const readNow = readVeLock(WALLET, now);
  assert.ok(readNow);
  assert.equal(readNow?.veWeight, 5.0);

  // Read 1 year later (halfway through the 2-year lock): remaining duration is 1 year (52 weeks)
  const oneYearLater = now + 52 * WEEK_MS;
  const readLater = readVeLock(WALLET, oneYearLater);
  assert.ok(readLater);
  assert.equal(readLater?.veWeight, 2.5, "ve-weight must linearly decay over time");
}

function testFeeDistributionAndClaim() {
  resetDbForTests();
  resetSecurityCounters();
  const now = 1_700_000_000_000;

  // Alice locks 10 PHASELQ for 208 weeks -> veWeight = 10.0
  const alice = "GALICE6GCKMY3US5PAB6UZLKIGAHWKXX2GAKJWOF2M6JBQ2DGBA58";
  createOrUpdateVeLock(alice, 100_000_000n, 208, now);

  // Bob locks 10 PHASELQ for 52 weeks -> veWeight = 2.5
  const bob = "GBOBHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX";
  createOrUpdateVeLock(bob, 100_000_000n, 52, now);

  // Total ve-weight = 12.5. Protocol distributes 125_000_000 stroops (12.5 PHASELQ) in epoch 1
  const dist = distributeTreasuryFees(1, 125_000_000n, now);
  assert.equal(dist.totalVeWeight, 12.5);
  assert.equal(dist.feePerWeight, 10_000_000); // 10M stroops per 1.0 veWeight

  // Alice (10.0 veWeight) should be eligible for 10.0 * 10M = 100M stroops
  const aliceClaimable = calculateClaimableFees(alice, now);
  assert.equal(aliceClaimable.claimableStroops, 100_000_000n);

  // Bob (2.5 veWeight) should be eligible for 2.5 * 10M = 25M stroops
  const bobClaimable = calculateClaimableFees(bob, now);
  assert.equal(bobClaimable.claimableStroops, 25_000_000n);

  // Alice claims fees
  const aliceClaim = claimFees(alice, now);
  assert.equal(aliceClaim.ok, true);
  assert.equal(aliceClaim.ok && aliceClaim.claimedStroops, "100000000");

  // Alice claims again -> should be 0 (checkpoint advanced)
  const aliceClaimAgain = claimFees(alice, now);
  assert.equal(aliceClaimAgain.ok, false);
}

function testWithdrawalEnforcesExpiry() {
  resetDbForTests();
  const now = 1_700_000_000_000;
  createOrUpdateVeLock(WALLET, 50_000_000n, 10, now); // 10 weeks

  // Cannot withdraw before expiry
  const early = withdrawVeLock(WALLET, now + 5 * WEEK_MS);
  assert.equal(early.ok, false);

  // Can withdraw after expiry
  const late = withdrawVeLock(WALLET, now + 11 * WEEK_MS);
  assert.equal(late.ok, true);
  assert.equal(late.releasedStroops, "50000000");

  // Lock row deleted
  assert.equal(readVeLock(WALLET), null);
}

async function main() {
  testWeightCalculation();
  console.log("✓ calculateVeWeight produces linear duration-scaled weights");
  testLockCreationAndDecay();
  console.log("✓ createOrUpdateVeLock stores lock and decays with time");
  testFeeDistributionAndClaim();
  console.log("✓ distributeTreasuryFees splits pro-rata across lockers");
  testWithdrawalEnforcesExpiry();
  console.log("✓ withdrawVeLock blocks premature unlock, succeeds post-expiry");

  resetDbForTests();
  rmSync(scratch, { recursive: true, force: true });
  console.log("\nAll ve-phaselq-lock tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
