import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  Asset,
  Keypair,
  LiquidityPoolAsset,
  Networks,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_MAX_PRICE_IMPACT_BPS,
  LP_QUOTE_TTL_MS,
  PoolError,
  assertQuoteUsable,
  buildClassicPoolDepositXdr,
  buildClassicPoolSwapXdr,
  buildClassicPoolWithdrawXdr,
  buildPoolShareTrustlineXdr,
  buildSoroswapSwapXdr,
  checkPoolRateLimit,
  classicPoolIdForAssets,
  decimalToStroops,
  detectSoroswapRouterDrift,
  getPoolVolumeExcludingWash,
  parseClassicPoolRecord,
  poolErrorStatus,
  poolTrustlineStatusFromAccount,
  quoteClassicPool,
  quoteSoroswap,
  recordPoolActivity,
  recordPoolIntent,
  resetPoolRateLimitForTests,
  resetPoolReserveCacheForTests,
  resolveSoroswapConfig,
  spendableAfterPoolSeed,
  stroopsToDecimal,
  type ClassicPoolSnapshot,
  type PoolAsset,
} from "@/lib/liquidity-pool"
import { resetDbForTests } from "@/lib/sqlite-db"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"
import { detectSelfProvisionedPools, detectSelfSwaps } from "@/lib/wash-trading"

const PHASELQ: PoolAsset = {
  kind: "credit",
  code: "PHASELQ",
  issuer: Keypair.random().publicKey(),
}
const OTHER: PoolAsset = {
  kind: "credit",
  code: "PHASELQ",
  issuer: Keypair.random().publicKey(),
}
const XLM: PoolAsset = { kind: "native" }

/** Build a snapshot through the same parser the route uses on Horizon JSON. */
function snapshot(overrides: {
  a?: string
  b?: string
  totalShares?: string
  feeBp?: number
  now?: number
  assets?: [PoolAsset, PoolAsset]
} = {}): ClassicPoolSnapshot {
  const [assetA, assetB] = overrides.assets ?? [PHASELQ, XLM]
  const id = classicPoolIdForAssets(assetA, assetB)
  return parseClassicPoolRecord(
    {
      id,
      fee_bp: overrides.feeBp ?? 30,
      total_shares: overrides.totalShares ?? "1000.0000000",
      total_trustlines: 2,
      last_modified_ledger: 12345,
      reserves: [
        {
          asset: assetA.kind === "native" ? "native" : `${assetA.code}:${assetA.issuer}`,
          amount: overrides.a ?? "1000.0000000",
        },
        {
          asset: assetB.kind === "native" ? "native" : `${assetB.code}:${assetB.issuer}`,
          amount: overrides.b ?? "500.0000000",
        },
      ],
    },
    { expectedAssets: [PHASELQ, XLM], now: overrides.now ?? 1_000 },
  )
}

