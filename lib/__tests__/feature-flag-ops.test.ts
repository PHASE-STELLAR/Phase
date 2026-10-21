/**
 * Spike 607 (#471, phase-174) — Feature-flag ops: staged rollout, per-wallet
 * targeting, CAS versioning, stale-on-error cache, and kill-switch drills.
 *
 * NOTE: Written as part of the spike implementation (not executed).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_FEATURE_FLAGS,
  FeatureFlagOpsError,
  activateFlagKillSwitch,
  auditFeatureFlagOpsWiring,
  evaluateFeatureFlag,
  flagRolloutBucket,
  getEnabledFeatureFlags,
  isFeatureEnabled,
  liftFlagKillSwitch,
  refreshFeatureFlagOpsCache,
   resetFeatureFlagOpsForTests,
  resolvePendingClaimAfterFlagFlip,
  runKillSwitchDrill,
  setFeatureFlagRule,
} from "@/lib/feature-flags";
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBFQN2";

describe("feature-flag ops (Spike 607 / phase-174)", () => {
  const saved174 = process.env.FEATURE_PHASE_174;
  const saved133 = process.env.NEXT_PUBLIC_FEATURE_PHASE_133;
  const savedKillEnv = process.env.PHASE_KILL_SWITCH_FLAGS;

  beforeEach(() => {
    resetFeatureFlagOpsForTests();
    resetSecurityCounters();
    process.env.FEATURE_PHASE_174 = "1";
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_133;
    delete process.env.PHASE_KILL_SWITCH_FLAGS;
  });

  afterEach(() => {
    resetFeatureFlagOpsForTests();
    if (saved174 === undefined) delete process.env.FEATURE_PHASE_174;
    else process.env.FEATURE_PHASE_174 = saved174;
    if (saved133 === undefined) delete process.env.NEXT_PUBLIC_FEATURE_PHASE_133;
    else process.env.NEXT_PUBLIC_FEATURE_PHASE_133 = saved133;
    if (savedKillEnv === undefined) delete process.env.PHASE_KILL_SWITCH_FLAGS;
    else process.env.PHASE_KILL_SWITCH_FLAGS = savedKillEnv;
  });

  it("deduplicates ALL_FEATURE_FLAGS and includes phase-134, phase-135, and phase-170..174", () => {
    const set = new Set(ALL_FEATURE_FLAGS);
    expect(set.size).toBe(ALL_FEATURE_FLAGS.length);
    expect(set.has("phase-128")).toBe(true);
    expect(set.has("phase-134")).toBe(true);
    expect(set.has("phase-135")).toBe(true);
    expect(set.has("phase-173")).toBe(true);
    expect(set.has("phase-174")).toBe(true);
    expect(getEnabledFeatureFlags()).toContain("phase-174");
    expect(auditFeatureFlagOpsWiring().ok).toBe(true);
  });

  it("enforces kill-switch over build-time NEXT_PUBLIC_FEATURE_* exposure", () => {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_133 = "1";
    expect(isFeatureEnabled("phase-133")).toBe(true);

    activateFlagKillSwitch("phase-133", {
      updatedBy: "sec-ops",
      reason: "halt distributor refill",
    });

    const evaluation = evaluateFeatureFlag("phase-133", { runtimeOnly: true });
    expect(evaluation.enabled).toBe(false);
    expect(evaluation.reason).toBe("kill_switch");
    expect(evaluation.clientBundled).toBe(true);
    expect(getSecurityCounter("flag_kill_switch_activated")).toBe(1);

    liftFlagKillSwitch("phase-133", { updatedBy: "sec-ops", reason: "incident resolved" });
    expect(isFeatureEnabled("phase-133")).toBe(true);
    expect(getSecurityCounter("flag_kill_switch_lifted")).toBe(1);
  });

  it("evaluates per-wallet denyWallets before allowWallets and rolloutBps", () => {
    setFeatureFlagRule({
      flag: "phase-131",
      allowWallets: [WALLET_A, WALLET_B],
      denyWallets: [WALLET_B],
      rolloutBps: 10_000,
    });

    expect(evaluateFeatureFlag("phase-131", { wallet: WALLET_A }).reason).toBe("wallet_allowed");
    expect(isFeatureEnabled("phase-131", { wallet: WALLET_A })).toBe(true);

    expect(evaluateFeatureFlag("phase-131", { wallet: WALLET_B }).reason).toBe("wallet_denied");
    expect(isFeatureEnabled("phase-131", { wallet: WALLET_B })).toBe(false);
  });

  it("provides deterministic, monotonic FNV-1a bucketing across basis-point ramps", () => {
    const bucket = flagRolloutBucket("phase-131", WALLET_A);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(10_000);
    expect(flagRolloutBucket("phase-131", WALLET_A)).toBe(bucket);

    setFeatureFlagRule({ flag: "phase-131", rolloutBps: bucket });
    expect(isFeatureEnabled("phase-131", { wallet: WALLET_A })).toBe(false);

    setFeatureFlagRule({ flag: "phase-131", rolloutBps: bucket + 1 });
    expect(isFeatureEnabled("phase-131", { wallet: WALLET_A })).toBe(true);
  });

  it("rejects concurrent updates with a stale expectedVersion (409 CAS)", () => {
    const r1 = setFeatureFlagRule({ flag: "phase-130", rolloutBps: 1000 });
    expect(r1.version).toBe(1);

    expect(() =>
      setFeatureFlagRule({
        flag: "phase-130",
        rolloutBps: 5000,
        expectedVersion: 0,
      }),
    ).toThrowError(FeatureFlagOpsError);
    expect(getSecurityCounter("flag_ops_version_conflict")).toBe(1);
  });

  it("degrades to stale cached rules when store refresh fails", async () => {
    activateFlagKillSwitch("phase-133", { reason: "keep killed" });
    const res = await refreshFeatureFlagOpsCache(async () => {
      throw new Error("disk read failed");
    });
    expect(res.ok).toBe(false);
    expect(res.cacheState).toBe("stale");
    expect(evaluateFeatureFlag("phase-133").enabled).toBe(false);
    expect(evaluateFeatureFlag("phase-133").cacheState).toBe("stale");
    expect(getSecurityCounter("flag_ops_stale_fallback")).toBeGreaterThanOrEqual(1);
  });

  it("preserves faucetPending hash and amountStroops across a mid-poll flag flip and passes drill", async () => {
    const resolved = resolvePendingClaimAfterFlagFlip({
      pending: {
        hash: "f".repeat(64),
        reward: "daily",
        at: Date.now(),
        amountStroops: "40000000",
      },
      fallbackAmountStroops: "20000000",
    });
    expect(resolved.amountStroops).toBe("40000000");
    expect(resolved.idempotentReuse).toBe(true);

    const drill = await runKillSwitchDrill();
    expect(drill.passed).toBe(true);
    expect(drill.steps.killOverridesBuildEnv).toBe(true);
    expect(drill.steps.monotonicRolloutRamp).toBe(true);
    expect(drill.steps.faucetPendingMidPollIdempotent).toBe(true);
    expect(drill.steps.staleCachePreservesKillSwitch).toBe(true);
  });
});
