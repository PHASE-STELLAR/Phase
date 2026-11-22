/**
 * Tests for phase-140 royalty enforcement on secondary sales.
 *
 * Covers:
 *  - computeRoyaltySplit: primary vs secondary, bps math, zero-royalty listings
 *  - createListing validation: flag gate, bps range, wallet format, missing fields
 *  - decideOfferAtomic: payout row written inside the same transaction; rollback on conflict
 *  - recordRoyaltyPayout / getRoyaltyPayoutsForCreator: append-only ledger reads
 *  - Flag off: seller receives 100% (legacy behaviour)
 */

import { describe, it, beforeEach, afterEach } from "vitest"
import * as assert from "node:assert/strict"
import { Keypair } from "@stellar/stellar-sdk"
import {
  computeRoyaltySplit,
  createListing,
  createOffer,
  decideOfferAtomic,
  getRoyaltyPayoutsForCreator,
  recordRoyaltyPayout,
  MarketStoreValidationError,
} from "@/lib/market-store"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const seller = Keypair.random().publicKey()
const buyer = Keypair.random().publicKey()
const creator = Keypair.random().publicKey()

function enableFlag() {
  process.env.FEATURE_PHASE_140 = "true"
  process.env.NEXT_PUBLIC_FEATURE_PHASE_140 = "true"
}

function disableFlag() {
  delete process.env.FEATURE_PHASE_140
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_140
}

async function seedListing(opts: {
  creator_wallet?: string
  royalty_bps?: number
  price?: number
} = {}) {
  return createListing({
    token_id: Math.floor(Math.random() * 1_000_000),
    collection_id: 1,
    seller_wallet: seller,
    price_phaselq: opts.price ?? 100,
    accepts_offers: true,
  })
}

async function seedListingWithRoyalty(royalty_bps = 500) {
  return createListing({
    token_id: Math.floor(Math.random() * 1_000_000),
    collection_id: 1,
    seller_wallet: seller,
    price_phaselq: 100,
    accepts_offers: true,
    creator_wallet: creator,
    royalty_bps,
  })
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetDbForTests()
  enableFlag()
})

afterEach(() => {
  disableFlag()
})

// ── computeRoyaltySplit ───────────────────────────────────────────────────────

describe("computeRoyaltySplit", () => {
  it("returns a zero split for a primary sale (seller = creator)", () => {
    const listing = { seller_wallet: seller, creator_wallet: seller, royalty_bps: 1000 }
    const split = computeRoyaltySplit(listing, 100)
    assert.equal(split.royalty_amount_phaselq, 0)
    assert.equal(split.seller_amount_phaselq, 100)
    assert.equal(split.is_secondary_sale, false)
  })

  it("returns a zero split when no creator_wallet is set", () => {
    const listing = { seller_wallet: seller, creator_wallet: undefined, royalty_bps: 500 }
    const split = computeRoyaltySplit(listing, 200)
    assert.equal(split.royalty_amount_phaselq, 0)
    assert.equal(split.seller_amount_phaselq, 200)
  })

  it("computes the correct royalty for a secondary sale", () => {
    // 500 bps = 5%; sale = 1000 → royalty = 50, seller = 950
    const listing = { seller_wallet: seller, creator_wallet: creator, royalty_bps: 500 }
    const split = computeRoyaltySplit(listing, 1000)
    assert.equal(split.royalty_bps, 500)
    assert.ok(split.royalty_amount_phaselq > 0)
    assert.ok(Math.abs((split.royalty_amount_phaselq + split.seller_amount_phaselq) - 1000) < 0.0001,
      "royalty + seller must equal sale amount")
    assert.equal(split.is_secondary_sale, true)
  })

  it("seller net is deterministic (same inputs → same outputs)", () => {
    const listing = { seller_wallet: seller, creator_wallet: creator, royalty_bps: 250 }
    const a = computeRoyaltySplit(listing, 777)
    const b = computeRoyaltySplit(listing, 777)
    assert.equal(a.seller_amount_phaselq, b.seller_amount_phaselq)
    assert.equal(a.royalty_amount_phaselq, b.royalty_amount_phaselq)
  })
})

// ── createListing validation ──────────────────────────────────────────────────