describe("phase-182 classic pool quotes", () => {
  it("quotes execution below spot, applies the 30 bps fee and a min-out floor", () => {
    const quote = quoteClassicPool(snapshot(), {
      assetIn: PHASELQ,
      amountInStroops: decimalToStroops("10"),
      slippageBps: 50,
      now: 1_000,
    })
    expect(quote.spotPrice).toBeCloseTo(0.5, 6)
    expect(quote.executionPrice).toBeLessThan(quote.spotPrice)
    expect(quote.amountOutStroops).toBeLessThan(decimalToStroops("5"))
    expect(quote.minOutStroops).toBeLessThan(quote.amountOutStroops)
    expect(quote.priceImpactBps).toBeGreaterThan(0)
    expect(quote.quoteHash).toMatch(/^[0-9a-f]{64}$/)
    expect(quote.expiresAt).toBe(1_000 + LP_QUOTE_TTL_MS)
  })

  it("produces the same quote hash for identical reserves and a different one when size changes", () => {
    const a = quoteClassicPool(snapshot(), {
      assetIn: PHASELQ,
      amountInStroops: decimalToStroops("10"),
      now: 1_000,
    })
    const b = quoteClassicPool(snapshot(), {
      assetIn: PHASELQ,
      amountInStroops: decimalToStroops("10"),
      now: 1_000,
    })
    const c = quoteClassicPool(snapshot(), {
      assetIn: PHASELQ,
      amountInStroops: decimalToStroops("11"),
      now: 1_000,
    })
    expect(a.quoteHash).toBe(b.quoteHash)
    expect(a.quoteHash).not.toBe(c.quoteHash)
  })

  it("rejects an asset that is not part of the pool", () => {
    expect(() =>
      quoteClassicPool(snapshot(), {
        assetIn: OTHER,
        amountInStroops: decimalToStroops("1"),
      }),
    ).toThrowError(PoolError)
  })

  it("refuses quotes above the price-impact ceiling (thin pool)", () => {
    expect(() =>
      quoteClassicPool(snapshot({ a: "100.0000000", b: "50.0000000" }), {
        assetIn: PHASELQ,
        amountInStroops: decimalToStroops("30"),
        maxPriceImpactBps: DEFAULT_MAX_PRICE_IMPACT_BPS,
      }),
    ).toThrowError(/price/i)
  })

  it("classifies stale, expired and hash-mismatched quotes as 409", () => {
    const fresh = quoteClassicPool(snapshot(), {
      assetIn: PHASELQ,
      amountInStroops: decimalToStroops("1"),
      now: 1_000,
    })
    expect(() => assertQuoteUsable({ ...fresh, stale: true }, { now: 1_000 })).toThrowError(
      expect.objectContaining({ code: "QUOTE_STALE", status: 409 }),
    )
    expect(() => assertQuoteUsable(fresh, { now: fresh.expiresAt + 1 })).toThrowError(
      expect.objectContaining({ code: "QUOTE_STALE" }),
    )
    expect(() => assertQuoteUsable(fresh, { now: 1_000, expectedHash: "0".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "QUOTE_MISMATCH" }),
    )
  })

  it("maps every pool error code to a stable HTTP status", () => {
    expect(poolErrorStatus("TRUSTLINE_MISSING")).toBe(412)
    expect(poolErrorStatus("QUOTE_STALE")).toBe(409)
    expect(poolErrorStatus("RATE_LIMITED" as never)).toBeUndefined()
    expect(poolErrorStatus("PRICE_IMPACT_TOO_HIGH")).toBe(422)
    expect(poolErrorStatus("SOROSWAP_ROUTER_DRIFT")).toBe(503)
  })
})

