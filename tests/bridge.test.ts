import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceFinality,
  applyPartialFill,
  bridgeRoutes,
  detectOrphan,
  prepareLock,
  recordLock,
  recoverOrphan,
  relayMint,
  type BridgeDeps,
} from "../lib/adapters/bridge/adapter.ts";
import { MemoryBridgeStore } from "../lib/adapters/bridge/store.ts";
import {
  BridgeDriftError,
  BridgeFeeError,
  BridgePartialFillError,
  BridgePubnetFencedError,
  BridgeStateError,
  type BridgeCustody,
  type BridgeIntent,
  type FinalityOracle,
} from "../lib/adapters/bridge/types.ts";

const NOW = 1_700_000_000_000;
const DEST = "0x1111111111111111111111111111111111111111";

function intent(overrides: Partial<BridgeIntent> = {}): BridgeIntent {
  return {
    sourceTxHash: "stellar-source-hash-001",
    amount: 1_000,
    quotedAmount: 1_000,
    fee: 10,
    maxFee: 20,
    destinationEvmAddress: DEST,
    stellarAccount: "GSTELLARUSERACCOUNT000000000000000000000000000000000000",
    asset: "PHASELQ",
    ...overrides,
  };
}

function makeDeps(options: {
  confirmations?: number;
  orphanAfterMs?: number;
  finalityDepth?: number;
} = {}) {
  const store = new MemoryBridgeStore();
  let mintCount = 0;
  let recoverCount = 0;
  const mintAmounts: number[] = [];
  const custody: BridgeCustody = {
    async mint(recipient, amount, idempotencyKey) {
      mintCount++;
      mintAmounts.push(amount);
      assert.equal(recipient, DEST);
      assert.equal(idempotencyKey, "stellar-source-hash-001");
      return { txHash: `0xmint${mintCount}` };
    },
    async recover() {
      recoverCount++;
    },
  };
  const oracle: FinalityOracle = {
    async confirmations() {
      return options.confirmations ?? 12;
    },
  };
  const deps: BridgeDeps = {
    store,
    custody,
    oracle,
    limits: {
      finalityDepth: options.finalityDepth ?? 3,
      maxDriftBps: 50,
      orphanAfterMs: options.orphanAfterMs ?? 1_000,
    },
    network: "testnet",
    now: () => NOW,
    flagEnabled: true,
  };
  return {
    deps,
    store,
    mintCount: () => mintCount,
    recoverCount: () => recoverCount,
    mintAmounts,
    setConfirmations: (value: number) => {
      oracle.confirmations = async () => value;
    },
  };
}

test("flag off exposes no bridge routes", () => {
  assert.deepEqual(bridgeRoutes(false), []);
  const routes = bridgeRoutes(true);
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.network, "testnet");
});

test("pubnet is fenced before any lock is prepared", () => {
  const { deps } = makeDeps();
  assert.throws(
    () => prepareLock(intent(), { ...deps, network: "pubnet" }),
    BridgePubnetFencedError,
  );
});

test("client-side signing boundary, drift and fee fences", () => {
  const { deps } = makeDeps();
  const prepared = prepareLock(intent(), deps);
  assert.equal(prepared.signingBoundary, "client");
  assert.equal(prepared.lockRequest.sourceAccount, intent().stellarAccount);
  assert.equal(JSON.stringify(prepared).includes("secret"), false);
  assert.equal(JSON.stringify(prepared).includes("signature"), false);

  assert.throws(
    () => prepareLock(intent({ amount: 1_100 }), deps),
    BridgeDriftError,
  );
  assert.throws(
    () => prepareLock(intent({ fee: 100 }), deps),
    BridgeFeeError,
  );
});

test("replay never double-mints and finality depth is configurable", async () => {
  const { deps } = makeDeps({ confirmations: 2, finalityDepth: 3 });
  await recordLock(intent(), deps);
  await advanceFinality("stellar-source-hash-001", deps);
  assert.equal((await deps.store.get("stellar-source-hash-001"))?.status, "locked");
  await assert.rejects(
    relayMint("stellar-source-hash-001", deps),
    (error: unknown) => error instanceof BridgeStateError && error.code === "NOT_FINAL",
  );

  const deep = makeDeps({ confirmations: 3, finalityDepth: 3 });
  await recordLock(intent(), deep.deps);
  await advanceFinality("stellar-source-hash-001", deep.deps);
  assert.equal((await deep.store.get("stellar-source-hash-001"))?.status, "confirming");

  const run = makeDeps({ confirmations: 3 });
  await recordLock(intent(), run.deps);
  await advanceFinality("stellar-source-hash-001", run.deps);
  const first = await relayMint("stellar-source-hash-001", run.deps);
  const replay = await relayMint("stellar-source-hash-001", run.deps);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.mintTxHash, first.mintTxHash);
  assert.equal(run.mintCount(), 1);
});

test("partial fill mints only the filled amount and rejects overfill", async () => {
  const ctx = makeDeps({ confirmations: 3 });
  const { deps } = ctx;
  await recordLock(intent(), deps);
  await assert.rejects(
    applyPartialFill("stellar-source-hash-001", 1_100, deps),
    BridgePartialFillError,
  );
  await applyPartialFill("stellar-source-hash-001", 400, deps);
  await advanceFinality("stellar-source-hash-001", deps);
  await relayMint("stellar-source-hash-001", deps);
  assert.deepEqual(ctx.mintAmounts, [400]);
  assert.equal(ctx.mintCount(), 1);
});

test("orphaned messages are recoverable through a documented procedure", async () => {
  const ctx = makeDeps({ confirmations: 0 });
  const { deps } = ctx;
  await recordLock(intent(), deps);
  const orphan = await detectOrphan("stellar-source-hash-001", { ...deps, now: () => NOW + 2_000 });
  assert.equal(orphan.status, "orphaned");

  await assert.rejects(
    recoverOrphan("stellar-source-hash-001", deps),
    (error: unknown) => error instanceof BridgeStateError && error.code === "STILL_UNCONFIRMED",
  );

  ctx.setConfirmations(3);
  const recovered = await recoverOrphan("stellar-source-hash-001", deps);
  assert.equal(recovered.status, "confirming");
  assert.equal(ctx.recoverCount(), 1);
  const minted = await relayMint("stellar-source-hash-001", deps);
  assert.equal(minted.replayed, false);
  assert.equal(ctx.mintCount(), 1);
});

test("concurrent replay claims the mint exactly once", async () => {
  const ctx = makeDeps({ confirmations: 3 });
  const { deps } = ctx;
  await recordLock(intent(), deps);
  await advanceFinality("stellar-source-hash-001", deps);
  const results = await Promise.allSettled([
    relayMint("stellar-source-hash-001", deps),
    relayMint("stellar-source-hash-001", deps),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal(ctx.mintCount(), 1);
});
