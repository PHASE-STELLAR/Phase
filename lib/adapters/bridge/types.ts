export type BridgeNetwork = "testnet" | "pubnet";

export type BridgeStatus = "locked" | "confirming" | "minted" | "orphaned";

export interface BridgeRoute {
  readonly id: "stellar-to-evm";
  readonly from: "stellar";
  readonly to: "evm";
  readonly network: BridgeNetwork;
}

export interface BridgeIntent {
  sourceTxHash: string;
  amount: number;
  quotedAmount: number;
  fee: number;
  maxFee: number;
  destinationEvmAddress: string;
  stellarAccount: string;
  asset: string;
}

export interface BridgeRecord {
  readonly sourceTxHash: string;
  status: BridgeStatus;
  readonly amount: number;
  readonly asset: string;
  readonly destinationEvmAddress: string;
  readonly createdAt: number;
  filledAmount: number;
  confirmations: number;
  mintTxHash?: string;
}

export interface BridgeLimits {
  /** Maximum allowed lock-amount drift in basis points. */
  readonly maxDriftBps: number;
  readonly finalityDepth: number;
  readonly orphanAfterMs: number;
}

export interface FinalityOracle {
  confirmations(sourceTxHash: string): Promise<number>;
}

export interface MintResult {
  readonly txHash: string;
}

/**
 * Server-side custody is limited to the EVM side of the bridge. The Stellar
 * leg is always signed by the user's wallet (client boundary); this interface
 * must never accept or hold a Stellar secret key.
 */
export interface BridgeCustody {
  mint(recipient: string, amount: number, idempotencyKey: string): Promise<MintResult>;
  recover(record: BridgeRecord): Promise<void>;
}

export interface BridgeStore {
  get(sourceTxHash: string): Promise<BridgeRecord | null>;
  put(record: BridgeRecord): Promise<BridgeRecord>;
  update(
    sourceTxHash: string,
    patch: (record: BridgeRecord) => BridgeRecord,
  ): Promise<BridgeRecord>;
  /** Atomic mint claim keyed by source tx hash. Prevents concurrent double-mint. */
  claimMint(sourceTxHash: string): Promise<boolean>;
  releaseMintClaim(sourceTxHash: string): Promise<void>;
}

export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export class BridgePubnetFencedError extends BridgeError {
  constructor() {
    super("PUBNET_FENCED", "The PHASELQ EVM bridge is testnet-only.");
    this.name = "BridgePubnetFencedError";
  }
}

export class BridgeDriftError extends BridgeError {
  constructor() {
    super("DRIFT_EXCEEDED", "Lock amount drift exceeds the configured tolerance.");
    this.name = "BridgeDriftError";
  }
}

export class BridgeFeeError extends BridgeError {
  constructor() {
    super("FEE_EXCEEDED", "Quoted fee exceeds the maximum allowed fee.");
    this.name = "BridgeFeeError";
  }
}

export class BridgePartialFillError extends BridgeError {
  constructor() {
    super("PARTIAL_FILL_INVALID", "Partial fill amount is invalid for this lock.");
    this.name = "BridgePartialFillError";
  }
}

export class BridgeStateError extends BridgeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BridgeStateError";
  }
}