describe("classic pool records and ids", () => {
  it("normalises reserve order and recomputes the pool id from the pair", () => {
    const [assetA, assetB] = [PHASELQ, XLM]
    const forward = classicPoolIdForAssets(assetA, assetB)
    const reverse = classicPoolIdForAssets(assetB, assetA)
    expect(forward).toBe(reverse)
    expect(forward).toMatch(/^[0-9a-f]{64}$/)
    const parsed = snapshot()
    expect(parsed.poolId).toBe(forward)
    expect(parsed.totalShares).toBe(decimalToStroops("1000"))
  })

  it("rejects an id that does not match the requested assets", () => {
    expect(() =>
      parseClassicPoolRecord(
        {
          id: classicPoolIdForAssets(PHASELQ, XLM),
          fee_bp: 30,
          total_shares: "1.0000000",
          reserves: [
            { asset: `PHASELQ:${PHASELQ.kind === "credit" ? PHASELQ.issuer : ""}`, amount: "1.0000000" },
            { asset: "native", amount: "1.0000000" },
          ],
        },
        { expectedAssets: [OTHER, XLM] },
      ),
    ).toThrowError(expect.objectContaining({ code: "POOL_ASSET_MISMATCH" }))
  })

  it("rejects malformed Horizon reserve amounts instead of coercing them", () => {
    expect(() =>
      parseClassicPoolRecord({
        id: classicPoolIdForAssets(PHASELQ, XLM),
        reserves: [
          { asset: `PHASELQ:${PHASELQ.kind === "credit" ? PHASELQ.issuer : ""}`, amount: "NaN" },
          { asset: "native", amount: "1.0000000" },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }))
  })
})

describe("classic pool operation builders", () => {
  const wallet = Keypair.random().publicKey()

  it("builds a deposit with ceilings derived from the quote and bounds around the ratio", () => {
    const xdr = buildClassicPoolDepositXdr({
      walletAddress: wallet,
      sequence: "42",
      snapshot: snapshot(),
      asset: PHASELQ,
      amountStroops: decimalToStroops("10"),
      slippageBps: 50,
    })
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
    const op = tx.operations[0] as unknown as {
      type: string
      liquidityPoolId: string
      maxAmountA: string
      maxAmountB: string
      minPrice: string
      maxPrice: string
    }
    expect(op.type).toBe("liquidityPoolDeposit")
    expect(op.liquidityPoolId).toBe(snapshot().poolId)
    // Canonical order puts native XLM first, so the PHASELQ amount lands in B.
    expect(Number(op.maxAmountB)).toBeGreaterThanOrEqual(10)
    expect(Number(op.maxAmountA)).toBeGreaterThanOrEqual(5)
    expect(Number(op.maxPrice)).toBeGreaterThan(Number(op.minPrice))
    expect((tx as unknown as { source: string }).source).toBe(wallet)
  })

  it("builds a withdraw with proportional minimums", () => {
    const snap = snapshot()
    const xdr = buildClassicPoolWithdrawXdr({
      walletAddress: wallet,
      sequence: "42",
      snapshot: snap,
      sharesStroops: decimalToStroops("100"),
      slippageBps: 100,
    })
    const op = TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations[0] as unknown as {
      type: string
      amount: string
      minAmountA: string
      minAmountB: string
    }
    expect(op.type).toBe("liquidityPoolWithdraw")
    expect(op.amount).toBe("100.0000000")
    // 10% of the pool: canonical A = XLM (~50), B = PHASELQ (~100), minus 100 bps.
    expect(Number(op.minAmountA)).toBeCloseTo(49.5, 5)
    expect(Number(op.minAmountB)).toBeCloseTo(99, 5)
  })

  it("builds a pool-share changeTrust, not an asset trustline", () => {
    const xdr = buildPoolShareTrustlineXdr({
      walletAddress: wallet,
      sequence: "42",
      snapshot: snapshot(),
    })
    const op = TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations[0] as unknown as {
      type: string
      line: unknown
    }
    expect(op.type).toBe("changeTrust")
    expect(op.line).toBeInstanceOf(LiquidityPoolAsset)
  })

  it("builds a strict-send path payment with destMin equal to the quote floor", () => {
    const snap = snapshot()
    const quote = quoteClassicPool(snap, {
      assetIn: PHASELQ,
      amountInStroops: decimalToStroops("10"),
      slippageBps: 50,
    })
    const xdr = buildClassicPoolSwapXdr({
      walletAddress: wallet,
      sequence: "42",
      snapshot: snap,
      quote,
    })
    const op = TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations[0] as unknown as {
      type: string
      sendAmount: string
      destMin: string
      destination: string
    }
    expect(op.type).toBe("pathPaymentStrictSend")
    expect(op.sendAmount).toBe("10.0000000")
    expect(op.destMin).toBe(stroopsToDecimal(quote.minOutStroops))
    expect(op.destination).toBe(wallet)
  })
})

describe("pool trustline preflight", () => {
  const base = () => snapshot()
  const issuer = PHASELQ.kind === "credit" ? PHASELQ.issuer : ""

  it("reports the pool-share line as the missing one when PHASELQ exists", () => {
    const status = poolTrustlineStatusFromAccount(
      { balances: [{ asset_type: "credit_alphanum12", asset_code: "PHASELQ", asset_issuer: issuer }] },
      base(),
    )
    expect(status.missing).toEqual(["pool_shares"])
    expect(status.hasTrustlines).toBe(false)
  })

  it("accepts a wallet with the asset line and the pool-share line", () => {
    const status = poolTrustlineStatusFromAccount(
      {
        balances: [
          { asset_type: "credit_alphanum12", asset_code: "PHASELQ", asset_issuer: issuer },
          { asset_type: "liquidity_pool_shares", liquidity_pool_id: base().poolId, balance: "25.0000000" },
        ],
      },
      base(),
    )
    expect(status.missing).toEqual([])
    expect(status.hasTrustlines).toBe(true)
    expect(status.shareBalanceStroops).toBe(decimalToStroops("25"))
  })

  it("reports all lines for an unfunded account", () => {
    const status = poolTrustlineStatusFromAccount({ balances: [] }, base())
    // PHASELQ is canonical B (native XLM is A), so only the credit line plus shares are missing.
    expect(status.missing).toEqual(["asset_b", "pool_shares"])
  })
})

describe("Soroswap router adapter", () => {
  const router = StrKey.encodeContract(Buffer.alloc(32, 1))
  const factory = StrKey.encodeContract(Buffer.alloc(32, 2))
  const pathIds = [
    new Asset("PHASELQ", PHASELQ.kind === "credit" ? PHASELQ.issuer : "").contractId(Networks.TESTNET),
    Asset.native().contractId(Networks.TESTNET),
  ]

  it("has no hardcoded router fallback", () => {
    const resolved = resolveSoroswapConfig({})
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.code).toBe("SOROSWAP_NOT_CONFIGURED")
  })

  it("rejects a malformed contract id", () => {
    const resolved = resolveSoroswapConfig({ SOROSWAP_ROUTER_CONTRACT_ID: "GABC" })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.code).toBe("SOROSWAP_ROUTER_INVALID")
  })

  it("detects router drift and increments the closed counter", () => {
    resetSecurityCounters()
    const pinned = StrKey.encodeContract(Buffer.alloc(32, 3))
    const resolved = resolveSoroswapConfig({
      SOROSWAP_ROUTER_CONTRACT_ID: router,
      SOROSWAP_EXPECTED_ROUTER_ID: pinned,
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.code).toBe("SOROSWAP_ROUTER_DRIFT")
    expect(getSecurityCounter("lp_router_address_drift")).toBe(1)
    expect(detectSoroswapRouterDrift(router, router)).toBe(false)
  })

  it("accepts a valid router and factory", () => {
    const resolved = resolveSoroswapConfig({
      SOROSWAP_ROUTER_CONTRACT_ID: router,
      SOROSWAP_FACTORY_CONTRACT_ID: factory,
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.config.routerContractId).toBe(router)
      expect(resolved.config.factoryContractId).toBe(factory)
    }
  })

  it("normalises an aggregator quote and enforces slippage", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ amountOut: "40000000", priceImpact: 0.012, path: pathIds }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch
    process.env.SOROSWAP_ROUTER_CONTRACT_ID = router
    process.env.SOROSWAP_API_URL = "https://soroswap.example/api"
    try {
      const quote = await quoteSoroswap({
        assetIn: PHASELQ,
        assetOut: XLM,
        amountInStroops: 100_000_000n,
        slippageBps: 100,
        fetchImpl,
      })
      expect(quote.amountOutStroops).toBe(40_000_000n)
      expect(quote.minOutStroops).toBe(39_600_000n)
      expect(quote.priceImpactBps).toBe(120)
      expect(quote.routerContractId).toBe(router)
    } finally {
      delete process.env.SOROSWAP_ROUTER_CONTRACT_ID
      delete process.env.SOROSWAP_API_URL
    }
  })

  it("builds a router invocation the wallet signs itself", async () => {
    process.env.SOROSWAP_ROUTER_CONTRACT_ID = router
    process.env.SOROSWAP_API_URL = "https://soroswap.example/api"
    try {
      const quote = await quoteSoroswap({
        assetIn: PHASELQ,
        assetOut: XLM,
        amountInStroops: 100n,
        fetchImpl: vi.fn(async () =>
          new Response(JSON.stringify({ amountOut: "90", path: pathIds }), { status: 200 }),
        ) as unknown as typeof fetch,
      })
      const xdr = buildSoroswapSwapXdr({
        walletAddress: Keypair.random().publicKey(),
        sequence: "7",
        quote,
        deadline: Math.floor(Date.now() / 1000) + 60,
      })
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
      expect(tx.operations[0]!.type).toBe("invokeHostFunction")
    } finally {
      delete process.env.SOROSWAP_ROUTER_CONTRACT_ID
      delete process.env.SOROSWAP_API_URL
    }
  })
})

