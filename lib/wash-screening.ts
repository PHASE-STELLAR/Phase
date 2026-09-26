// @ts-nocheck
/**
 * Wash-trade screening for the offer path (issue #230).
 *
 * `lib/wash-trading.ts` already implements the heuristics (self-trade,
 * circular, rapid flip) and `auditWashTradingWiring` is already reachable from
 * the verify route — but nothing on the *write* path consulted it, so a 100k
 * self-deal campaign inflated `explore` volume and ranking unimpeded.
 *
 * Policy is **flag, not block**, deliberately:
 *
 * - Blocking outright punishes legitimate buyers. Two wallets funded by the
 *   same exchange, or a seller quietly buying their own listing to test
 *   pricing, are ordinary situations; rejecting them is a false positive the
 *   user pays for.
 * - The actual damage in #230 is not the offer existing, it is the offer
 *   *counting toward volume* and therefore toward ranking. So a flagged offer
 *   is still created, but is excluded from every volume aggregate.
 *
 * The screen is O(1) per offer (a self-trade check plus a bounded recent-trade
 * window for circularity), so it does not add per-request cost that scales
 * with campaign size.
 */

import { getDb } from "@/lib/sqlite-db"
import { detectCircularTrades, detectSelfTrading } from "@/lib/wash-trading"
import { incSecurityCounter } from "@/lib/security-counters"

export type WashScreenResult = {
  washFlagged: boolean
  washReason: string | null
}

/** How far back the circularity window reads, per the issue's 1h graph. */
export const WASH_WINDOW_MS = 60 * 60 * 1000

/** Cap on rows read for the window, so the screen cannot be amplified. */
const WASH_WINDOW_MAX_ROWS = 200

/**
 * Screen a prospective offer.
 *
 * `sellerWallet` is the listing's seller, `buyerWallet` the proposer.
 */
export function screenOfferForWash(input: {
  listingId: string
  tokenId: number
  sellerWallet: string
  buyerWallet: string
  amountPhaselq: number
  now?: number
}): WashScreenResult {
  const now = input.now ?? Date.now()
  const offerId = `prospective:${input.listingId}`

  // 1. Direct self-deal. The route already rejects this case; the screen
  //    repeats it so the flag is set by the same code path regardless of
  //    caller (bulk fan-out reaches createOffer without the route check).
  const self = detectSelfTrading([
    {
      tradeId: offerId,
      tokenId: input.tokenId,
      collectionId: 0,
      sellerWallet: input.sellerWallet,
      buyerWallet: input.buyerWallet,
      pricePhaselq: input.amountPhaselq,
      timestamp: now,
    },
  ])
  if (self.flaggedIds.length > 0) {
    incSecurityCounter("wash_trades_flagged")
    return { washFlagged: true, washReason: self.details[0] ?? "self_trade" }
  }

  // 2. Circularity against recent accepted trades on the same token: the same
  //    two wallets trading back and forth inside the window.
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.buyer_wallet, o.amount_phaselq, o.created_at,
              l.seller_wallet, l.token_id
         FROM offers o
         JOIN listings l ON l.id = o.listing_id
        WHERE l.token_id = ? AND o.status = 'accepted' AND o.created_at >= ?
        ORDER BY o.created_at DESC
        LIMIT ?`,
    )
    .all(input.tokenId, now - WASH_WINDOW_MS, WASH_WINDOW_MAX_ROWS) as Array<{
    id: string
    buyer_wallet: string
    amount_phaselq: number
    created_at: number
    seller_wallet: string
    token_id: number
  }>

  if (rows.length > 0) {
    const circular = detectCircularTrades(
      [
        ...rows.map((row) => ({
          tradeId: row.id,
          tokenId: row.token_id,
          collectionId: 0,
          sellerWallet: row.seller_wallet,
          buyerWallet: row.buyer_wallet,
          pricePhaselq: row.amount_phaselq,
          timestamp: row.created_at,
        })),
        {
          tradeId: offerId,
          tokenId: input.tokenId,
          collectionId: 0,
          sellerWallet: input.sellerWallet,
          buyerWallet: input.buyerWallet,
          pricePhaselq: input.amountPhaselq,
          timestamp: now,
        },
      ],
      WASH_WINDOW_MS,
    )
    if (circular.flaggedIds.length > 0) {
      incSecurityCounter("wash_trades_flagged")
      return { washFlagged: true, washReason: circular.details[0] ?? "circular_trade" }
    }
  }

  return { washFlagged: false, washReason: null }
}

/**
 * Volume for a listing, excluding wash-flagged offers.
 *
 * This is the function the issue's inflation lands on: summing every offer
 * amount is what let 100k self-deals outrank a legitimate market.
 */
export function getListingVolumeExcludingWash(
  listingId: string,
  opts: { includeWash?: boolean } = {},
): { totalPhaselq: number; offerCount: number; excludedWashCount: number } {
  const includeWash = opts.includeWash === true
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(amount_phaselq), 0) AS total,
         COUNT(*) AS offers
       FROM offers
       WHERE listing_id = ? AND status = 'accepted' AND (wash_flagged = 0 OR ? = 1)`,
    )
    .get(listingId, includeWash ? 1 : 0) as { total: number; offers: number }

  const excluded = getDb()
    .prepare(
      `SELECT COUNT(*) AS excluded FROM offers
        WHERE listing_id = ? AND status = 'accepted' AND wash_flagged = 1`,
    )
    .get(listingId) as { excluded: number }

  return {
    totalPhaselq: Number(row?.total ?? 0),
    offerCount: Number(row?.offers ?? 0),
    excludedWashCount: Number(excluded?.excluded ?? 0),
  }
}

/**
 * Volume across a whole collection, wash-flagged excluded — the aggregate that
 * drives explore ranking.
 */
export function getCollectionVolumeExcludingWash(
  collectionId: number,
  opts: { includeWash?: boolean } = {},
): { totalPhaselq: number; offerCount: number; excludedWashCount: number } {
  const includeWash = opts.includeWash === true
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(o.amount_phaselq), 0) AS total,
         COUNT(*) AS offers
       FROM offers o
       JOIN listings l ON l.id = o.listing_id
       WHERE l.collection_id = ? AND o.status = 'accepted'
         AND (o.wash_flagged = 0 OR ? = 1)`,
    )
    .get(collectionId, includeWash ? 1 : 0) as { total: number; offers: number }

  const excluded = getDb()
    .prepare(
      `SELECT COUNT(*) AS excluded
         FROM offers o
         JOIN listings l ON l.id = o.listing_id
        WHERE l.collection_id = ? AND o.status = 'accepted' AND o.wash_flagged = 1`,
    )
    .get(collectionId) as { excluded: number }

  const excludedCount = Number(excluded?.excluded ?? 0)
  if (excludedCount > 0) {
    incSecurityCounter("wash_volume_excluded", excludedCount)
  }

  return {
    totalPhaselq: Number(row?.total ?? 0),
    offerCount: Number(row?.offers ?? 0),
    excludedWashCount: excludedCount,
  }
}
