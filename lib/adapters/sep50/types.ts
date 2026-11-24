export type Sep50Network = "testnet" | "pubnet";

export interface Sep50IssuerDiscovery {
  readonly homeDomain: string;
  readonly issuerAccount: string;
  readonly attestationUrl: string;
  readonly network: Sep50Network;
}

export interface Sep10Session {
  readonly account: string;
  readonly homeDomain: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface Sep50Attestation {
  readonly version: 1;
  readonly subjectHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly issuerAccount: string;
  readonly signature: string;
}

export type Sep50InvalidReason =
  | "flag_disabled"
  | "unsupported_network"
  | "mock_outside_testnet"
  | "invalid_session"
  | "session_home_domain_mismatch"
  | "invalid_subject"
  | "subject_mismatch"
  | "issuer_mismatch"
  | "bad_signature"
  | "attestation_expired"
  | "attestation_not_yet_valid";

export type Sep50Outcome =
  | { readonly status: "ok"; readonly subjectHash: string; readonly homeDomain: string }
  | { readonly status: "invalid"; readonly reason: Sep50InvalidReason }
  | { readonly status: "unavailable"; readonly retryAfter: number; readonly reason: string };

export interface Sep50Provider {
  discover(homeDomain: string): Promise<Sep50IssuerDiscovery>;
  fetchAttestation(attestationUrl: string, sep10Token: string): Promise<Sep50Attestation>;
}

export class Sep50ProviderUnavailableError extends Error {
  readonly retryAfter: number;

  constructor(message: string, retryAfter = 30) {
    super(message);
    this.name = "Sep50ProviderUnavailableError";
    this.retryAfter = retryAfter;
  }
}
