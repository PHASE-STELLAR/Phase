import { isFlagEnabled } from "@/lib/flags/registry";
import {
  BridgeDriftError,
  BridgeFeeError,
  BridgePartialFillError,
  BridgePubnetFencedError,
  BridgeStateError,
  type BridgeCustody,
  type BridgeIntent,
  type BridgeLimits,
  type BridgeNetwork,
  type BridgeRecord,
  type BridgeRoute,
  type BridgeStore,
  type FinalityOracle,
} from "./types";

export const TESTNET_BRIDGE_ROUTES: readonly BridgeRoute[] = [
  { id: "stellar-to-evm", from: "stellar", to: "evm", network: "testnet" },
];

export interface BridgeDeps {
  readonly store: BridgeStore;
  readonly custody: BridgeCustody;
  readonly oracle: FinalityOracle;
  readonly limits: BridgeLimits;
  readonly network: BridgeNetwork;
  readonly now: () => number;
  /** Test seam; production uses the static phase-218 env flag. */
  readonly flagEnabled?: boolean;
}

export interface PreparedLock {
  readonly intent: BridgeIntent;
  readonly signingBoundary: "client";
  /** Server never signs the Stellar leg; the wallet builds and signs the XDR. */
  readonly lockRequest: {
    readonly sourceAccount: string;
    readonly amount: number;
    readonly asset: string;
    readonly destinationMemo: string;
  };
}

export interface RelayResult {
  readonly record: BridgeRecord;
  readonly mintTxHash: string;
  readonly replayed: boolean;
}

function assertBridgeEnabled(deps: BridgeDeps): void {
  if (!(deps.flagEnabled ?? isFlagEnabled("phase-218"))) {
    throw new BridgeStateError("BRIDGE_DISABLED", "The EVM bridge flag is off.");
  }
}

export function bridgeRoutes(
  flagEnabled: boolean = isFlagEnabled("phase-218"),
): readonly BridgeRoute[] {
  return flagEnabled ? TESTNET_BRIDGE_ROUTES : [];
}

export function assertTestnetFenced(network: BridgeNetwork): void {
  if (network !== "testnet") throw new BridgePubnetFencedError();
}

export function prepareLock(intent: BridgeIntent, deps: BridgeDeps): PreparedLock {
  assertBridgeEnabled(deps);
  assertTestnetFenced(deps.network);

  if (
    !intent.sourceTxHash ||
    intent.amount <= 0 ||
    intent.quotedAmount <= 0 ||
    !/^0x[a-fA-F0-9]{40}$/.test(intent.destinationEvmAddress) ||
    !intent.stellarAccount ||
    !intent.asset
  ) {
    throw new BridgeStateError("INVALID_LOCK_INTENT", "Lock intent is malformed.");
  }

  const driftBps = Math.round(
    (Math.abs(intent.amount - intent.quotedAmount) / intent.quotedAmount) * 10_000,
  );
  if (driftBps > deps.limits.maxDriftBps) throw new BridgeDriftError();
  if (intent.fee > intent.maxFee) throw new BridgeFeeError();

  return {
    intent,
    signingBoundary: "client",
    lockRequest: {
      sourceAccount: intent.stellarAccount,
      amount: intent.amount,
      asset: intent.asset,
      destinationMemo: intent.destinationEvmAddress,
    },
  };
}

export async function recordLock(intent: BridgeIntent, deps: BridgeDeps): Promise<BridgeRecord> {
  assertBridgeEnabled(deps);
  assertTestnetFenced(deps.network);

  const existing = await deps.store.get(intent.sourceTxHash);
  if (existing !== null) {
    if (
      existing.amount !== intent.amount ||
      existing.destinationEvmAddress !== intent.destinationEvmAddress
    ) {
      throw new BridgeStateError("LOCK_CONFLICT", "Source tx hash already maps to a different lock.");
    }
    return existing;
  }
  return deps.store.put({
    sourceTxHash: intent.sourceTxHash,
    status: "locked",
    amount: intent.amount,
    filledAmount: intent.amount,
    asset: intent.asset,
    destinationEvmAddress: intent.destinationEvmAddress,
    confirmations: 0,
    createdAt: deps.now(),
  });
}

