export type ChainId = "stellar" | "evm";
export type ChainNetwork = "testnet" | "pubnet";

export interface ChainHeader {
  readonly chain: ChainId;
  readonly network: ChainNetwork;
  readonly height: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: number;
}

export interface StateProof {
  readonly header: ChainHeader;
  readonly key: string;
  readonly value: string;
  readonly siblings: readonly string[];
  readonly rootHash: string;
}

export interface TrustRoot {
  readonly chain: ChainId;
  readonly network: ChainNetwork;
  readonly rootHash: string;
  readonly validFrom: number;
  readonly validTo: number;
}

export interface VerifierConfig {
  readonly trustRoot: TrustRoot;
  readonly maxHeaderAgeMs: number;
}

export type VerificationReason =
  | "wrong_network"
  | "wrong_chain"
  | "stale_header"
  | "future_header"
  | "tampered_header"
  | "trust_root_out_of_window"
  | "trust_root_mismatch"
  | "tampered_proof";

export type VerificationOutcome =
  | { readonly status: "ok"; readonly key: string; readonly value: string; readonly height: number }
  | { readonly status: "invalid"; readonly reason: VerificationReason }
  | { readonly status: "disabled" };

/** Read-only counters: private backing fields, no reset or external mutation. */
export class VerificationCounters {
  #verified = 0;
  #rejected = 0;

  increment(kind: "verified" | "rejected"): void {
    if (kind === "verified") this.#verified++;
    else this.#rejected++;
  }

  snapshot(): Readonly<{ verified: number; rejected: number }> {
    return Object.freeze({ verified: this.#verified, rejected: this.#rejected });
  }
}
