import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CURRENT_TOS_VERSION,
  CURRENT_PRIVACY_VERSION,
  CANONICAL_TOS_HASH,
  CANONICAL_PRIVACY_HASH,
  getCanonicalDocuments,
  getWalletConsent,
  hasAcceptedCurrentLegal,
  recordConsent,
  assertWalletConsent,
  LegalConsentError,
  isConsent166Enabled,
} from "@/lib/legal-consent";

const TEST_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7N5Z4DK22JWYC7SVQUC65BKU";

describe("phase-166 legal consent and document versioning", () => {
  const originalEnv = process.env.FEATURE_PHASE_166;

  beforeEach(() => {
    process.env.FEATURE_PHASE_166 = "1";
  });

  afterEach(() => {
    process.env.FEATURE_PHASE_166 = originalEnv;
  });

  it("exposes active feature flag", () => {
    expect(isConsent166Enabled()).toBe(true);
    process.env.FEATURE_PHASE_166 = "0";
    expect(isConsent166Enabled()).toBe(false);
  });

  it("loads canonical legal documents with sha256 checksums", () => {
    const docs = getCanonicalDocuments();
    expect(docs.tos.version).toBe(CURRENT_TOS_VERSION);
    expect(docs.tos.content_sha256).toBe(CANONICAL_TOS_HASH);
    expect(docs.tos.content.length).toBeGreaterThan(100);

    expect(docs.privacy.version).toBe(CURRENT_PRIVACY_VERSION);
    expect(docs.privacy.content_sha256).toBe(CANONICAL_PRIVACY_HASH);
    expect(docs.privacy.content.length).toBeGreaterThan(100);
  });

  it("reports pending status when wallet has not accepted", async () => {
    const status = await hasAcceptedCurrentLegal("GNOTACCEPTED00000000000000000000000000000000000000000000");
    expect(status.accepted).toBe(false);
    expect(status.pending_documents).toContain("tos");
    expect(status.pending_documents).toContain("privacy");
  });

  it("records valid consent and transitions to accepted status", async () => {
    const record = await recordConsent({
      wallet: TEST_WALLET,
      tos_version: CURRENT_TOS_VERSION,
      tos_hash: CANONICAL_TOS_HASH,
      privacy_version: CURRENT_PRIVACY_VERSION,
      privacy_hash: CANONICAL_PRIVACY_HASH,
      user_agent: "Vitest Agent 1.0",
    });

    expect(record.wallet).toBe(TEST_WALLET);
    expect(record.tos_version).toBe(CURRENT_TOS_VERSION);
    expect(record.tos_hash).toBe(CANONICAL_TOS_HASH);

    const stored = await getWalletConsent(TEST_WALLET);
    expect(stored).not.toBeNull();
    expect(stored?.tos_version).toBe(CURRENT_TOS_VERSION);

    const status = await hasAcceptedCurrentLegal(TEST_WALLET);
    expect(status.accepted).toBe(true);
    expect(status.pending_documents).toHaveLength(0);
  });

  it("rejects outdated or mismatched document version", async () => {
    await expect(
      recordConsent({
        wallet: TEST_WALLET,
        tos_version: "2024-01-01",
        tos_hash: CANONICAL_TOS_HASH,
        privacy_version: CURRENT_PRIVACY_VERSION,
        privacy_hash: CANONICAL_PRIVACY_HASH,
      }),
    ).rejects.toThrow(LegalConsentError);
  });

  it("rejects tampered or mismatched document content hash", async () => {
    await expect(
      recordConsent({
        wallet: TEST_WALLET,
        tos_version: CURRENT_TOS_VERSION,
        tos_hash: "0000000000000000000000000000000000000000000000000000000000000000",
        privacy_version: CURRENT_PRIVACY_VERSION,
        privacy_hash: CANONICAL_PRIVACY_HASH,
      }),
    ).rejects.toThrow(LegalConsentError);
  });

  it("assertWalletConsent passes for consented wallet and throws for unconsented", async () => {
    await expect(assertWalletConsent(TEST_WALLET)).resolves.not.toThrow();

    const unconsentedWallet = "GNEWWALLET000000000000000000000000000000000000000000000000";
    await expect(assertWalletConsent(unconsentedWallet)).rejects.toThrow(
      LegalConsentError,
    );
  });

  it("bypasses assertion when feature flag is off", async () => {
    process.env.FEATURE_PHASE_166 = "0";
    const unconsentedWallet = "GNEWWALLET000000000000000000000000000000000000000000000000";
    await expect(assertWalletConsent(unconsentedWallet)).resolves.not.toThrow();
  });
});