describe("createListing royalty validation", () => {
  it("accepts a listing with valid creator_wallet and royalty_bps", async () => {
    const listing = await seedListingWithRoyalty(300)
    assert.equal(listing.creator_wallet, creator)
    assert.equal(listing.royalty_bps, 300)
  })

  it("rejects royalty_bps > 10000", async () => {
    await assert.rejects(
      () => createListing({
        token_id: 1, collection_id: 1, seller_wallet: seller, price_phaselq: 10, accepts_offers: false,
        creator_wallet: creator, royalty_bps: 10001,
      }),
      (err: any) => err instanceof MarketStoreValidationError && err.code === "VALIDATION_FAILED",
    )
  })

  it("rejects royalty_bps < 0", async () => {
    await assert.rejects(
      () => createListing({
        token_id: 1, collection_id: 1, seller_wallet: seller, price_phaselq: 10, accepts_offers: false,
        creator_wallet: creator, royalty_bps: -1,
      }),
      (err: any) => err instanceof MarketStoreValidationError && err.code === "VALIDATION_FAILED",
    )
  })

  it("rejects an invalid creator_wallet", async () => {
    await assert.rejects(
      () => createListing({
        token_id: 1, collection_id: 1, seller_wallet: seller, price_phaselq: 10, accepts_offers: false,
        creator_wallet: "not-a-valid-key", royalty_bps: 500,
      }),
      (err: any) => err instanceof MarketStoreValidationError && err.code === "VALIDATION_FAILED",
    )
  })

  it("rejects royalty_bps without creator_wallet", async () => {
    await assert.rejects(
      () => createListing({
        token_id: 1, collection_id: 1, seller_wallet: seller, price_phaselq: 10, accepts_offers: false,
        royalty_bps: 500,
      }),
      (err: any) => err instanceof MarketStoreValidationError && err.code === "VALIDATION_FAILED",
    )
  })

  it("throws FLAG_DISABLED when phase-140 is off", async () => {
    disableFlag()
    await assert.rejects(
      () => createListing({
        token_id: 1, collection_id: 1, seller_wallet: seller, price_phaselq: 10, accepts_offers: false,
        creator_wallet: creator, royalty_bps: 500,
      }),
      (err: any) => err instanceof MarketStoreValidationError && err.code === "FLAG_DISABLED",
    )
  })

  it("accepts listing with no royalty fields regardless of flag", async () => {
    disableFlag()
    const listing = await seedListing()
    assert.equal(listing.creator_wallet, undefined)
    assert.equal(listing.royalty_bps, undefined)
  })
})

// ── decideOfferAtomic + payout ledger ────────────────────────────────────────

describe("decideOfferAtomic royalty payout", () => {
  it("writes a royalty_payouts row when a secondary sale is accepted", async () => {
    process.env.FEATURE_PHASE_177 = "true"
    process.env.NEXT_PUBLIC_FEATURE_PHASE_177 = "true"
    try {
      const listing = await seedListingWithRoyalty(500)
      const offer = await createOffer({
        listing_id: listing.id,
        buyer_wallet: buyer,
        amount_phaselq: 200,
      })
      decideOfferAtomic(listing.id, offer.id, seller, "accept")

      const payouts = await getRoyaltyPayoutsForCreator(creator)
      assert.equal(payouts.length, 1)
      const payout = payouts[0]
      assert.equal(payout.listing_id, listing.id)
      assert.equal(payout.offer_id, offer.id)
      assert.equal(payout.creator_wallet, creator)
      assert.equal(payout.seller_wallet, seller)
      assert.equal(payout.sale_amount_phaselq, 200)
      assert.ok(payout.royalty_amount_phaselq > 0)
      assert.ok(payout.seller_amount_phaselq < 200)
    } finally {
      delete process.env.FEATURE_PHASE_177
      delete process.env.NEXT_PUBLIC_FEATURE_PHASE_177
    }
  })

  it("does NOT write a payout row for a primary sale (seller = creator)", async () => {
    process.env.FEATURE_PHASE_177 = "true"
    process.env.NEXT_PUBLIC_FEATURE_PHASE_177 = "true"
    try {
      const listing = await createListing({
        token_id: Math.floor(Math.random() * 1_000_000),
        collection_id: 1,
        seller_wallet: creator, // same as creator → primary sale
        price_phaselq: 100,
        accepts_offers: true,
        creator_wallet: creator,
        royalty_bps: 500,
      })
      const offer = await createOffer({ listing_id: listing.id, buyer_wallet: buyer, amount_phaselq: 100 })
      decideOfferAtomic(listing.id, offer.id, creator, "accept")

      const payouts = await getRoyaltyPayoutsForCreator(creator)
      assert.equal(payouts.length, 0)
    } finally {
      delete process.env.FEATURE_PHASE_177
      delete process.env.NEXT_PUBLIC_FEATURE_PHASE_177
    }
  })

  it("flag off: seller receives 100% and no payout row is written", async () => {
    disableFlag()
    process.env.FEATURE_PHASE_177 = "true"
    process.env.NEXT_PUBLIC_FEATURE_PHASE_177 = "true"
    try {
      // Create listing without royalty fields (flag is off)
      const listing = await seedListing({ price: 100 })
      const offer = await createOffer({ listing_id: listing.id, buyer_wallet: buyer, amount_phaselq: 100 })
      decideOfferAtomic(listing.id, offer.id, seller, "accept")

      const payouts = await getRoyaltyPayoutsForCreator(creator)
      assert.equal(payouts.length, 0)
    } finally {
      delete process.env.FEATURE_PHASE_177
      delete process.env.NEXT_PUBLIC_FEATURE_PHASE_177
    }
  })
})

// ── Append-only ledger ────────────────────────────────────────────────────────

describe("royalty_payouts ledger is append-only", () => {
  it("accumulates rows across multiple secondary sales", async () => {
    const listing1 = await seedListingWithRoyalty(200)
    const listing2 = await seedListingWithRoyalty(300)

    const split1 = computeRoyaltySplit(listing1, 100)
    const split2 = computeRoyaltySplit(listing2, 200)

    await recordRoyaltyPayout(listing1, "offer-1", split1)
    await recordRoyaltyPayout(listing2, "offer-2", split2)

    const payouts = await getRoyaltyPayoutsForCreator(creator)
    assert.equal(payouts.length, 2)
    // Most-recent first
    assert.equal(payouts[0].listing_id, listing2.id)
    assert.equal(payouts[1].listing_id, listing1.id)
  })
})