export async function applyPartialFill(
  sourceTxHash: string,
  filledAmount: number,
  deps: BridgeDeps,
): Promise<BridgeRecord> {
  assertBridgeEnabled(deps);
  const record = await requireRecord(deps.store, sourceTxHash);
  if (record.status === "minted") {
    throw new BridgeStateError("ALREADY_MINTED", "Cannot partially fill a minted lock.");
  }
  if (!Number.isFinite(filledAmount) || filledAmount <= 0 || filledAmount > record.amount) {
    throw new BridgePartialFillError();
  }
  return deps.store.update(sourceTxHash, (current) => ({
    ...current,
    filledAmount,
  }));
}

export async function advanceFinality(
  sourceTxHash: string,
  deps: BridgeDeps,
): Promise<BridgeRecord> {
  assertBridgeEnabled(deps);
  const record = await requireRecord(deps.store, sourceTxHash);
  if (record.status === "minted") return record;

  const confirmations = await deps.oracle.confirmations(sourceTxHash);
  return deps.store.update(sourceTxHash, (current) => ({
    ...current,
    confirmations,
    status:
      confirmations >= deps.limits.finalityDepth
        ? "confirming"
        : current.status === "orphaned"
          ? "orphaned"
          : "locked",
  }));
}

export async function detectOrphan(
  sourceTxHash: string,
  deps: BridgeDeps,
): Promise<BridgeRecord> {
  assertBridgeEnabled(deps);
  const record = await requireRecord(deps.store, sourceTxHash);
  if (
    record.status === "locked" &&
    record.confirmations === 0 &&
    deps.now() - record.createdAt > deps.limits.orphanAfterMs
  ) {
    return deps.store.update(sourceTxHash, (current) => ({ ...current, status: "orphaned" }));
  }
  return record;
}

/** Documented recovery: re-check finality, re-run custody recovery, then re-queue. */
export async function recoverOrphan(
  sourceTxHash: string,
  deps: BridgeDeps,
): Promise<BridgeRecord> {
  assertBridgeEnabled(deps);
  const record = await requireRecord(deps.store, sourceTxHash);
  if (record.status !== "orphaned") {
    throw new BridgeStateError("NOT_ORPHANED", "Record is not orphaned.");
  }
  const confirmations = await deps.oracle.confirmations(sourceTxHash);
  if (confirmations < deps.limits.finalityDepth) {
    throw new BridgeStateError("STILL_UNCONFIRMED", "Orphan is not yet final.");
  }
  await deps.custody.recover(record);
  return deps.store.update(sourceTxHash, (current) => ({
    ...current,
    confirmations,
    status: "confirming",
  }));
}

export async function relayMint(
  sourceTxHash: string,
  deps: BridgeDeps,
): Promise<RelayResult> {
  assertBridgeEnabled(deps);
  const record = await requireRecord(deps.store, sourceTxHash);
  if (record.status === "minted" && record.mintTxHash !== undefined) {
    return { record, mintTxHash: record.mintTxHash, replayed: true };
  }
  if (record.status !== "confirming") {
    throw new BridgeStateError("NOT_FINAL", "Message has not reached finality.");
  }
  if (!(await deps.store.claimMint(sourceTxHash))) {
    throw new BridgeStateError("MINT_IN_FLIGHT", "A mint for this source tx is already in flight.");
  }
  try {
    const result = await deps.custody.mint(
      record.destinationEvmAddress,
      record.filledAmount,
      record.sourceTxHash,
    );
    const updated = await deps.store.update(sourceTxHash, (current) => ({
      ...current,
      status: "minted",
      mintTxHash: result.txHash,
    }));
    return { record: updated, mintTxHash: result.txHash, replayed: false };
  } catch (error) {
    await deps.store.releaseMintClaim(sourceTxHash);
    throw error;
  }
}

async function requireRecord(store: BridgeStore, sourceTxHash: string): Promise<BridgeRecord> {
  const record = await store.get(sourceTxHash);
  if (record === null) {
    throw new BridgeStateError("UNKNOWN_LOCK", `No bridge lock for ${sourceTxHash}.`);
  }
  return record;
}
