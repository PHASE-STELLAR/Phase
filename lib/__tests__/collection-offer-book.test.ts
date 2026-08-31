import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { Keypair } from "@stellar/stellar-sdk"
import {
  createListing,
  createOffer,
  createBulkOffer,
  getCollectionOfferBook,
  updateOfferStatus,
} from "@/lib/market-store"

let dataDir = ""

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-offer-book-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_139 = "1"
})

after(async () => {
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_139
  await rm(dataDir, { recursive: true, force: true })
})

describe("phase-139 collection offer books", () => {
  it("aggregates pending offers across a collection's listings into price levels, best price first", async () => {
    const collection_id = 9001
    const seller = Keypair.random().publicKey()
    const buyerA = Keypair.random().publicKey()
    const buyerB = Keypair.random().publicKey()

    const listingA = await createListing({
      token_id: 1,
      collection_id,
      seller_wallet: seller,
      price_phaselq: 100,
      accepts_offers: true,
    })
    const listingB = await createListing({
      token_id: 2,
      collection_id,
      seller_wallet: seller,
      price_phaselq: 150,
      accepts_offers: true,
    })

    await createOffer({ listing_id: listingA.id, buyer_wallet: buyerA, amount_phaselq: 40 })
    await createOffer({ listing_id: listingB.id, buyer_wallet: buyerB, amount_phaselq: 60 })
    await createOffer({ listing_id: listingA.id, buyer_wallet: buyerB, amount_phaselq: 60 })

    const book = await getCollectionOfferBook(collection_id)
    assert.equal(book.total_pending_offers, 3)
    assert.equal(book.listings_with_offers, 2)
    assert.equal(book.best_offer_phaselq, 60)
    assert.equal(book.levels[0]?.price_phaselq, 60)
    assert.equal(book.levels[0]?.offer_count, 2)
    assert.equal(book.levels[1]?.price_phaselq, 40)
  })

  it("excludes offers from other collections and non-pending offers", async () => {
    const collection_id = 9002
    const otherCollectionId = 9003
    const seller = Keypair.random().publicKey()
    const buyer = Keypair.random().publicKey()

    const listing = await createListing({
      token_id: 3,
      collection_id,
      seller_wallet: seller,
      price_phaselq: 100,
      accepts_offers: true,
    })
    const otherListing = await createListing({
      token_id: 4,
      collection_id: otherCollectionId,
      seller_wallet: seller,
      price_phaselq: 100,
      accepts_offers: true,
    })

    const acceptedOffer = await createOffer({ listing_id: listing.id, buyer_wallet: buyer, amount_phaselq: 10 })
    await updateOfferStatus(acceptedOffer.id, "accepted")
    await createOffer({ listing_id: otherListing.id, buyer_wallet: buyer, amount_phaselq: 999 })

    const book = await getCollectionOfferBook(collection_id)
    assert.equal(book.total_pending_offers, 0)
    assert.equal(book.best_offer_phaselq, null)
    assert.deepEqual(book.levels, [])
  })

  it("bulk bid fans out into per-listing offers, skipping listings that can't accept them", async () => {
    const collection_id = 9004
    const seller = Keypair.random().publicKey()
    const buyer = Keypair.random().publicKey()

    const openListing = await createListing({
      token_id: 5,
      collection_id,
      seller_wallet: seller,
      price_phaselq: 100,
      accepts_offers: true,
    })
    const noOffersListing = await createListing({
      token_id: 6,
      collection_id,
      seller_wallet: seller,
      price_phaselq: 100,
      accepts_offers: false,
    })
    const ownListing = await createListing({
      token_id: 7,
      collection_id,
      seller_wallet: buyer,
      price_phaselq: 100,
      accepts_offers: true,
    })

    const result = await createBulkOffer(buyer, [
      { listing_id: openListing.id, amount_phaselq: 25 },
      { listing_id: noOffersListing.id, amount_phaselq: 25 },
      { listing_id: ownListing.id, amount_phaselq: 25 },
      { listing_id: "does-not-exist", amount_phaselq: 25 },
    ])

    assert.equal(result.created.length, 1)
    assert.equal(result.created[0]?.listing_id, openListing.id)
    assert.equal(result.skipped.length, 3)
    assert.deepEqual(
      result.skipped.map((s) => s.reason).sort(),
      ["not_found", "offers_disabled", "own_listing"],
    )
  })
})
