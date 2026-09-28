/**
 * Wash-trade screening + volume exclusion (issue #230) — tests
 * Run: npx tsx tests/wash-screening.test.ts
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Point the SQLite store at a scratch directory before anything imports it.
const scratch = mkdtempSync(path.join(tmpdir(), "phase-wash-"))
process.env.PHASE_DATA_DIR = scratch
process.env.PHASE_DATA_ROOT = scratch
process.env.NEXT_PUBLIC_FEATURE_PHASE_77 = "1"
process.env.FEATURE_PHASE_77 = "1"

import {
  WASH_WINDOW_MS,
  getCollectionVolumeExcludingWash,
  getListingVolumeExcludingWash,
  screenOfferForWash,
} from "@/lib/wash-screening"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const ALICE = "GBRPYHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX"
const BOB = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
const CAROL = "GC3C4AKRBQLHOJ45U4XGNCESAMCRAFODXKCEOG7TFAXK5RZWCR4GWRPFP"

function testFlagsDirectSelfDeal() {
  resetSecurityCounters()
  const result = screenOfferForWash({
    listingId: "l1",
    tokenId: 1,
    sellerWallet: ALICE,
    buyerWallet: ALICE,
    amountPhaselq: 1,
  })
  assert.equal(result.washFlagged, true, "buyer==seller must be flagged")
  assert.match(result.washReason ?? "", /self-trade/i)
  assert.ok(getSecurityCounter("wash_trades_flagged") > 0)
}

function testSelfDealIsCaseInsensitive() {
  const result = screenOfferForWash({
    listingId: "l1",
    tokenId: 1,
    sellerWallet: ALICE.toLowerCase(),
    buyerWallet: ALICE.toUpperCase(),
    amountPhaselq: 1,
  })
  assert.equal(result.washFlagged, true, "wallet comparison must be case-insensitive")
}

function testDoesNotFlagDistinctParties() {
  const result = screenOfferForWash({
    listingId: "l1",
    tokenId: 1,
    sellerWallet: ALICE,
    buyerWallet: BOB,
    amountPhaselq: 5,
  })
  assert.equal(result.washFlagged, false, "an ordinary offer must not be flagged")
  assert.equal(result.washReason, null)
}

async function testVolumeExcludesFlaggedOffers() {
  const { getDb, resetDbForTests } = await import("@/lib/sqlite-db")
  resetDbForTests()
  const db = getDb()

  const now = Date.now()
  db.prepare(
    `INSERT INTO listings (id, token_id, collection_id, seller_wallet, price_phaselq,
                           accepts_offers, listed_at, status)
     VALUES ('l1', 1, 1, ?, 1, 1, ?, 'active')`,
  ).run(ALICE, now)

  // One legitimate accepted offer and one wash-flagged accepted offer.
  db.prepare(
    `INSERT INTO offers (id, listing_id, buyer_wallet, amount_phaselq, created_at,
                         status, expires_at, wash_flagged, wash_reason)
     VALUES ('ok1', 'l1', ?, 50, ?, 'accepted', ?, 0, NULL)`,
  ).run(BOB, now, now + 86_400_000)
  db.prepare(
    `INSERT INTO offers (id, listing_id, buyer_wallet, amount_phaselq, created_at,
                         status, expires_at, wash_flagged, wash_reason)
     VALUES ('wash1', 'l1', ?, 100_000, ?, 'accepted', ?, 1, 'self-trade')`,
  ).run(ALICE, now, now + 86_400_000)

  const filtered = getListingVolumeExcludingWash("l1")
  assert.equal(filtered.totalPhaselq, 50, "wash-flagged volume must be excluded")
  assert.equal(filtered.offerCount, 1)
  assert.equal(filtered.excludedWashCount, 1)

  const unfiltered = getListingVolumeExcludingWash("l1", { includeWash: true })
  assert.equal(unfiltered.totalPhaselq, 100_050, "includeWash is the before/after comparison")

  const collection = getCollectionVolumeExcludingWash(1)
  assert.equal(collection.totalPhaselq, 50, "collection volume must exclude wash too")
  assert.equal(collection.excludedWashCount, 1)
}

async function testOnlyAcceptedOffersCount() {
  const { getDb, resetDbForTests } = await import("@/lib/sqlite-db")
  resetDbForTests()
  const db = getDb()
  const now = Date.now()

  db.prepare(
    `INSERT INTO listings (id, token_id, collection_id, seller_wallet, price_phaselq,
                           accepts_offers, listed_at, status)
     VALUES ('l2', 2, 2, ?, 1, 1, ?, 'active')`,
  ).run(CAROL, now)
  db.prepare(
    `INSERT INTO offers (id, listing_id, buyer_wallet, amount_phaselq, created_at,
                         status, expires_at, wash_flagged, wash_reason)
     VALUES ('pend1', 'l2', ?, 999, ?, 'pending', ?, 0, NULL)`,
  ).run(ALICE, now, now + 86_400_000)

  const volume = getListingVolumeExcludingWash("l2")
  assert.equal(volume.totalPhaselq, 0, "a pending offer is not volume")
  assert.equal(volume.offerCount, 0)
}

async function main() {
  testFlagsDirectSelfDeal(); console.log("✓ flags a direct self-deal")
  testSelfDealIsCaseInsensitive(); console.log("✓ self-deal detection is case-insensitive")
  testDoesNotFlagDistinctParties(); console.log("✓ does not flag an ordinary offer")
  await testVolumeExcludesFlaggedOffers(); console.log("✓ volume excludes wash-flagged offers")
  await testOnlyAcceptedOffersCount(); console.log("✓ only accepted offers count toward volume")
  assert.ok(WASH_WINDOW_MS > 0)
  rmSync(scratch, { recursive: true, force: true })
  console.log("\nAll wash-screening tests passed.")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
