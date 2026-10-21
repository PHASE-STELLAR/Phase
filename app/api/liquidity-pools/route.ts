import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { HORIZON_URL } from "@/lib/phase-protocol"
import { resolvePhaserLiqClassicAsset } from "@/lib/stellar"
import {
  DEFAULT_MAX_PRICE_IMPACT_BPS,
  DEFAULT_POOL_SLIPPAGE_BPS,
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
  getClassicPoolSnapshot,
  isPhase182Enabled,
  phase182RollbackNote,
  poolErrorResponse,
  quoteClassicPool,
  quoteSoroswap,
  readPoolAccount,
  recordPoolActivity,
  recordPoolIntent,
  resolveSoroswapConfig,
  stroopsToDecimal,
  type ClassicPoolSnapshot,
  type PoolAsset,
  type PoolQuote,
} from "@/lib/liquidity-pool"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Spike 574 (phase-182) — pool read + prepare surface.
 *
 * This route never signs and never submits for the user. It quotes, gates on
 * trustlines, and returns an unsigned XDR the wallet signs client-side. The only
 * server write is `action: "record"`, which verifies the submitted transaction
 * on Horizon before it can influence volume.
 */

function phaselqAsset(): PoolAsset {
  const resolved = resolvePhaserLiqClassicAsset()
  return { kind: "credit", code: resolved.code, issuer: resolved.issuer }
}

const XLM: PoolAsset = { kind: "native" }

function sideAssets(side: string): { assetIn: PoolAsset; assetOut: PoolAsset } {
  return side === "sell" ? { assetIn: XLM, assetOut: phaselqAsset() } : { assetIn: phaselqAsset(), assetOut: XLM }
}

function quoteJson(quote: PoolQuote) {
  return {
    venue: quote.venue,
    pool_id: quote.poolId,
    asset_in: quote.assetIn.kind === "native" ? "XLM" : quote.assetIn.code,
    asset_out: quote.assetOut.kind === "native" ? "XLM" : quote.assetOut.code,
    amount_in: stroopsToDecimal(quote.amountInStroops),
    amount_out: stroopsToDecimal(quote.amountOutStroops),
    min_out: stroopsToDecimal(quote.minOutStroops),
    fee_bps: quote.feeBps,
    slippage_bps: quote.slippageBps,
    spot_price: quote.spotPrice,
    execution_price: quote.executionPrice,
    price_impact_bps: quote.priceImpactBps,
    quote_hash: quote.quoteHash,
    ledger: quote.ledger,
    expires_at: quote.expiresAt,
    stale: quote.stale,
  }
}

function errorJson(error: unknown) {
  const mapped = poolErrorResponse(error)
  return NextResponse.json(mapped.body, { status: mapped.status, headers: mapped.headers })
}

async function loadPool(): Promise<ClassicPoolSnapshot> {
  const poolId = classicPoolIdForAssets(phaselqAsset(), XLM)
  return getClassicPoolSnapshot(poolId)
}

export async function GET(request: NextRequest) {
  if (!isPhase182Enabled()) {
    return NextResponse.json(
      { enabled: false, error: "Liquidity pools are disabled (phase-182).", code: "FLAG_DISABLED" },
      { status: 404 },
    )
  }
  const params = request.nextUrl.searchParams
  const side = params.get("side") === "sell" ? "sell" : "buy"
  const slippageBps = Number(params.get("slippage_bps") ?? DEFAULT_POOL_SLIPPAGE_BPS)
  const amountText = params.get("amount")?.trim() || "1"
  const wallet = params.get("wallet_address")?.trim() || ""

  try {
    const { assetIn } = sideAssets(side)
    const amountInStroops = decimalToStroops(amountText)
    const snapshot = await loadPool()
    const quote = quoteClassicPool(snapshot, {
      assetIn,
      amountInStroops,
      slippageBps: Number.isInteger(slippageBps) ? slippageBps : DEFAULT_POOL_SLIPPAGE_BPS,
      maxPriceImpactBps: DEFAULT_MAX_PRICE_IMPACT_BPS,
    })

    const trustlines =
      wallet && StrKey.isValidEd25519PublicKey(wallet)
        ? await readPoolAccount(wallet, snapshot).then(
            (account) => account.trustlines,
            () => null,
          )
        : null

    return NextResponse.json(
      {
        enabled: true,
        venue: "classic",
        pair: {
          base: phaselqAsset().kind === "credit" ? (phaselqAsset() as { code: string }).code : "PHASELQ",
          counter: "XLM",
          pool_id: snapshot.poolId,
        },
        reserves: snapshot.reserves.map((r) => ({
          asset: r.asset.kind === "native" ? "XLM" : r.asset.code,
          amount: stroopsToDecimal(r.amountStroops),
        })),
        total_shares: stroopsToDecimal(snapshot.totalShares),
        pool_ledger: snapshot.ledger,
        quote: quoteJson(quote),
        trustlines,
        soroswap: resolveSoroswapConfig().ok ? { configured: true } : { configured: false },
        rollback: phase182RollbackNote(),
      },
      {
        headers: {
          "Cache-Control": "no-store",
          ETag: `"${quote.quoteHash}"`,
        },
      },
    )
  } catch (error) {
    return errorJson(error)
  }
}

