import { createHash } from "node:crypto";

import { isFlagEnabled } from "@/lib/flags/registry";
import {
  VerificationCounters,
  type ChainHeader,
  type StateProof,
  type VerificationOutcome,
  type VerificationReason,
  type VerifierConfig,
} from "./types";

export interface CrossChainDeps {
  readonly config: VerifierConfig;
  readonly now: () => number;
  readonly counters: VerificationCounters;
  /** Test seam; production uses the static phase-219 env flag. */
  readonly flagEnabled?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function headerHash(header: ChainHeader): string {
  return sha256(
    `${header.chain}|${header.network}|${header.height}|${header.parentHash}|${header.timestamp}`,
  );
}

export function proofRoot(proof: Pick<StateProof, "key" | "value" | "siblings">): string {
  let current = sha256(`${proof.key}|${proof.value}`);
  for (const sibling of proof.siblings) {
    current = sha256(`${current}|${sibling}`);
  }
  return current;
}

function invalid(deps: CrossChainDeps, reason: VerificationReason): VerificationOutcome {
  deps.counters.increment("rejected");
  return { status: "invalid", reason };
}

/**
 * Read-only light-client-style verifier. It accepts no write handle and
 * returns no authority of any kind — only a key/value observation.
 */
export function verifyProof(
  proof: StateProof,
  deps: CrossChainDeps,
): VerificationOutcome {
  if (!(deps.flagEnabled ?? isFlagEnabled("phase-219"))) {
    return { status: "disabled" };
  }

  const { trustRoot, maxHeaderAgeMs } = deps.config;
  const header = proof.header;
  const now = deps.now();

  if (header.network !== trustRoot.network) return invalid(deps, "wrong_network");
  if (header.chain !== trustRoot.chain) return invalid(deps, "wrong_chain");
  if (now - header.timestamp > maxHeaderAgeMs) return invalid(deps, "stale_header");
  if (header.timestamp > now + 30_000) return invalid(deps, "future_header");
  if (headerHash(header) !== header.hash) return invalid(deps, "tampered_header");
  if (now < trustRoot.validFrom || now > trustRoot.validTo) {
    return invalid(deps, "trust_root_out_of_window");
  }
  if (proof.rootHash !== trustRoot.rootHash) return invalid(deps, "trust_root_mismatch");
  if (proofRoot(proof) !== proof.rootHash) return invalid(deps, "tampered_proof");

  deps.counters.increment("verified");
  return { status: "ok", key: proof.key, value: proof.value, height: header.height };
}
