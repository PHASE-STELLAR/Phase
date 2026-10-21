/**
 * Gauge voting for emission budget allocation (Spike 691 / phase-145) — tests
 * Run: npx tsx tests/gauge-voting.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(tmpdir(), "phase-gauge-test-"));
process.env.PHASE_SERVER_DATA_DIR = scratch;

import { resetDbForTests } from "@/lib/sqlite-db";
import { createOrUpdateVeLock } from "@/lib/ve-phaselq";
import {
  castGaugeVote,
  readWalletGaugeVotes,
  readEpochAggregates,
  distributeEpochEmissions,
  getCollectionQuestBudget,
  getGaugeEpochId,
} from "@/lib/gauge-voting";
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters";

const ALICE = "GALICE6GCKMY3US5PAB6UZLKIGAHWKXX2GAKJWOF2M6JBQ2DGBA58";
const BOB = "GBOBHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX";

function testVoteWithoutVeWeightIsRejected() {
  resetDbForTests();
  const res = castGaugeVote(ALICE, [{ collectionId: 1, weightPct: 50 }]);
  assert.equal(res.ok, false);
  assert.ok(res.error?.includes("ve-PHASELQ lock required"));
}

function testVoteExceeding100PercentIsRejected() {
  resetDbForTests();
  const now = 1_700_000_000_000;
  createOrUpdateVeLock(ALICE, 100_000_000n, 104, now); // 5.0 veWeight

  const res = castGaugeVote(
    ALICE,
    [
      { collectionId: 1, weightPct: 70 },
      { collectionId: 2, weightPct: 40 },
    ],
    now,
  );
  assert.equal(res.ok, false);
  assert.ok(res.error?.includes("must be between 1 and 100%"));
}

function testVotingAndEmissionDistribution() {
  resetDbForTests();
  resetSecurityCounters();
  const now = 1_700_000_000_000;
  const epoch = getGaugeEpochId(now);

  // Alice has 10.0 veWeight (locks 10 PHASELQ for 208 weeks)
  createOrUpdateVeLock(ALICE, 100_000_000n, 208, now);
  // Bob has 5.0 veWeight (locks 10 PHASELQ for 104 weeks)
  createOrUpdateVeLock(BOB, 100_000_000n, 104, now);

  // Alice votes: 60% to Collection 1, 40% to Collection 2
  const vAlice = castGaugeVote(
    ALICE,
    [
      { collectionId: 1, weightPct: 60 },
      { collectionId: 2, weightPct: 40 },
    ],
    now,
  );
  assert.equal(vAlice.ok, true);
  // Alice gives 6.0 veWeight to Col 1, 4.0 veWeight to Col 2

  // Bob votes: 100% to Collection 2
  const vBob = castGaugeVote(
    BOB,
    [{ collectionId: 2, weightPct: 100 }],
    now,
  );
  assert.equal(vBob.ok, true);
  // Bob gives 5.0 veWeight to Col 2

  assert.ok(getSecurityCounter("gauge_vote_cast") > 0);

  // Check aggregates:
  // Col 1: 6.0 veWeight
  // Col 2: 4.0 + 5.0 = 9.0 veWeight
  // Total: 15.0 veWeight
  const aggs = readEpochAggregates(epoch);
  assert.equal(aggs.length, 2);

  const col1Agg = aggs.find((a) => a.collectionId === 1);
  const col2Agg = aggs.find((a) => a.collectionId === 2);
  assert.equal(col1Agg?.totalVeWeight, 6.0);
  assert.equal(col2Agg?.totalVeWeight, 9.0);

  // Distribute 150_000_000 stroops (15 PHASELQ) weekly quest budget
  const distributed = distributeEpochEmissions(epoch, 150_000_000n);
  assert.equal(distributed.length, 2);

  // Col 1 gets (6.0 / 15.0) * 150M = 60M stroops
  const b1 = getCollectionQuestBudget(1, epoch);
  assert.equal(b1.totalBudgetStroops, 60_000_000n);

  // Col 2 gets (9.0 / 15.0) * 150M = 90M stroops
  const b2 = getCollectionQuestBudget(2, epoch);
  assert.equal(b2.totalBudgetStroops, 90_000_000n);

  assert.ok(getSecurityCounter("gauge_epoch_distributed") > 0);
}

function testVoteReplacementInSameEpoch() {
  resetDbForTests();
  const now = 1_700_000_000_000;
  const epoch = getGaugeEpochId(now);
  createOrUpdateVeLock(ALICE, 100_000_000n, 208, now); // 10.0 veWeight

  // Vote initially
  castGaugeVote(ALICE, [{ collectionId: 1, weightPct: 100 }], now);
  assert.equal(readWalletGaugeVotes(ALICE, epoch).length, 1);

  // Change vote
  castGaugeVote(ALICE, [{ collectionId: 2, weightPct: 100 }], now);
  const updated = readWalletGaugeVotes(ALICE, epoch);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].collectionId, 2);
}

async function main() {
  testVoteWithoutVeWeightIsRejected();
  console.log("✓ castGaugeVote rejects votes without active ve-weight");
  testVoteExceeding100PercentIsRejected();
  console.log("✓ castGaugeVote validates vote percentage totals <= 100%");
  testVotingAndEmissionDistribution();
  console.log("✓ castGaugeVote and distributeEpochEmissions apportion budget pro-rata");
  testVoteReplacementInSameEpoch();
  console.log("✓ casting new votes in the same epoch atomically replaces previous ballot");

  resetDbForTests();
  rmSync(scratch, { recursive: true, force: true });
  console.log("\nAll gauge-voting tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
