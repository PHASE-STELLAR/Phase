import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createLegalHold,
  assertNoLegalHold,
  isUnderLegalHold,
  LegalHoldError,
} from "@/lib/legal-hold";

const HELD_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7N5Z4DK22JWYC7SVQUC65BKU";
const FREE_WALLET = "GCOZ2Q7JUGZ3R6XGND6PMR7W7U6IOGV3CVD4BWW7UCRUS2C2366XJ264";

describe("legal-hold cascade preservation", () => {
  beforeEach(() => {
    process.env.FEATURE_PHASE_169 = "1";
  });

  afterEach(() => {
    delete process.env.FEATURE_PHASE_169;
  });

  it("cascades wallet-level hold to assets owned by that wallet", async () => {
    await createLegalHold({
      target_type: "wallet",
      target_id: HELD_WALLET,
      matter_id: "WARRANT-2026-X",
      reason: "Full preservation of subject wallet",
      custodian: "investigator@phase.app",
    });

    // Check direct wallet
    const walletCheck = await isUnderLegalHold("wallet", HELD_WALLET);
    expect(walletCheck.held).toBe(true);

    // Check asset owned by held wallet
    const signalCheck = await isUnderLegalHold("signal", "sig_owned_by_held", HELD_WALLET);
    expect(signalCheck.held).toBe(true);
    expect(signalCheck.reason).toContain("Owning wallet");

    // Assertion denies deletion of that asset
    await expect(
      assertNoLegalHold("signal", "sig_owned_by_held", "takedown", HELD_WALLET),
    ).rejects.toThrow(LegalHoldError);
  });

  it("allows actions on assets owned by unheld wallets", async () => {
    const unheldCheck = await isUnderLegalHold("signal", "sig_free", FREE_WALLET);
    expect(unheldCheck.held).toBe(false);

    await expect(
      assertNoLegalHold("signal", "sig_free", "takedown", FREE_WALLET),
    ).resolves.not.toThrow();
  });
});
