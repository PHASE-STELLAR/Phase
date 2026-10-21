import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isLegalHold169Enabled,
  createLegalHold,
  releaseLegalHold,
  getActiveHoldsForTarget,
  assertNoLegalHold,
  LegalHoldError,
} from "@/lib/legal-hold";

describe("phase-169 legal-hold preservation", () => {
  const originalEnv = process.env.FEATURE_PHASE_169;

  beforeEach(() => {
    process.env.FEATURE_PHASE_169 = "1";
  });

  afterEach(() => {
    process.env.FEATURE_PHASE_169 = originalEnv;
  });

  it("checks feature flag status", () => {
    expect(isLegalHold169Enabled()).toBe(true);
    process.env.FEATURE_PHASE_169 = "0";
    expect(isLegalHold169Enabled()).toBe(false);
  });

  it("creates a legal hold and confirms active status", async () => {
    const hold = await createLegalHold({
      target_type: "signal",
      target_id: "sig_hold_test_1",
      matter_id: "SEC-2026-004",
      reason: "Preservation order pending investigation",
      custodian: "compliance@phase.app",
    });

    expect(hold.id).toBeDefined();
    expect(hold.active).toBe(true);
    expect(hold.target_id).toBe("sig_hold_test_1");

    const activeHolds = await getActiveHoldsForTarget("signal", "sig_hold_test_1");
    expect(activeHolds.length).toBeGreaterThan(0);
    expect(activeHolds.some((h) => h.id === hold.id)).toBe(true);
  });

  it("denies destructive action on held target", async () => {
    await expect(
      assertNoLegalHold("signal", "sig_hold_test_1", "takedown"),
    ).rejects.toThrow(LegalHoldError);
  });

  it("releases legal hold when permitted and unblocks assertion", async () => {
    const hold = await createLegalHold({
      target_type: "collection",
      target_id: "col_release_test",
      matter_id: "CASE-99",
      reason: "Temporary inquiry",
      custodian: "legal@phase.app",
    });

    await expect(
      assertNoLegalHold("collection", "col_release_test", "delete"),
    ).rejects.toThrow(LegalHoldError);

    const released = await releaseLegalHold({
      id: hold.id,
      released_by: "legal_counsel",
      release_reason: "Inquiry resolved without finding",
    });

    expect(released.active).toBe(false);
    expect(released.released_at).toBeGreaterThan(0);

    // After release, assertion passes
    await expect(
      assertNoLegalHold("collection", "col_release_test", "delete"),
    ).resolves.not.toThrow();
  });

  it("enforces WORM retention lock against premature release", async () => {
    const hold = await createLegalHold({
      target_type: "profile",
      target_id: "GUSER_WORM_TEST",
      matter_id: "COURT-ORDER-1",
      reason: "Statutory mandatory retention",
      custodian: "compliance@phase.app",
      retention_days: 30,
      immutable_worm: true,
    });

    await expect(
      releaseLegalHold({
        id: hold.id,
        released_by: "compliance_officer",
        release_reason: "Attempted early lift",
      }),
    ).rejects.toThrow(LegalHoldError);
  });
});
