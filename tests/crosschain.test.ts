import assert from "node:assert/strict";
import test from "node:test";

import {
  headerHash,
  proofRoot,
  verifyProof,
  type CrossChainDeps,
} from "../lib/adapters/crosschain/adapter.ts";
import { VerificationCounters } from "../lib/adapters/crosschain/types.ts";
import type { ChainHeader, StateProof, VerifierConfig } from "../lib/adapters/crosschain/types.ts";

const NOW = 1_700_000_000_000;
const SIBLINGS = ["sibling-a", "sibling-b"] as const;

function makeProof(overrides: Partial<StateProof> = {}, headerOverrides: Partial<ChainHeader> = {}) {
  const headerBase: ChainHeader = {
    chain: "stellar",
    network: "testnet",
    height: 100,
    parentHash: "parent-hash",
    timestamp: NOW - 1_000,
    hash: "",
    ...headerOverrides,
  };
  const header: ChainHeader = { ...headerBase, hash: headerHash(headerBase) };
  const root = proofRoot({ key: "owner:1", value: "GUSER", siblings: SIBLINGS });
  const proof: StateProof = {
    header,
    key: "owner:1",
    value: "GUSER",
    siblings: SIBLINGS,
    rootHash: root,
    ...overrides,
  };
  return proof;
}

function makeConfig(rootHash: string, overrides: Partial<VerifierConfig> = {}): VerifierConfig {
  return {
    trustRoot: {
      chain: "stellar",
      network: "testnet",
      rootHash,
      validFrom: NOW - 10_000,
      validTo: NOW + 10_000,
    },
    maxHeaderAgeMs: 60_000,
    ...overrides,
  };
}

function deps(proof: StateProof, flagEnabled = true) {
  const counters = new VerificationCounters();
  const config = makeConfig(proof.rootHash);
  const result: CrossChainDeps = { config, now: () => NOW, counters, flagEnabled };
  return { ...result, counters };
}

test("valid proof is accepted with read-only output", () => {
  const proof = makeProof();
  const d = deps(proof);
  const outcome = verifyProof(proof, d);
  assert.equal(outcome.status, "ok");
  if (outcome.status === "ok") {
    assert.deepEqual(Object.keys(outcome).sort(), ["height", "key", "status", "value"]);
    assert.equal(outcome.height, 100);
  }
});

test("tampered value and tampered header are rejected", () => {
  const proof = makeProof();
  const tamperedValue = verifyProof({ ...proof, value: "GATTACKER" }, deps(proof));
  assert.deepEqual(tamperedValue, { status: "invalid", reason: "tampered_proof" });

  const tamperedHeader = { ...proof, header: { ...proof.header, height: 101 } };
  const badHeader = verifyProof(tamperedHeader, deps(proof));
  assert.deepEqual(badHeader, { status: "invalid", reason: "tampered_header" });
});

test("wrong network and stale headers are rejected", () => {
  const proof = makeProof();
  const wrongNetwork = verifyProof(makeProof({}, { network: "pubnet" }), deps(proof));
  assert.deepEqual(wrongNetwork, { status: "invalid", reason: "wrong_network" });

  const stale = verifyProof(makeProof({}, { timestamp: NOW - 120_000 }), deps(proof));
  assert.deepEqual(stale, { status: "invalid", reason: "stale_header" });

  const wrongChain = verifyProof(makeProof({}, { chain: "evm" }), deps(proof));
  assert.deepEqual(wrongChain, { status: "invalid", reason: "wrong_chain" });
});

test("trust-root mismatch and out-of-window root are rejected", () => {
  const proof = makeProof();
  const d = deps(proof);
  const mismatch = verifyProof(
    { ...proof, rootHash: "a".repeat(64) },
    { ...d, config: makeConfig(proof.rootHash) },
  );
  assert.deepEqual(mismatch, { status: "invalid", reason: "trust_root_mismatch" });

  const expiredConfig: VerifierConfig = {
    ...d.config,
    trustRoot: { ...d.config.trustRoot, validTo: NOW - 1 },
  };
  const expired = verifyProof(proof, { ...d, config: expiredConfig });
  assert.deepEqual(expired, { status: "invalid", reason: "trust_root_out_of_window" });
});

test("flag off disables the verifier without touching counters", () => {
  const proof = makeProof();
  const d = deps(proof, false);
  assert.deepEqual(verifyProof(proof, d), { status: "disabled" });
  assert.deepEqual(d.counters.snapshot(), { verified: 0, rejected: 0 });
});

test("counters are monotonic and cannot be reset from outside", () => {
  const proof = makeProof();
  const d = deps(proof);
  verifyProof(proof, d);
  verifyProof({ ...proof, value: "BAD" }, d);
  assert.deepEqual(d.counters.snapshot(), { verified: 1, rejected: 1 });

  const snapshot = d.counters.snapshot();
  assert.throws(() => {
    (snapshot as { verified: number }).verified = 99;
  });
  assert.equal(d.counters.snapshot().verified, 1);
});
