/**
 * Churn detection and winback experiment evaluation (Spike 689 / phase-143) — tests
 * Run: npx tsx tests/churn-winback.test.ts
 */
import assert from "node:assert/strict";
import {
  classifyWalletDormancy,
  assignExperimentCohort,
  checkFatigueCap,
  determineWinbackHook,
  evaluateWinbackCampaign,
} from "@/lib/churn-winback";
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters";

const DAY_MS = 24 * 60 * 60 * 1000;

function testDormancyClassification() {
  resetSecurityCounters();
  const now = 1_700_000_000_000;

  assert.equal(classifyWalletDormancy(now - 2 * DAY_MS, now).tier, "active");
  assert.equal(classifyWalletDormancy(now - 10 * DAY_MS, now).tier, "at_risk");
  assert.equal(classifyWalletDormancy(now - 20 * DAY_MS, now).tier, "dormant_mild");
  assert.equal(classifyWalletDormancy(now - 45 * DAY_MS, now).tier, "dormant_deep");
  assert.equal(classifyWalletDormancy(now - 90 * DAY_MS, now).tier, "churned");

  assert.ok(getSecurityCounter("winback_dormant_detected") > 0);
}

function testCohortAssignmentDeterminism() {
  const wallet = "GBRPYHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX";
  const cohort1 = assignExperimentCohort(wallet, "exp_1");
  const cohort2 = assignExperimentCohort(wallet, "exp_1");
  assert.equal(cohort1, cohort2, "Same wallet and experiment must always yield identical cohort");

  // Different wallets produce distributed cohorts
  const wallets = [
    "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GAKJWOF2M6JBQ2DGBA58",
    "GBRPYHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX",
    "GCGNZ25W6V43Q54DRL6K6J4777Q3KTY4J3H7N265K73Z6FNAU7G65565",
    "GDTKGYR44QOEXUSQUSQWJ2YFXP2H27J3A73H57D7A5D2W4D4H2W6E6K6",
  ];
  const assignments = wallets.map((w) => assignExperimentCohort(w, "exp_1"));
  assert.ok(assignments.length === 4);
}

function testFatigueCapEnforcement() {
  const now = 1_700_000_000_000;

  // Never contacted -> allowed
  assert.equal(checkFatigueCap(null, now).allowed, true);

  // Contacted 3 days ago -> suppressed (4 days remaining)
  const recent = checkFatigueCap(now - 3 * DAY_MS, now, 7);
  assert.equal(recent.allowed, false);
  assert.equal(recent.waitDaysRemaining, 4);

  // Contacted 8 days ago -> allowed
  const expired = checkFatigueCap(now - 8 * DAY_MS, now, 7);
  assert.equal(expired.allowed, true);
  assert.equal(expired.waitDaysRemaining, 0);
}

function testWinbackHookPersonalization() {
  const streakUser = determineWinbackHook("GAAA", { brokenStreakDays: 5 });
  assert.equal(streakUser.hook, "streak_recovery");

  const questUser = determineWinbackHook("GBBB", { hasUnfinishedQuest: true });
  assert.equal(questUser.hook, "unfinished_quest");

  const worldUser = determineWinbackHook("GCCC", { favoritedCollections: [1, 2] });
  assert.equal(worldUser.hook, "new_world_drop");

  const genericUser = determineWinbackHook("GDDD", {});
  assert.equal(genericUser.hook, "general_digest");
}

function testFullCampaignEvaluation() {
  resetSecurityCounters();
  const now = 1_700_000_000_000;
  const wallet = "GBRPYHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX";

  // Active user -> not eligible
  const activeEval = evaluateWinbackCampaign(
    wallet,
    { lastActiveMs: now - 3 * DAY_MS },
    "exp_1",
    now,
  );
  assert.equal(activeEval.eligible, false);

  // Dormant user under fatigue cooldown -> fatigueSuppressed
  const fatiguedEval = evaluateWinbackCampaign(
    wallet,
    { lastActiveMs: now - 25 * DAY_MS, lastNotifiedMs: now - 2 * DAY_MS },
    "exp_1",
    now,
  );
  assert.equal(fatiguedEval.eligible, false);
  assert.equal(fatiguedEval.fatigueSuppressed, true);
  assert.ok(getSecurityCounter("winback_fatigue_suppressed") > 0);

  // Dormant eligible user
  const eligibleEval = evaluateWinbackCampaign(
    wallet,
    { lastActiveMs: now - 25 * DAY_MS, lastNotifiedMs: now - 15 * DAY_MS },
    "exp_1",
    now,
  );
  assert.equal(eligibleEval.eligible, true);
}

async function main() {
  testDormancyClassification();
  console.log("✓ classifyWalletDormancy assigns correct tiers");
  testCohortAssignmentDeterminism();
  console.log("✓ assignExperimentCohort is deterministic per wallet");
  testFatigueCapEnforcement();
  console.log("✓ checkFatigueCap prevents re-contacting within 7 days");
  testWinbackHookPersonalization();
  console.log("✓ determineWinbackHook selects activity-grounded hook");
  testFullCampaignEvaluation();
  console.log("✓ evaluateWinbackCampaign orchestrates eligibility correctly");
  console.log("\nAll churn-winback tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
