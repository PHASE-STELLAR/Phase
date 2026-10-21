import { describe, it, expect } from "vitest";
import { redactEventForRole } from "@/lib/moderation-audit-export";
import { fingerprintWallet, redactSecretKeys, sanitizeModerationReason } from "@/lib/redaction";
import type { ModerationAuditEvent } from "@/lib/moderation-audit";

const TEST_MODERATOR_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7N5Z4DK22JWYC7SVQUC65BKU";
const SECRET_KEY = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("moderation audit redaction engine", () => {
  const baseEvent: ModerationAuditEvent = {
    id: "evt_12345",
    signal_id: "sig_abc",
    action: "takedown",
    moderator_wallet: TEST_MODERATOR_WALLET,
    moderator_signature: "raw_cryptographic_signature_512bits",
    reason: `Violation reported by ${TEST_MODERATOR_WALLET} with leaked token ${SECRET_KEY}`,
    created_at: 1729250000000,
    ai: {
      queue_id: "q_99",
      decision: "auto_hold",
      confidence: 0.95,
      model_id: "mod-v1",
      prompt_hash: "hash_secret",
      scores: { toxicity: 0.99 },
      agreed: true,
    },
  };

  it("keeps raw wallets and signatures for moderator role", () => {
    const redacted = redactEventForRole(baseEvent, "moderator");
    expect(redacted.moderator).toBe(TEST_MODERATOR_WALLET);
    expect(redacted.signature).toBe("raw_cryptographic_signature_512bits");
    expect(redacted.reason).toBe(baseEvent.reason);
  });

  it("pseudonymizes wallets and strips signatures for regulator role", () => {
    const redacted = redactEventForRole(baseEvent, "regulator");
    expect(redacted.moderator).not.toBe(TEST_MODERATOR_WALLET);
    expect(redacted.moderator).toContain("GBZX...5BKU");
    expect(redacted.moderator).toContain("(fp:");
    expect(redacted.signature).toBeUndefined();

    // Reason is sanitized of secret keys and wallets
    expect(redacted.reason).not.toContain(SECRET_KEY);
    expect(redacted.reason).toContain("[REDACTED_SECRET_KEY]");
    expect(redacted.reason).not.toContain(TEST_MODERATOR_WALLET);
  });

  it("fingerprintWallet produces deterministic, masked representation", () => {
    const fp1 = fingerprintWallet(TEST_MODERATOR_WALLET);
    const fp2 = fingerprintWallet(TEST_MODERATOR_WALLET);
    expect(fp1).toBe(fp2);
    expect(fp1.startsWith("GBZX...")).toBe(true);
    expect(fp1.endsWith("5BKU)")).toBe(false); // suffix followed by (fp: ...)
    expect(fp1).toContain("(fp: ");
  });

  it("redactSecretKeys scrubs private seeds", () => {
    const input = `Config: ${SECRET_KEY} active`;
    const cleaned = redactSecretKeys(input);
    expect(cleaned).toBe("Config: [REDACTED_SECRET_KEY] active");
  });
});
