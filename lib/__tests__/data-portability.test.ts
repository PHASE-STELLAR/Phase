import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isPortability167Enabled,
  exportUserDataBundle,
  verifyPortabilityBundle,
  DataPortabilityError,
  PORTABILITY_SCHEMA_VERSION,
} from "@/lib/data-portability";

const TEST_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7N5Z4DK22JWYC7SVQUC65BKU";

describe("phase-167 data portability export", () => {
  const originalEnv = process.env.FEATURE_PHASE_167;

  beforeEach(() => {
    process.env.FEATURE_PHASE_167 = "1";
  });

  afterEach(() => {
    process.env.FEATURE_PHASE_167 = originalEnv;
  });

  it("checks feature flag status", () => {
    expect(isPortability167Enabled()).toBe(true);
    process.env.FEATURE_PHASE_167 = "0";
    expect(isPortability167Enabled()).toBe(false);
  });

  it("throws FLAG_DISABLED when feature flag is off", async () => {
    process.env.FEATURE_PHASE_167 = "0";
    await expect(exportUserDataBundle(TEST_WALLET)).rejects.toThrow(
      DataPortabilityError,
    );
  });

  it("throws WALLET_REQUIRED when wallet is missing or invalid", async () => {
    await expect(exportUserDataBundle("")).rejects.toThrow(DataPortabilityError);
    await expect(exportUserDataBundle("short")).rejects.toThrow(
      DataPortabilityError,
    );
  });

  it("assembles complete GDPR Article 20 bundle with valid manifest", async () => {
    const bundle = await exportUserDataBundle(TEST_WALLET);

    expect(bundle).toBeDefined();
    expect(bundle.manifest).toBeDefined();
    expect(bundle.manifest.format).toBe("phase-gdpr-article-20-bundle");
    expect(bundle.manifest.schema_version).toBe(PORTABILITY_SCHEMA_VERSION);
    expect(bundle.manifest.wallet).toBe(TEST_WALLET);
    expect(bundle.manifest.exported_at).toBeGreaterThan(0);

    expect(bundle.manifest.domains).toEqual([
      "profile",
      "follows",
      "notifications",
      "market",
      "signals",
      "badges",
      "consents",
    ]);

    expect(bundle.data).toBeDefined();
    expect(bundle.data.follows).toBeDefined();
    expect(bundle.data.notifications).toBeDefined();
    expect(bundle.data.market).toBeDefined();
    expect(bundle.data.signals).toBeDefined();

    const verification = verifyPortabilityBundle(bundle);
    expect(verification.valid).toBe(true);
    expect(verification.errors).toHaveLength(0);
  });
});
