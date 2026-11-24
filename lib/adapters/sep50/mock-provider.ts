import { createHash } from "node:crypto";

import type { Sep50Attestation, Sep50Provider } from "./types";

/** Static network snapshot — the mock is impossible to enable on pubnet. */
const NETWORK_SNAPSHOT = (
  process.env.PHASE_NETWORK ??
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ??
  "testnet"
)
  .trim()
  .toLowerCase();

export class Sep50MockProviderFenceError extends Error {
  constructor() {
    super("SEP-50 mock provider is fenced to testnet only.");
    this.name = "Sep50MockProviderFenceError";
  }
}

export function signSep50Attestation(
  fields: Omit<Sep50Attestation, "signature">,
): string {
  return createHash("sha256")
    .update(
      `${fields.version}|${fields.subjectHash}|${fields.issuedAt}|` +
        `${fields.expiresAt}|${fields.issuerAccount}`,
    )
    .digest("base64url");
}

export interface Sep50MockConfig {
  readonly homeDomain: string;
  readonly issuerAccount: string;
  readonly subjectHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class Sep50MockProvider implements Sep50Provider {
  private readonly config: Sep50MockConfig;

  constructor(config: Sep50MockConfig) {
    this.config = config;
  }

  async discover(_homeDomain: string) {
    return {
      homeDomain: this.config.homeDomain,
      issuerAccount: this.config.issuerAccount,
      attestationUrl: "https://mock.sep50.testnet.local/attestation",
      network: "testnet" as const,
    };
  }

  async fetchAttestation(): Promise<Sep50Attestation> {
    const fields: Omit<Sep50Attestation, "signature"> = {
      version: 1,
      subjectHash: this.config.subjectHash,
      issuedAt: this.config.issuedAt,
      expiresAt: this.config.expiresAt,
      issuerAccount: this.config.issuerAccount,
    };
    return { ...fields, signature: signSep50Attestation(fields) };
  }
}

export function createTestnetSep50MockProvider(config: Sep50MockConfig): Sep50Provider {
  if (NETWORK_SNAPSHOT !== "testnet") throw new Sep50MockProviderFenceError();
  return new Sep50MockProvider(config);
}
