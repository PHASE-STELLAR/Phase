import { describe, it, expect } from "vitest";
import {
  fingerprintWallet,
  redactSecretKeys,
  sanitizeModerationReason,
  clamp,
} from "@/lib/redaction";

describe("redaction engine pure utilities", () => {
  it("fingerprintWallet handles invalid or short inputs gracefully", () => {
    expect(fingerprintWallet("")).toBe("[INVALID_WALLET]");
    expect(fingerprintWallet("short")).toBe("[INVALID_WALLET]");
  });

  it("redactSecretKeys handles multiple secret keys in a single string", () => {
    const s1 = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const s2 = "SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const str = `First: ${s1}, Second: ${s2}`;
    const cleaned = redactSecretKeys(str);
    expect(cleaned).toBe("First: [REDACTED_SECRET_KEY], Second: [REDACTED_SECRET_KEY]");
  });

  it("sanitizeModerationReason handles null and undefined", () => {
    expect(sanitizeModerationReason(null)).toBeNull();
    expect(sanitizeModerationReason(undefined)).toBeNull();
  });

  it("clamp enforces bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