describe("intent idempotency and rate limits", () => {
  let dir: string
  const savedDir = process.env.PHASE_SERVER_DATA_DIR

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "phase-lp-intent-"))
    process.env.PHASE_SERVER_DATA_DIR = dir
  })
  afterEach(() => {
    if (savedDir === undefined) delete process.env.PHASE_SERVER_DATA_DIR
    else process.env.PHASE_SERVER_DATA_DIR = savedDir
    rmSync(dir, { recursive: true, force: true })
  })

  it("replays an identical intent and conflicts on a different payload", async () => {
    const wallet = Keypair.random().publicKey()
    const base = {
      intentId: "intent-1",
      wallet,
      action: "deposit" as const,
      venue: "classic" as const,
      poolId: snapshot().poolId,
      quoteHash: null,
      amountInStroops: "10000000",
      amountOutStroops: null,
      sharesStroops: null,
      signedXdr: "xdr-a",
      now: 1_000,
    }
    const first = await recordPoolIntent(base)
    const replay = await recordPoolIntent(base)
    expect(first.ok).toBe(true)
    expect(replay.ok).toBe(true)
    if (first.ok && replay.ok) {
      expect(first.replay).toBe(false)
      expect(replay.replay).toBe(true)
      expect(replay.record.xdrHash).toBe(first.record.xdrHash)
    }
    const conflict = await recordPoolIntent({ ...base, signedXdr: "xdr-b", now: 1_001 })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.code).toBe("INTENT_CONFLICT")
  })

  it("rate-limits per wallet and reports Retry-After", () => {
    resetPoolRateLimitForTests()
    const wallet = Keypair.random().publicKey()
    expect(checkPoolRateLimit(wallet, { limit: 2, now: 0 }).ok).toBe(true)
    expect(checkPoolRateLimit(wallet, { limit: 2, now: 1 }).ok).toBe(true)
    const blocked = checkPoolRateLimit(wallet, { limit: 2, now: 2 })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    // A different wallet is unaffected.
    expect(checkPoolRateLimit(Keypair.random().publicKey(), { limit: 2, now: 2 }).ok).toBe(true)
  })
})

