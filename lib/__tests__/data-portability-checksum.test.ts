import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  exportUserDataBundle,
  verifyPortabilityBundle,
  computeSha256,
} from "@/lib/data-portability";

const TEST_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7N5Z4DK22JWYC7SVQUC65BKU";

describe("data portability checksum and integrity verification", () => {
  beforeEach(() => {
    process.env.FEATURE_PHASE_167 = "1";
  });

  afterEach(() => {
    delete process.env.FEATURE_PHASE_167;
  });

  it("validates intact bundle successfully", async () => {
    const bundle = await exportUserDataBundle(TEST_WALLET);
    const result = verifyPortabilityBundle(bundle);
    expect(result.valid).toBe(true);
  });

  it("detects tampered domain data", async () => {
    const bundle = await exportUserDataBundle(TEST_WALLET);
    // Tamper with follows data
    bundle.data.follows.following.push("GHACKEDWALLET0000000000000000000000000000000000000000000000");

    const result = verifyPortabilityBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("follows"))).toBe(true);
  });

  it("detects tampered manifest checksums", async () => {
    const bundle = await exportUserDataBundle(TEST_WALLET);
    // Tamper with checksum directly
    bundle.manifest.checksums.profile = "0000000000000000000000000000000000000000000000000000000000000000";

    const result = verifyPortabilityBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("profile"))).toBe(true);
  });

  it("computes deterministic sha256 checksums", () => {
    const data = { hello: "world", count: 42 };
    const hash1 = computeSha256(data);
    const hash2 = computeSha256(data);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});
