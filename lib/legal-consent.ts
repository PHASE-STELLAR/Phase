/**
 * Legal documents (Terms of Service & Privacy Policy) and consent flow with versioning.
 * Spike 632 / Issue #495.
 *
 * Provides hash-pinned document versioning, user acceptance tracking in termsConsents,
 * and gated write-path enforcement.
 *
 * Feature flag: phase-166.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_166 / FEATURE_PHASE_166; consent ledger remains inert.
 */

import { createHash } from "node:crypto";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { readStore, updateStore } from "@/lib/json-store";
import type {
  ConsentRecord,
  ConsentStatus,
  ConsentSubmitInput,
  LegalDocument,
  LegalDocumentType,
} from "@/lib/types/legal-consent";

export const CURRENT_TOS_VERSION = "2026-10-01";
export const CURRENT_PRIVACY_VERSION = "2026-10-01";

export const CANONICAL_TOS_TEXT_V1 = `
PHASE PROTOCOL TERMS OF SERVICE
Version: ${CURRENT_TOS_VERSION}
Effective Date: October 1, 2026

1. ACCEPTANCE OF TERMS
By accessing or using the PHASE Protocol, platform, smart contracts, and associated interfaces, you agree to be bound by these Terms of Service. If you do not agree to these terms, do not access or use the platform.

2. WALLET IDENTITY & CRYPTOGRAPHIC SIGNATURES
PHASE interacts directly with the Stellar network. You are solely responsible for safeguarding your private keys, seed phrases, and wallet credentials. All transactions, attestations, and content actions signed by your key are legally attributed to you.

3. ARTIST ATTESTATIONS & INTELLECTUAL PROPERTY
When publishing collections or lore on PHASE, creators attest that they hold all necessary intellectual property rights, licenses, or fair use exemptions. Unauthorized reproduction or infringement of copyrighted material is strictly prohibited.

4. CONTENT MODERATION & PROTOCOL RULES
The protocol community and designated moderators enforce standards to prevent harassment, abuse, fraudulent trading, and illegal content. PHASE reserves the right to gate, take down, or subject to legal hold any content that violates these policies.

5. AS-IS PROTOCOL USAGE & DISCLAIMERS
PHASE IS PROVIDED ON AN "AS-IS" AND "AS-AVAILABLE" BASIS. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE CONTRIBUTORS DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.

6. GOVERNING LAW & DISPUTE RESOLUTION
These Terms are governed by and construed in accordance with applicable laws governing decentralized distributed ledger technologies, without regard to conflict of law principles.
`.trim();

export const CANONICAL_PRIVACY_TEXT_V1 = `
PHASE PROTOCOL PRIVACY POLICY
Version: ${CURRENT_PRIVACY_VERSION}
Effective Date: October 1, 2026

1. OVERVIEW & DECENTRALIZED DATA ARCHITECTURE
PHASE values user privacy. Unlike traditional platforms, PHASE minimizes collection of personally identifiable information (PII). Most protocol activities occur directly on public blockchains and decentralized storage (IPFS/Soroban).

2. DATA WE PROCESS
- Public blockchain addresses (Stellar/Soroban public keys).
- User-provided profile metadata (display name, social handles, avatar CIDs, locale preferences).
- Interactive lore, signals, and reactions created through the interface.
- Technical telemetry and audit logs required for platform security, fraud prevention, and regulatory compliance.

3. GDPR ARTICLE 20 & DATA PORTABILITY RIGHTS
Users possess the right to export all personal data associated with their public wallet address in a machine-readable format with cryptographic checksums, as well as the right to rectify profile information.

4. DATA RETENTION & LEGAL PRESERVATION
We retain operational records only as long as necessary for protocol operations. In the event of an active investigation or regulatory inquiry, relevant data may be placed under a formal legal hold, overriding standard deletion schedules.

5. THIRD-PARTY DISCLOSURES
PHASE does not sell personal data. Blockchain records and public IPFS content are permanently accessible to network participants by design.
`.trim();

export function computeSha256(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}

export const CANONICAL_TOS_HASH = computeSha256(CANONICAL_TOS_TEXT_V1);
export const CANONICAL_PRIVACY_HASH = computeSha256(CANONICAL_PRIVACY_TEXT_V1);

export class LegalConsentError extends Error {
  code:
    | "FLAG_DISABLED"
    | "CONSENT_REQUIRED"
    | "INVALID_DOCUMENT_VERSION"
    | "HASH_MISMATCH"
    | "INVALID_SIGNATURE"
    | "WALLET_REQUIRED";
  pendingDocuments?: LegalDocumentType[];

  constructor(
    code: LegalConsentError["code"],
    message: string,
    pendingDocuments?: LegalDocumentType[],
  ) {
    super(message);
    this.name = "LegalConsentError";
    this.code = code;
    this.pendingDocuments = pendingDocuments;
  }
}

export function isConsent166Enabled(): boolean {
  return isFeatureEnabled("phase-166");
}

