import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { Keypair } from "@stellar/stellar-sdk"
import {
  createListing,
  computeRoyaltySplit,
  recordRoyaltyPayout,
  getRoyaltyPayoutsForCreator,
} from "@/lib/market-store"

let dataDir = ""

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-royalty-split-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_140 = "1"
})

after(async () => {
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_140
  await rm(dataDir, { recursive: true, force: true })
})

describe("phase-140 royalty split computation", () => {
  it("splits a secondary sale between creator and seller by royalty_bps", () => {
    const split = computeRoyaltySplit(
      { seller_wallet: "SELLER", creator_wallet: "CREATOR", royalty_bps: 750 },
      200,
    )
    assert.equal(split.is_secondary_sale, true)
    assert.equal(split.royalty_bps, 750)
    assert.equal(split.royalty_amount_phaselq, 15)
    assert.equal(split.seller_amount_phaselq, 185)
  })

  it("pays no royalty on a primary sale (creator selling their own mint)", () => {
    const split = computeRoyaltySplit(
      { seller_wallet: "CREATOR", creator_wallet: "CREATOR", royalty_bps: 750 },
      200,
    )
    assert.equal(split.is_secondary_sale, false)
    assert.equal(split.royalty_amount_phaselq, 0)
    assert.equal(split.seller_amount_phaselq, 200)
  })

  it("pays no royalty when the listing has no creator_wallet on file", () => {
    const split = computeRoyaltySplit({ seller_wallet: "SELLER" }, 200)
    assert.equal(split.is_secondary_sale, false)
    assert.equal(split.royalty_amount_phaselq, 0)
    assert.equal(split.seller_amount_phaselq, 200)
  })

  it("records and reads back a royalty payout for a creator", async () => {
    const creator = Keypair.random().publicKey()
    const seller = Keypair.random().publicKey()
    const listing = await createListing({
      token_id: 42,
      collection_id: 1,
      seller_wallet: seller,
      price_phaselq: 300,
      accepts_offers: true,
      creator_wallet: creator,
      royalty_bps: 1000,
    })

    const split = computeRoyaltySplit(listing, 300)
    const payout = await recordRoyaltyPayout(listing, "offer-123", split)

    assert.equal(payout.creator_wallet, creator)
    assert.equal(payout.seller_wallet, seller)
    assert.equal(payout.royalty_amount_phaselq, 30)
    assert.equal(payout.seller_amount_phaselq, 270)
    assert.equal(payout.sale_amount_phaselq, 300)

    const payouts = await getRoyaltyPayoutsForCreator(creator)
    assert.equal(payouts.length, 1)
    assert.equal(payouts[0]?.id, payout.id)
  })

  it("throws when recording a payout for a listing with no creator_wallet", async () => {
    const seller = Keypair.random().publicKey()
    const listing = await createListing({
      token_id: 43,
      collection_id: 1,
      seller_wallet: seller,
      price_phaselq: 100,
      accepts_offers: true,
    })
    const split = computeRoyaltySplit(listing, 100)
    await assert.rejects(() => recordRoyaltyPayout(listing, "offer-456", split))
  })
})