type PrepareBody = {
  action?: unknown
  wallet_address?: unknown
  intent_id?: unknown
  amount?: unknown
  amount_a?: unknown
  shares?: unknown
  slippage_bps?: unknown
  quote_hash?: unknown
  side?: unknown
  venue?: unknown
  tx_hash?: unknown
  kind?: unknown
  counterparty?: unknown
  value_xlm?: unknown
}

function badRequest(message: string) {
  return NextResponse.json({ error: message, code: "INVALID_INPUT" }, { status: 400 })
}

export async function POST(request: NextRequest) {
  if (!isPhase182Enabled()) {
    return NextResponse.json({ error: "Liquidity pools are disabled (phase-182).", code: "FLAG_DISABLED" }, { status: 404 })
  }

  let body: PrepareBody
  try {
    body = (await request.json()) as PrepareBody
  } catch {
    return badRequest("Invalid JSON body.")
  }

  const action = typeof body.action === "string" ? body.action.trim() : ""
  if (!["deposit", "withdraw", "swap", "trustline", "record"].includes(action)) {
    return badRequest("action must be deposit, withdraw, swap, trustline or record.")
  }

  const wallet = typeof body.wallet_address === "string" ? body.wallet_address.trim() : ""
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    return badRequest("wallet_address must be a valid Stellar G address.")
  }

  const limit = checkPoolRateLimit(wallet)
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many pool requests; retry shortly.", code: "RATE_LIMITED", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    )
  }

  if (action === "record") {
    return recordSubmittedSwap(body, wallet)
  }

  const intentId = typeof body.intent_id === "string" ? body.intent_id.trim() : ""
  if (!intentId || intentId.length > 128) {
    return badRequest("intent_id is required (max 128 chars) and must be stable across retries.")
  }
  const slippageRaw = Number(body.slippage_bps ?? DEFAULT_POOL_SLIPPAGE_BPS)
  const slippageBps = Number.isInteger(slippageRaw) && slippageRaw >= 0 && slippageRaw <= 5_000
    ? slippageRaw
    : DEFAULT_POOL_SLIPPAGE_BPS
  const ifMatch = request.headers.get("if-match")?.replace(/^"|"$/g, "") ?? null

  try {
    // A prepare always re-reads reserves; a cached snapshot is only for display.
    const snapshot = await loadPool()
    const account = await readPoolAccount(wallet, snapshot)

    if (action === "trustline") {
      const xdr = buildPoolShareTrustlineXdr({
        walletAddress: wallet,
        sequence: account.sequence,
        snapshot,
      })
      const intent = await recordPoolIntent({
        intentId,
        wallet,
        action: "deposit",
        venue: "classic",
        poolId: snapshot.poolId,
        quoteHash: ifMatch,
        amountInStroops: null,
        amountOutStroops: null,
        sharesStroops: null,
        signedXdr: xdr,
      })
      if (!intent.ok) {
        return NextResponse.json(
          { error: "This intent_id was already used with a different payload.", code: "INTENT_CONFLICT" },
          { status: 409 },
        )
      }
      return NextResponse.json({
        ok: true,
        action,
        xdr,
        pool_id: snapshot.poolId,
        required_trustlines: account.trustlines.missing,
        asset: { kind: "pool_shares", pool_id: snapshot.poolId },
        intent: { id: intentId, replayed: intent.replay },
      })
    }

    if (action === "deposit") {
      if (!account.trustlines.hasTrustlines) {
        return NextResponse.json(
          {
            error: "Pool trustlines are required before depositing.",
            code: "TRUSTLINE_MISSING",
            required_trustlines: account.trustlines.missing,
            pool_id: snapshot.poolId,
          },
          { status: 412, headers: { "Retry-After": "2" } },
        )
      }
      const amountA = decimalToStroops(body.amount_a ?? body.amount)
      const xdr = buildClassicPoolDepositXdr({
        walletAddress: wallet,
        sequence: account.sequence,
        snapshot,
        // The UI deposits PHASELQ; the operation slot is canonical (XLM first).
        asset: phaselqAsset(),
        amountStroops: amountA,
        slippageBps,
      })
      const intent = await recordPoolIntent({
        intentId,
        wallet,
        action: "deposit",
        venue: "classic",
        poolId: snapshot.poolId,
        quoteHash: ifMatch,
        amountInStroops: amountA.toString(),
        amountOutStroops: null,
        sharesStroops: null,
        signedXdr: xdr,
      })
      if (!intent.ok) {
        return NextResponse.json(
          { error: "This intent_id was already used with a different payload.", code: "INTENT_CONFLICT" },
          { status: 409 },
        )
      }
      return NextResponse.json({
        ok: true,
        action,
        xdr,
        pool_id: snapshot.poolId,
        amount_a: stroopsToDecimal(amountA),
        slippage_bps: slippageBps,
        intent: { id: intentId, replayed: intent.replay },
        expires_at: intent.record.expiresAt,
      })
    }

    if (action === "withdraw") {
      if (account.trustlines.missing.includes("pool_shares")) {
        return NextResponse.json(
          {
            error: "The pool-share trustline is required before withdrawing.",
            code: "TRUSTLINE_MISSING",
            required_trustlines: account.trustlines.missing,
            pool_id: snapshot.poolId,
          },
          { status: 412, headers: { "Retry-After": "2" } },
        )
      }
      const shares = decimalToStroops(body.shares)
      if (account.trustlines.shareBalanceStroops !== null && shares > account.trustlines.shareBalanceStroops) {
        return badRequest("shares exceeds the wallet's pool-share balance.")
      }
      const xdr = buildClassicPoolWithdrawXdr({
        walletAddress: wallet,
        sequence: account.sequence,
        snapshot,
        sharesStroops: shares,
        slippageBps,
      })
      const intent = await recordPoolIntent({
        intentId,
        wallet,
        action: "withdraw",
        venue: "classic",
        poolId: snapshot.poolId,
        quoteHash: ifMatch,
        amountInStroops: null,
        amountOutStroops: null,
        sharesStroops: shares.toString(),
        signedXdr: xdr,
      })
      if (!intent.ok) {
        return NextResponse.json(
          { error: "This intent_id was already used with a different payload.", code: "INTENT_CONFLICT" },
          { status: 409 },
        )
      }
      return NextResponse.json({
        ok: true,
        action,
        xdr,
        pool_id: snapshot.poolId,
        shares: stroopsToDecimal(shares),
        min_amount_a: stroopsToDecimal(
          (snapshot.reserves[0].amountStroops * shares * BigInt(10_000 - slippageBps)) /
            (snapshot.totalShares * 10_000n),
        ),
        min_amount_b: stroopsToDecimal(
          (snapshot.reserves[1].amountStroops * shares * BigInt(10_000 - slippageBps)) /
            (snapshot.totalShares * 10_000n),
        ),
        intent: { id: intentId, replayed: intent.replay },
      })
    }

    // swap
    const venue = body.venue === "soroswap" ? "soroswap" : "classic"
    const side = body.side === "sell" ? "sell" : "buy"
    const { assetIn, assetOut } = sideAssets(side)
    if (venue === "soroswap") {
      const soroswap = await quoteSoroswap({
        assetIn,
        assetOut,
        amountInStroops: decimalToStroops(body.amount),
        slippageBps,
      })
      const xdr = buildSoroswapSwapXdr({
        walletAddress: wallet,
        sequence: account.sequence,
        quote: soroswap,
        deadline: Math.floor(Date.now() / 1000) + 60,
      })
      const intent = await recordPoolIntent({
        intentId,
        wallet,
        action: "swap",
        venue: "soroswap",
        poolId: null,
        quoteHash: null,
        amountInStroops: soroswap.amountInStroops.toString(),
        amountOutStroops: soroswap.amountOutStroops.toString(),
        sharesStroops: null,
        signedXdr: xdr,
      })
      if (!intent.ok) {
        return NextResponse.json({ error: "Intent conflict.", code: "INTENT_CONFLICT" }, { status: 409 })
      }
      return NextResponse.json({
        ok: true,
        action,
        venue,
        xdr,
        router_contract_id: soroswap.routerContractId,
        amount_in: stroopsToDecimal(soroswap.amountInStroops),
        min_out: stroopsToDecimal(soroswap.minOutStroops),
        intent: { id: intentId, replayed: intent.replay },
      })
    }

    const quote = quoteClassicPool(snapshot, {
      assetIn,
      amountInStroops: decimalToStroops(body.amount),
      slippageBps,
    })
    // If-Match / quote_hash binds the signed min-out to the quote the user saw.
    assertQuoteUsable(quote, { expectedHash: ifMatch ?? undefined })
    if (typeof body.quote_hash === "string" && body.quote_hash.trim() && body.quote_hash.trim() !== quote.quoteHash) {
      throw new PoolError("QUOTE_MISMATCH", "quote_hash does not match current reserves.", {
        retryAfterSeconds: 2,
      })
    }
    const xdr = buildClassicPoolSwapXdr({
      walletAddress: wallet,
      sequence: account.sequence,
      snapshot,
      quote,
    })
    const intent = await recordPoolIntent({
      intentId,
      wallet,
      action: "swap",
      venue: "classic",
      poolId: snapshot.poolId,
      quoteHash: quote.quoteHash,
      amountInStroops: quote.amountInStroops.toString(),
      amountOutStroops: quote.amountOutStroops.toString(),
      sharesStroops: null,
      signedXdr: xdr,
    })
    if (!intent.ok) {
      return NextResponse.json(
        { error: "This intent_id was already used with a different payload.", code: "INTENT_CONFLICT" },
        { status: 409 },
      )
    }
    return NextResponse.json(
      {
        ok: true,
        action,
        venue: "classic",
        xdr,
        pool_id: snapshot.poolId,
        quote: quoteJson(quote),
        intent: { id: intentId, replayed: intent.replay },
        expires_at: quote.expiresAt,
      },
      { headers: { ETag: `"${quote.quoteHash}"` } },
    )
  } catch (error) {
    return errorJson(error)
  }
}