export function getCanonicalDocuments(): {
  tos: LegalDocument;
  privacy: LegalDocument;
} {
  return {
    tos: {
      id: `tos-${CURRENT_TOS_VERSION}`,
      type: "tos",
      version: CURRENT_TOS_VERSION,
      title: "Terms of Service",
      content: CANONICAL_TOS_TEXT_V1,
      content_sha256: CANONICAL_TOS_HASH,
      effective_at: 1790812800, // Oct 1, 2026
    },
    privacy: {
      id: `privacy-${CURRENT_PRIVACY_VERSION}`,
      type: "privacy",
      version: CURRENT_PRIVACY_VERSION,
      title: "Privacy Policy",
      content: CANONICAL_PRIVACY_TEXT_V1,
      content_sha256: CANONICAL_PRIVACY_HASH,
      effective_at: 1790812800, // Oct 1, 2026
    },
  };
}

type TermsConsentStore = Record<string, ConsentRecord>;

async function readConsentStore(): Promise<TermsConsentStore> {
  return readStore<TermsConsentStore>("termsConsents", () => ({}));
}

/**
 * Retrieve consent record for a wallet.
 */
export async function getWalletConsent(
  wallet: string,
): Promise<ConsentRecord | null> {
  if (!wallet) return null;
  const store = await readConsentStore();
  return store[wallet] ?? null;
}

/**
 * Check whether a wallet has accepted the current canonical document versions and hashes.
 */
export async function hasAcceptedCurrentLegal(
  wallet: string,
): Promise<ConsentStatus> {
  const currentVersions = {
    tos: CURRENT_TOS_VERSION,
    privacy: CURRENT_PRIVACY_VERSION,
  };

  if (!wallet) {
    return {
      wallet: "",
      accepted: false,
      pending_documents: ["tos", "privacy"],
      current_versions: currentVersions,
      consent: null,
    };
  }

  const consent = await getWalletConsent(wallet);
  if (!consent) {
    return {
      wallet,
      accepted: false,
      pending_documents: ["tos", "privacy"],
      current_versions: currentVersions,
      consent: null,
    };
  }

  const pending: LegalDocumentType[] = [];

  const tosAccepted =
    consent.tos_version === CURRENT_TOS_VERSION &&
    consent.tos_hash === CANONICAL_TOS_HASH;
  if (!tosAccepted) {
    pending.push("tos");
  }

  const privacyAccepted =
    consent.privacy_version === CURRENT_PRIVACY_VERSION &&
    consent.privacy_hash === CANONICAL_PRIVACY_HASH;
  if (!privacyAccepted) {
    pending.push("privacy");
  }

  return {
    wallet,
    accepted: pending.length === 0,
    pending_documents: pending,
    current_versions: currentVersions,
    consent,
  };
}

/**
 * Record user consent with hash-pinned validation.
 */
export async function recordConsent(
  input: ConsentSubmitInput,
): Promise<ConsentRecord> {
  if (!isConsent166Enabled()) {
    throw new LegalConsentError(
      "FLAG_DISABLED",
      "Consent flows are disabled (phase-166 flag off)",
    );
  }

  const wallet = input.wallet?.trim();
  if (!wallet || wallet.length < 10) {
    throw new LegalConsentError("WALLET_REQUIRED", "Valid wallet is required");
  }

  // Validate ToS version & hash
  if (input.tos_version !== CURRENT_TOS_VERSION) {
    throw new LegalConsentError(
      "INVALID_DOCUMENT_VERSION",
      `Terms of Service version mismatch: expected ${CURRENT_TOS_VERSION}, got ${input.tos_version}`,
      ["tos"],
    );
  }
  if (input.tos_hash !== CANONICAL_TOS_HASH) {
    throw new LegalConsentError(
      "HASH_MISMATCH",
      `Terms of Service hash mismatch. Document content does not match version ${CURRENT_TOS_VERSION}`,
      ["tos"],
    );
  }

  // Validate Privacy Policy version & hash
  if (input.privacy_version !== CURRENT_PRIVACY_VERSION) {
    throw new LegalConsentError(
      "INVALID_DOCUMENT_VERSION",
      `Privacy Policy version mismatch: expected ${CURRENT_PRIVACY_VERSION}, got ${input.privacy_version}`,
      ["privacy"],
    );
  }
  if (input.privacy_hash !== CANONICAL_PRIVACY_HASH) {
    throw new LegalConsentError(
      "HASH_MISMATCH",
      `Privacy Policy hash mismatch. Document content does not match version ${CURRENT_PRIVACY_VERSION}`,
      ["privacy"],
    );
  }

  const now = Date.now();
  const record: ConsentRecord = {
    wallet,
    tos_version: input.tos_version,
    tos_hash: input.tos_hash,
    tos_accepted_at: now,
    privacy_version: input.privacy_version,
    privacy_hash: input.privacy_hash,
    privacy_accepted_at: now,
    accepted_at: now,
    signature: input.signature?.trim() || undefined,
    user_agent: input.user_agent?.trim() || undefined,
  };

  await updateStore<TermsConsentStore>("termsConsents", (store) => {
    store[wallet] = record;
  });

  return record;
}

/**
 * Asserts that the wallet has accepted current terms and privacy policy.
 * Throws LegalConsentError if consent is missing or outdated.
 */
export async function assertWalletConsent(wallet: string): Promise<void> {
  if (!isConsent166Enabled()) return;
  const status = await hasAcceptedCurrentLegal(wallet);
  if (!status.accepted) {
    throw new LegalConsentError(
      "CONSENT_REQUIRED",
      `Legal consent required: please accept ${status.pending_documents.join(" and ")}`,
      status.pending_documents,
    );
  }
}
