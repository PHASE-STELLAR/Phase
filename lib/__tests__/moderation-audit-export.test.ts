import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isAuditExport168Enabled,
  verifyAuditExportAuth,
  getAuditExport,
  ModerationAuditExportError,
} from "@/lib/moderation-audit-export";
import { appendModerationAuditEvent } from "@/lib/moderation-audit";

const TEST_MODERATOR_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7N5Z4DK22JWYC7SVQUC65BKU";

describe("phase-168 moderation audit export", () => {
  const originalEnv = process.env.FEATURE_PHASE_168;
  const originalAdminKey = process.env.PHASE_ADMIN_KEY;
  const originalRegToken = process.env.PHASE_REGULATOR_TOKEN;

  beforeEach(() => {
    process.env.FEATURE_PHASE_168 = "1";
    process.env.PHASE_ADMIN_KEY = "test-admin-key";
    process.env.PHASE_REGULATOR_TOKEN = "test-regulator-token";
  });

  afterEach(() => {
    process.env.FEATURE_PHASE_168 = originalEnv;
    process.env.PHASE_ADMIN_KEY = originalAdminKey;
    process.env.PHASE_REGULATOR_TOKEN = originalRegToken;
  });

  it("checks feature flag status", () => {
    expect(isAuditExport168Enabled()).toBe(true);
    process.env.FEATURE_PHASE_168 = "0";
    expect(isAuditExport168Enabled()).toBe(false);
  });

  it("authorizes moderator with admin key or moderator key", () => {
    const headersValid = new Headers({ "x-admin-key": "test-admin-key" });
    const authValid = verifyAuditExportAuth(headersValid, "moderator");
    expect(authValid.authorized).toBe(true);

    const headersInvalid = new Headers({ "x-admin-key": "wrong-key" });
    const authInvalid = verifyAuditExportAuth(headersInvalid, "moderator");
    expect(authInvalid.authorized).toBe(false);
  });

  it("authorizes regulator with regulator token", () => {
    const headersValid = new Headers({ "x-regulator-token": "test-regulator-token" });
    const authValid = verifyAuditExportAuth(headersValid, "regulator");
    expect(authValid.authorized).toBe(true);

    const headersInvalid = new Headers({ "x-regulator-token": "wrong-token" });
    const authInvalid = verifyAuditExportAuth(headersInvalid, "regulator");
    expect(authInvalid.authorized).toBe(false);
  });

  it("exports audit records filtered by action and date", async () => {
    await appendModerationAuditEvent({
      signal_id: "sig_exp_1",
      action: "takedown",
      moderator_wallet: TEST_MODERATOR_WALLET,
      moderator_signature: "sig_raw_bytes_123",
      reason: "Spam promotion",
    });

    const exportResult = await getAuditExport({
      role: "moderator",
      format: "json",
      action: "takedown",
      limit: 10,
    });

    expect(exportResult.events.length).toBeGreaterThan(0);
    const event = exportResult.events.find((e) => e.signal_id === "sig_exp_1");
    expect(event).toBeDefined();
    expect(event?.action).toBe("takedown");
    expect(event?.moderator).toBe(TEST_MODERATOR_WALLET);
    expect(event?.signature).toBe("sig_raw_bytes_123");
  });
});
