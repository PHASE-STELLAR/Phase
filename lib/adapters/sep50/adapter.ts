import { createHash } from "node:crypto";

import { isFlagEnabled } from "@/lib/flags/registry";
import {
  Sep50ProviderUnavailableError,
  type Sep50Attestation,
  type Sep50InvalidReason,
  type Sep50Outcome,
  type Sep50Provider,
  type Sep10Session,
} from "./types";

export interface Sep50AdapterDeps {
  readonly provider: Sep50Provider;
  readonly now: () => number;
  /** True only for the fenced testnet mock provider. */
  readonly isMockProvider: boolean;
  /** Test seam; production always uses the static env snapshot. */
  readonly flagEnabled?: boolean;
  readonly hashSubject?: (account: string, issuer: string) => string;
  readonly verifySignature?: (attestation: Sep50Attestation, issuerAccount: string) => boolean;
}

export interface Sep50CheckInput {
  readonly homeDomain: string;
  readonly session: Sep10Session;
}

export function defaultSubjectHash(account: string, issuer: string): string {
  return createHash("sha256")
    .update(`${account}|${issuer}`)
    .digest("base64url");
}

export function defaultVerifySignature(
  attestation: Sep50Attestation,
  issuerAccount: string,
): boolean {
  if (attestation.issuerAccount !== issuerAccount) return false;
  const expected = createHash("sha256")
    .update(
      `${attestation.version}|${attestation.subjectHash}|${attestation.issuedAt}|` +
        `${attestation.expiresAt}|${attestation.issuerAccount}`,
    )
    .digest("base64url");
  return expected === attestation.signature;
}

function looksLikeHash(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function invalid(reason: Sep50InvalidReason): Sep50Outcome {
  return { status: "invalid", reason };
}

/**
 * SEP-50 check. Fails closed: any provider error becomes an unavailable
 * outcome with a retry hint, and any verification failure becomes invalid.
 * Only the hashed subject is ever returned — no account, token or claim data.
 */
export async function runSep50Check(
  input: Sep50CheckInput,
  deps: Sep50AdapterDeps,
): Promise<Sep50Outcome> {
  if (!(deps.flagEnabled ?? isFlagEnabled("phase-217"))) {
    return invalid("flag_disabled");
  }

  const homeDomain = input.homeDomain.trim().toLowerCase();
  const session = input.session;
  if (
    homeDomain.length === 0 ||
    session.account.trim().length < 10 ||
    session.token.trim().length === 0 ||
    session.expiresAt <= deps.now()
  ) {
    return invalid("invalid_session");
  }

  let discovery;
  try {
    discovery = await deps.provider.discover(homeDomain);
  } catch (error) {
    const retryAfter =
      error instanceof Sep50ProviderUnavailableError ? error.retryAfter : 30;
    return { status: "unavailable", retryAfter, reason: "discovery_failed" };
  }

  if (discovery.network !== "testnet") return invalid("unsupported_network");
  if (deps.isMockProvider && discovery.network !== "testnet") {
    return invalid("mock_outside_testnet");
  }
  if (session.homeDomain.trim().toLowerCase() !== homeDomain) {
    return invalid("session_home_domain_mismatch");
  }

  let attestation: Sep50Attestation;
  try {
    attestation = await deps.provider.fetchAttestation(
      discovery.attestationUrl,
      session.token,
    );
  } catch (error) {
    const retryAfter =
      error instanceof Sep50ProviderUnavailableError ? error.retryAfter : 30;
    return { status: "unavailable", retryAfter, reason: "attestation_fetch_failed" };
  }

  const now = deps.now();
  if (attestation.issuedAt > now + 30) return invalid("attestation_not_yet_valid");
  if (attestation.expiresAt <= now) return invalid("attestation_expired");
  if (attestation.issuerAccount !== discovery.issuerAccount) {
    return invalid("issuer_mismatch");
  }
  if (!looksLikeHash(attestation.subjectHash)) return invalid("invalid_subject");

  const expectedHash = (deps.hashSubject ?? defaultSubjectHash)(
    session.account,
    discovery.issuerAccount,
  );
  if (attestation.subjectHash !== expectedHash) return invalid("subject_mismatch");

  const verify = deps.verifySignature ?? defaultVerifySignature;
  if (!verify(attestation, discovery.issuerAccount)) return invalid("bad_signature");

  return { status: "ok", subjectHash: attestation.subjectHash, homeDomain };
}
