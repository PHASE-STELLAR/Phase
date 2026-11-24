import { afterEach, beforeEach, describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { TransactionBuilder, StrKey } from "@stellar/stellar-sdk"

const routerId = StrKey.encodeContract(Buffer.alloc(32, 1))
const pinnedRouterId = StrKey.encodeContract(Buffer.alloc(32, 2))
import {
  CLASSIC_POOL_FEE_BPS,
  LP_QUOTE_TTL_MS,
  PoolError,
  assertQuoteUsable,
  buildClassicPoolDepositXdr,
  buildClassicPoolWithdrawXdr,
  buildPoolShareTrustlineXdr,
  checkPoolRateLimit,
  decimalToStroops,
  detectSoroswapRouterDrift,
  getPoolVolumeExcludingWash,
  isPhase182Enabled,
  poolErrorResponse,
  quoteClassicPool,
  recordPoolActivity,
  recordPoolIntent,
  resetPoolRateLimitForTests,
  resolveSoroswapConfig,
  spendableAfterPoolSeed,
  stroopsToDecimal,
  type ClassicPoolSnapshot,
  type PoolAsset,
} from "@/lib/liquidity-pool"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const XLM: PoolAsset = { kind: "native" }
const LIQ: PoolAsset = {
  kind: "credit",
  code: "PHASERLIQ",
  issuer: "GD7VAD4VDVHASKZIJPRORMXLML4RSVLRANYNRCCBWLO5ACOSYQZBSUFI",
}
const WALLET = LIQ.issuer

function snapshot(now: number): ClassicPoolSnapshot {
  return {
    poolId: "a".repeat(64),
    feeBps: CLASSIC_POOL_FEE_BPS,
    reserves: [
      { asset: XLM, amountStroops: 1_000_000_000_000n },
      { asset: LIQ, amountStroops: 2_000_000_000_000n },
    ],
    totalShares: 1_000_000_000n,
    totalTrustlines: 2,
    ledger: 12345,
    fetchedAt: now,
    stale: false,
  }
}

describe("phase-182 liquidity pools", () => {
  let tmp: string
  const originalDataDir = process.env.PHASE_SERVER_DATA_DIR
  const originalFlag = process.env.FEATURE_PHASE_182

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "phase-lp-test-"))
    process.env.PHASE_SERVER_DATA_DIR = tmp
    process.env.FEATURE_PHASE_182 = "1"
    resetSecurityCounters()
    resetPoolRateLimitForTests()
  })

  afterEach(() => {
    process.env.PHASE_SERVER_DATA_DIR = originalDataDir
    process.env.FEATURE_PHASE_182 = originalFlag
    rmSync(tmp, { recursive: true, force: true })
  })

  it("is flag gated", () => {
    assert.equal(isPhase182Enabled(), true)
    delete process.env.FEATURE_PHASE_182
    assert.equal(isPhase182Enabled(), false)
  })

  it("converts decimals and stroops without precision loss", () => {
    assert.equal(decimalToStroops("12.3450000"), 123_450_000n)
    assert.equal(stroopsToDecimal(123_450_000n), "12.3450000")
    assert.throws(() => decimalToStroops("abc"), PoolError)
  })

  it("builds a deterministic quote hash with an explicit min-out", () => {
    const now = 1_700_000_000_000
    const snap = snapshot(now)
    const a = quoteClassicPool(snap, { assetIn: XLM, amountInStroops: 100_000_000n, now })
    const b = quoteClassicPool(snap, { assetIn: XLM, amountInStroops: 100_000_000n, now })
    assert.equal(a.quoteHash, b.quoteHash)
    assert.match(a.quoteHash, /^[0-9a-f]{64}$/)
    assert.ok(a.minOutStroops < a.amountOutStroops)
    assert.equal(a.expiresAt - now, LP_QUOTE_TTL_MS)
    const tighter = quoteClassicPool(snap, {
      assetIn: XLM,
      amountInStroops: 100_000_000n,
      slippageBps: 10,
      now,
    })
    assert.notEqual(tighter.quoteHash, a.quoteHash)
  })

  it("rejects stale and mismatched quotes as 409", () => {
    const now = 1_700_000_000_000
    const quote = quoteClassicPool(snapshot(now), { assetIn: XLM, amountInStroops: 100_000_000n, now })
    assert.doesNotThrow(() => assertQuoteUsable(quote, { now }))
    assert.throws(() => assertQuoteUsable(quote, { now: now + LP_QUOTE_TTL_MS + 1 }), /expired/)
    assert.throws(() => assertQuoteUsable(quote, { now, expectedHash: "deadbeef" }), /does not match/)
    assert.equal(poolErrorStatusFor(new PoolError("QUOTE_STALE", "stale")), 409)
    const res = poolErrorResponse(new PoolError("QUOTE_STALE", "stale"))
    assert.equal(res.status, 409)
  })

  it("fails closed on Soroswap router drift with no fallback router", () => {
    assert.equal(resolveSoroswapConfig({}).ok, false)
    const drifted = resolveSoroswapConfig({
      SOROSWAP_ROUTER_CONTRACT_ID: routerId,
      SOROSWAP_EXPECTED_ROUTER_ID: pinnedRouterId,
    })
    assert.equal(drifted.ok, false)
    if (!drifted.ok) assert.equal(drifted.code, "SOROSWAP_ROUTER_DRIFT")
    assert.ok(getSecurityCounter("lp_router_address_drift") >= 1)
    assert.equal(detectSoroswapRouterDrift(pinnedRouterId, routerId), true)
    assert.equal(detectSoroswapRouterDrift(null, routerId), false)
  })

  it("is idempotent for the same intent and 409 for a conflicting payload", async () => {
    const base = {
      wallet: WALLET,
      intentId: "intent-1",
      action: "deposit" as const,
      venue: "classic" as const,
      poolId: "a".repeat(64),
      quoteHash: "b".repeat(64),
      amountInStroops: "100000000",
      amountOutStroops: "200000000",
      sharesStroops: null,
      signedXdr: "unsigned-xdr-placeholder",
      now: 1_700_000_000_000,
    }
    const first = await recordPoolIntent(base)
    assert.equal(first.ok, true)
    const replay = await recordPoolIntent(base)
    assert.equal(replay.ok, true)
    if (replay.ok) {
      assert.equal(replay.replay, true)
      assert.equal(replay.record.quoteHash, base.quoteHash)
    }
    const conflict = await recordPoolIntent({ ...base, signedXdr: "different-xdr" })
    assert.equal(conflict.ok, false)
    if (!conflict.ok) assert.equal(conflict.code, "INTENT_CONFLICT")
  })

  it("builds unsigned deposit, withdraw and share-trustline XDR", () => {
    const snap = snapshot(1_700_000_000_000)
    const build = { walletAddress: WALLET, sequence: "123", snapshot: snap }
    assert.ok(StrKey.isValidEd25519PublicKey(WALLET))
    for (const xdr of [
      buildPoolShareTrustlineXdr(build),
      buildClassicPoolDepositXdr({ ...build, amountStroops: 100_000_000n }),
      buildClassicPoolWithdrawXdr({ ...build, sharesStroops: 100_000_000n }),
    ]) {
      assert.equal(typeof xdr, "string")
      assert.ok(TransactionBuilder.fromXDR(xdr, "Test SDF Network ; September 2015"))
    }
  })

  it("excludes pool seed capital from available balance", () => {
    assert.equal(
      spendableAfterPoolSeed({
        balanceStroops: 1_000n,
        reserveStroops: 100n,
        feeReserveStroops: 10n,
        poolSeedStroops: 400n,
        pendingHoldsStroops: 50n,
      }),
      440n,
    )
    assert.equal(
      spendableAfterPoolSeed({
        balanceStroops: 100n,
        reserveStroops: 100n,
        feeReserveStroops: 10n,
        poolSeedStroops: 400n,
        pendingHoldsStroops: 50n,
      }),
      0n,
    )
  })

  it("flags and excludes wash activity from volume", () => {
    const now = 1_700_000_000_000
    const poolId = "c".repeat(64)
    const honest = recordPoolActivity({
      poolId,
      wallet: WALLET,
      kind: "swap",
      valueXlmStroops: 500n,
      activityId: "swap:honest",
      now,
    })
    assert.equal(honest.washFlagged, false)
    const wash = recordPoolActivity({
      poolId,
      wallet: WALLET,
      counterparty: WALLET,
      kind: "swap",
      valueXlmStroops: 9_000n,
      activityId: "swap:self",
      now,
    })
    assert.equal(wash.washFlagged, true)
    assert.equal(wash.washReason, "self_swap")
    const volume = getPoolVolumeExcludingWash(poolId, { since: 0 })
    assert.equal(volume.swapCount, 1)
    assert.equal(volume.valueXlmStroops, "500")
    assert.equal(volume.excludedCount, 1)
  })

  it("rate limits repeated prepare calls per wallet", () => {
    for (let i = 0; i < 60; i++) assert.equal(checkPoolRateLimit(WALLET).ok, true)
    assert.equal(checkPoolRateLimit(WALLET).ok, false)
  })
})

function poolErrorStatusFor(error: PoolError): number {
  return poolErrorResponse(error).status
}