/**
 * Verify a submitted transaction before it can influence volume. This is the
 * only write, and it is idempotent: the activity id is derived from the tx hash,
 * so a retry cannot double-count.
 */
async function recordSubmittedSwap(body: PrepareBody, wallet: string) {
  const txHash = typeof body.tx_hash === "string" ? body.tx_hash.trim().toLowerCase() : ""
  if (!/^[0-9a-f]{64}$/.test(txHash)) return badRequest("tx_hash must be a 64-character hex transaction hash.")
  const valueXlm = body.value_xlm ?? body.amount
  try {
    const res = await fetch(`${HORIZON_URL}/transactions/${txHash}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
    if (res.status === 404) {
      return NextResponse.json({ error: "Transaction not found on Horizon.", code: "POOL_NOT_FOUND" }, { status: 404 })
    }
    if (!res.ok) {
      return NextResponse.json({ error: "Horizon transaction read failed.", code: "RESERVE_UNAVAILABLE" }, { status: 503 })
    }
    const tx = (await res.json()) as { successful?: boolean; source_account?: string; ledger?: number }
    if (tx.successful !== true) {
      return NextResponse.json({ error: "Transaction did not succeed on chain.", code: "INVALID_INPUT" }, { status: 400 })
    }
    if ((tx.source_account ?? "").toUpperCase() !== wallet.toUpperCase()) {
      return NextResponse.json({ error: "Transaction source does not match the wallet.", code: "INVALID_INPUT" }, { status: 400 })
    }
    const activity = recordPoolActivity({
      activityId: `swap:${txHash}`,
      poolId: classicPoolIdForAssets(phaselqAsset(), XLM),
      wallet,
      counterparty: typeof body.counterparty === "string" ? body.counterparty : null,
      kind: body.kind === "deposit" || body.kind === "withdraw" ? body.kind : "swap",
      valueXlmStroops: decimalToStroops(valueXlm ?? "0"),
      now: Date.now(),
    })
    return NextResponse.json({
      ok: true,
      recorded: activity.id,
      tx_hash: txHash,
      ledger: tx.ledger ?? null,
      wash_flagged: activity.washFlagged,
      wash_reason: activity.washReason,
    })
  } catch (error) {
    return errorJson(error)
  }
}