describe("pool wash screening and volume", () => {
  let dir: string
  const savedDir = process.env.PHASE_SERVER_DATA_DIR

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "phase-lp-db-"))
    process.env.PHASE_SERVER_DATA_DIR = dir
    resetDbForTests()
    resetSecurityCounters()
    resetPoolReserveCacheForTests()
  })
  afterEach(() => {
    resetDbForTests()
    if (savedDir === undefined) delete process.env.PHASE_SERVER_DATA_DIR
    else process.env.PHASE_SERVER_DATA_DIR = savedDir
    rmSync(dir, { recursive: true, force: true })
  })

  it("detects self-provisioned pools only when one wallet is concentrated and sole trader", () => {
    const alpha = Keypair.random().publicKey()
    const beta = Keypair.random().publicKey()
    const solo = detectSelfProvisionedPools([
      { poolId: "a".repeat(64), wallet: alpha, shareBps: 9_500, swapWallets: [alpha] },
    ])
    expect(solo.flaggedPoolIds).toEqual(["a".repeat(64)])

    const organic = detectSelfProvisionedPools([
      { poolId: "b".repeat(64), wallet: alpha, shareBps: 9_500, swapWallets: [alpha, beta] },
    ])
    expect(organic.flaggedPoolIds).toEqual([])
  })

  it("flags self swaps and excludes them from pool volume", () => {
    const wallet = Keypair.random().publicKey()
    const other = Keypair.random().publicKey()
    const swap = detectSelfSwaps([
      { poolId: "p", wallet, counterparty: wallet },
      { poolId: "p", wallet, counterparty: other },
    ])
    expect(swap.flaggedIndexes).toEqual([0])

    const poolId = "p".repeat(64)
    const self = recordPoolActivity({
      activityId: "swap:self",
      poolId,
      wallet,
      counterparty: wallet,
      kind: "swap",
      valueXlmStroops: 1_000n,
      now: 10,
    })
    const clean = recordPoolActivity({
      activityId: "swap:clean",
      poolId,
      wallet,
      counterparty: other,
      kind: "swap",
      valueXlmStroops: 2_000n,
      now: 11,
    })
    // Duplicate id is ignored, so a retried tx cannot double-count.
    recordPoolActivity({
      activityId: "swap:clean",
      poolId,
      wallet,
      counterparty: other,
      kind: "swap",
      valueXlmStroops: 2_000n,
      now: 12,
    })
    expect(self.washFlagged).toBe(true)
    expect(clean.washFlagged).toBe(false)
    const volume = getPoolVolumeExcludingWash(poolId, { since: 0 })
    expect(volume.valueXlmStroops).toBe("2000")
    expect(volume.swapCount).toBe(1)
    expect(volume.excludedCount).toBe(1)
  })

  it("keeps pool seed capital out of spendable balance", () => {
    expect(
      spendableAfterPoolSeed({
        balanceStroops: 10_000n,
        reserveStroops: 1_000n,
        feeReserveStroops: 500n,
        poolSeedStroops: 6_000n,
        pendingHoldsStroops: 1_000n,
      }),
    ).toBe(1_500n)
    expect(
      spendableAfterPoolSeed({
        balanceStroops: 1_000n,
        reserveStroops: 900n,
        feeReserveStroops: 200n,
        poolSeedStroops: 500n,
        pendingHoldsStroops: 0n,
      }),
    ).toBe(0n)
  })
})

describe("asset helpers", () => {
  it("builds SAC contract ids only for well-formed assets", () => {
    expect(() => new Asset("PHASELQ", "GABC")).toThrow()
    expect(stroopsToDecimal(0n)).toBe("0.0000000")
    expect(stroopsToDecimal(12_345_678n)).toBe("1.2345678")
  })
})
