import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultSubjectHash,
  defaultVerifySignature,
  runSep50Check,
} from "../lib/adapters/sep50/adapter.ts";
import { signSep50Attestation } from "../lib/adapters/sep50/mock-provider.ts";
import {
  Sep50ProviderUnavailableError,
  type Sep50Attestation,
  type Sep50Provider,
  type Sep10Session,
} from "../lib/adapters/sep50/types.ts";

const ISSUER = "GSEP50ISSUERTESTNETACCOUNT0000000000000000000000000000000000";
const ACCOUNT = "GUSERTESTNETACCOUNT00000000000000000000000000000000000000";
const HOME_DOMAIN = "phase.testnet.local";
const NOW = 1_700_000_000_000;
const SUBJECT = defaultSubjectHash(ACCOUNT, ISSUER);

function attestation(overrides: Partial<Sep50Attestation> = {}): Sep50Attestation {
  const fields = {
    version: 1 as const,
    subjectHash: SUBJECT,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    issuerAccount: ISSUER,
    ...overrides,
  };
  return { ...fields, signature: overrides.signature ?? signSep50Attestation(fields) };
}

function provider(overrides: {
  attestation?: Sep50Attestation;
  fail?: boolean;
  network?: "testnet" | "pubnet";
  issuer?: string;
} = {}): Sep50Provider {
  return {
    async discover() {
      if (overrides.fail) throw new Sep50ProviderUnavailableError("down", 17);
      return {
        homeDomain: HOME_DOMAIN,
        issuerAccount: overrides.issuer ?? ISSUER,
        attestationUrl: "https://mock.testnet/attest",
        network: overrides.network ?? "testnet",
      };
    },
    async fetchAttestation() {
      if (overrides.fail) throw new Sep50ProviderUnavailableError("down", 17);
      return overrides.attestation ?? attestation();
    },
  };
}

const session: Sep10Session = {
  account: ACCOUNT,
  homeDomain: HOME_DOMAIN,
  token: "sep10-token",
  expiresAt: NOW + 120_000,
};

const deps = (p: Sep50Provider, flagEnabled = true) => ({
  provider: p,
  now: () => NOW,
  isMockProvider: false,
  flagEnabled,
});

test("valid attestation is accepted and only the hashed subject is returned", async () => {
  const outcome = await runSep50Check(
    { homeDomain: HOME_DOMAIN, session },
    deps(provider()),
  );
  assert.equal(outcome.status, "ok");
  assert.deepEqual(Object.keys(outcome).sort(), ["homeDomain", "status", "subjectHash"]);
  if (outcome.status === "ok") assert.equal(outcome.subjectHash, SUBJECT);
  assert.equal(JSON.stringify(outcome).includes(ACCOUNT), false);
  assert.equal(JSON.stringify(outcome).includes("sep10-token"), false);
});

test("tampered signature and tampered subject are rejected", async () => {
  const badSignature = await runSep50Check(
    { homeDomain: HOME_DOMAIN, session },
    deps(provider({ attestation: attestation({ signature: "tampered" }) })),
  );
  assert.deepEqual(badSignature, { status: "invalid", reason: "bad_signature" });

  const badSubject = await runSep50Check(
    { homeDomain: HOME_DOMAIN, session },
    deps(provider({ attestation: attestation({ subjectHash: "a".repeat(43) }) })),
  );
  assert.deepEqual(badSubject, { status: "invalid", reason: "subject_mismatch" });
});

test("expired attestation is rejected", async () => {
  const outcome = await runSep50Check(
    { homeDomain: HOME_DOMAIN, session },
    deps(provider({ attestation: attestation({ expiresAt: NOW - 1 }) })),
  );
  assert.deepEqual(outcome, { status: "invalid", reason: "attestation_expired" });
});

test("provider outage fails closed with 503-style retry hint", async () => {
  const outcome = await runSep50Check(
    { homeDomain: HOME_DOMAIN, session },
    deps(provider({ fail: true })),
  );
  assert.deepEqual(outcome, {
    status: "unavailable",
    retryAfter: 17,
    reason: "discovery_failed",
  });
});

test("flag off disables the adapter before any provider call", async () => {
  let called = false;
  const p: Sep50Provider = {
    async discover() {
      called = true;
      throw new Error("should not be reached");
    },
    async fetchAttestation() {
      throw new Error("should not be reached");
    },
  };
  const outcome = await runSep50Check({ homeDomain: HOME_DOMAIN, session }, deps(p, false));
  assert.deepEqual(outcome, { status: "invalid", reason: "flag_disabled" });
  assert.equal(called, false);
});

test("SEP-10 session binding and network fence are enforced", async () => {
  const wrongSession = await runSep50Check(
    { homeDomain: HOME_DOMAIN, session: { ...session, homeDomain: "evil.test" } },
    deps(provider()),
  );
  assert.deepEqual(wrongSession, {
    status: "invalid",
    reason: "session_home_domain_mismatch",
  });

  const expiredSession = await runSep50Check(
    { homeDomain: HOME_DOMAIN, session: { ...session, expiresAt: NOW - 1 } },
    deps(provider()),
  );
  assert.deepEqual(expiredSession, { status: "invalid", reason: "invalid_session" });

  const pubnet = await runSep50Check(
    { homeDomain: HOME_DOMAIN, session },
    deps(provider({ network: "pubnet" })),
  );
  assert.deepEqual(pubnet, { status: "invalid", reason: "unsupported_network" });
});

test("default verification rejects a signature from a different issuer", () => {
  const a = attestation();
  assert.equal(defaultVerifySignature(a, ISSUER), true);
  assert.equal(defaultVerifySignature(a, "GOTHERISSUER"), false);
});
