/**
 * phase-79: watchlist notifications for price drops — tests
 * Run: npx tsx tests/watchlist-price-drops.test.ts
 */
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

process.env.NEXT_PUBLIC_FEATURE_PHASE_79 = "1"
process.env.FEATURE_PHASE_79 = "1"
process.env.PHASE_SERVER_DATA_DIR = path.join(os.tmpdir(), `phase-watchlist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)

import {
  WatchlistNotificationError,
  addToWatchlistCli,
  auditWatchlistWiringOnReset,
  evaluatePriceDrop,
  getWatchlistCli,
  isPhase79Enabled,
  processPriceDropCli,
} from "../scripts/reset-phase"
import { NextRequest } from "next/server"
import {
  evaluateMarketPriceDrops,
  getWalletWatchlist,
  isWatchlistEnabled,
  upsertWatchlistItem,
} from "@/lib/watchlist-store"
import { GET as watchlistGet, POST as watchlistPost } from "@/app/api/watchlist/route"
import { pickCopy } from "@/lib/phase-copy"
import { resetSecurityCounters, snapshotSecurityCounters } from "@/lib/security-counters"

const WALLET_A = "GA" + "A".repeat(54)
const WALLET_B = "GB" + "B".repeat(53) + "A"
const SELLER_WALLET = "GS" + "S".repeat(53) + "A"

async function testFlagEnabled() {
  assert.equal(isPhase79Enabled(), true)
  console.log("✓ phase-79 flag enabled via env")
}

async function testEvaluatePriceDrop() {
  // Clear drop
  const drop = evaluatePriceDrop({ previousPrice: 100, newPrice: 75 })
  assert.equal(drop.isDrop, true)
  assert.equal(drop.qualifies, true)
  assert.equal(drop.dropAmount, 25)
  assert.equal(drop.dropPercentage, 25)

  // Price increase (not a drop)
  const inc = evaluatePriceDrop({ previousPrice: 100, newPrice: 120 })
  assert.equal(inc.isDrop, false)
  assert.equal(inc.qualifies, false)
  assert.equal(inc.dropAmount, 0)
  assert.equal(inc.dropPercentage, 0)

  // Same price (not a drop)
  const same = evaluatePriceDrop({ previousPrice: 100, newPrice: 100 })
  assert.equal(same.isDrop, false)

  // Target price evaluation
  const targetMet = evaluatePriceDrop({ previousPrice: 100, newPrice: 80, targetPrice: 85 })
  assert.equal(targetMet.isDrop, true)
  assert.equal(targetMet.qualifies, true)

  const targetNotMet = evaluatePriceDrop({ previousPrice: 100, newPrice: 90, targetPrice: 85 })
  assert.equal(targetNotMet.isDrop, true)
  assert.equal(targetNotMet.qualifies, false)

  console.log("✓ evaluatePriceDrop handles price drops, increases, and target thresholds")
}

async function testAddToWatchlistAndRetrieve() {
  const entry = await addToWatchlistCli({
    wallet: WALLET_A,
    collectionId: 0,
    tokenId: 1,
    targetPrice: 80,
  })

  assert.equal(entry.wallet, WALLET_A)
  assert.equal(entry.tokenId, 1)
  assert.equal(entry.targetPrice, 80)

  const list = await getWatchlistCli(WALLET_A)
  assert.equal(list.length, 1)
  assert.equal(list[0]?.tokenId, 1)
  console.log("✓ addToWatchlistCli stores and retrieves entries correctly")
}

async function testProcessPriceDropNotification() {
  // Add Wallet A watching token 2 (target <= 90)
  await addToWatchlistCli({
    wallet: WALLET_A,
    collectionId: 0,
    tokenId: 2,
    targetPrice: 90,
  })

  // Add Wallet B watching token 2 (no target, alerts on any drop)
  await addToWatchlistCli({
    wallet: WALLET_B,
    collectionId: 0,
    tokenId: 2,
  })

  // Drop price from 100 to 80 (both qualify)
  const res1 = await processPriceDropCli({
    collectionId: 0,
    tokenId: 2,
    previousPrice: 100,
    newPrice: 80,
    sellerWallet: SELLER_WALLET,
    tokenName: "Phase Artifact #2",
  })

  assert.equal(res1.notifiedCount, 2)
  assert.ok(res1.notifiedWallets.includes(WALLET_A))
  assert.ok(res1.notifiedWallets.includes(WALLET_B))
  assert.equal(res1.dropPercentage, 20)

  // Another drop from 80 to 80 (same price -> no duplicate notification)
  const res2 = await processPriceDropCli({
    collectionId: 0,
    tokenId: 2,
    previousPrice: 80,
    newPrice: 80,
  })
  assert.equal(res2.notifiedCount, 0)

  // Seller excluded from notifications on their own listing
  await addToWatchlistCli({
    wallet: SELLER_WALLET,
    collectionId: 0,
    tokenId: 2,
  })

  const res3 = await processPriceDropCli({
    collectionId: 0,
    tokenId: 2,
    previousPrice: 80,
    newPrice: 60,
    sellerWallet: SELLER_WALLET,
  })

  assert.ok(!res3.notifiedWallets.includes(SELLER_WALLET))
  assert.ok(res3.notifiedWallets.includes(WALLET_A))

  console.log("✓ processPriceDropCli accurately alerts collectors, filters seller, and prevents duplicates")
}

async function testFlagDisabledBlocksWatchlist() {
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_79
  delete process.env.FEATURE_PHASE_79
  assert.equal(isPhase79Enabled(), false)

  let threw = false
  try {
    await addToWatchlistCli({ wallet: WALLET_A, tokenId: 5, collectionId: 0 })
  } catch (e) {
    threw = e instanceof WatchlistNotificationError && e.code === "FLAG_DISABLED"
  }
  assert.equal(threw, true)

  // Can bypass with force: true
  const forced = await addToWatchlistCli({ wallet: WALLET_A, tokenId: 5, collectionId: 0 }, { force: true })
  assert.equal(forced.tokenId, 5)

  process.env.NEXT_PUBLIC_FEATURE_PHASE_79 = "1"
  process.env.FEATURE_PHASE_79 = "1"
  console.log("✓ watchlist operations blocked when phase-79 disabled unless force provided")
}

async function testWiringAudit() {
  const audit = auditWatchlistWiringOnReset()
  assert.equal(audit.ok, true)
  assert.ok(audit.note.includes("watchlist price drop notifications OK"))
  console.log("✓ wiring audit succeeds")
}

async function testPhase255WatchlistStoreAndAlerts() {
  resetSecurityCounters()

  // 1. Flag off = route 404, alerts off
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_255
  delete process.env.FEATURE_PHASE_255
  assert.equal(isWatchlistEnabled(), false)

  const offGet = await watchlistGet(new NextRequest("https://phase.example/api/watchlist"))
  assert.equal(offGet.status, 404)
  const offPost = await watchlistPost(
    new NextRequest("https://phase.example/api/watchlist", {
      method: "POST",
      body: JSON.stringify({ collectionId: 0, tokenId: 99, targetPrice: 50 }),
    }),
  )
  assert.equal(offPost.status, 404)
  const offAlerts = await evaluateMarketPriceDrops({
    collectionId: 0,
    tokenId: 99,
    previousPrice: 100,
    newPrice: 40,
  })
  assert.equal(offAlerts.alerts.length, 0)

  // 2. Flag on: version-guarded upsert + concurrent edit returns 409
  process.env.NEXT_PUBLIC_FEATURE_PHASE_255 = "1"
  process.env.FEATURE_PHASE_255 = "1"
  assert.equal(isWatchlistEnabled(), true)

  const add1 = await upsertWatchlistItem(WALLET_A, {
    collectionId: 0,
    tokenId: 101,
    targetPrice: 80,
    expectedVersion: 0,
  })
  assert.equal(add1.ok, true)
  if (!add1.ok) return
  assert.equal(add1.version, 1)

  const staleEdit = await upsertWatchlistItem(WALLET_A, {
    collectionId: 0,
    tokenId: 102,
    targetPrice: 50,
    expectedVersion: 0, // stale
  })
  assert.equal(staleEdit.ok, false)
  if (!staleEdit.ok) {
    assert.equal(staleEdit.status, 409)
    assert.equal(staleEdit.code, "VERSION_CONFLICT")
  }

  // 3. Threshold crossing produces one alert, deduped in same window
  const baseNow = 10_000_000
  const drop1 = await evaluateMarketPriceDrops({
    collectionId: 0,
    tokenId: 101,
    previousPrice: 100,
    newPrice: 75,
    nowMs: baseNow,
    windowMs: 3_600_000,
  })
  assert.equal(drop1.alerts.length, 1)

  const drop2SameWindow = await evaluateMarketPriceDrops({
    collectionId: 0,
    tokenId: 101,
    previousPrice: 75,
    newPrice: 70,
    nowMs: baseNow + 10_000,
    windowMs: 3_600_000,
  })
  assert.equal(drop2SameWindow.alerts.length, 0)
  assert.equal(drop2SameWindow.dedupedCount, 1)

  // 4. Price reversal above target resets the trigger, allowing next drop in new window
  const reversal = await evaluateMarketPriceDrops({
    collectionId: 0,
    tokenId: 101,
    previousPrice: 70,
    newPrice: 95,
    nowMs: baseNow + 20_000,
    windowMs: 3_600_000,
  })
  assert.equal(reversal.rearmedCount, 1)

  const listAfterReversal = await getWalletWatchlist(WALLET_A)
  assert.equal(listAfterReversal.items[0]?.armed, true)

  const dropAfterReversal = await evaluateMarketPriceDrops({
    collectionId: 0,
    tokenId: 101,
    previousPrice: 95,
    newPrice: 78,
    nowMs: baseNow + 3_700_000, // next window
    windowMs: 3_600_000,
  })
  assert.equal(dropAfterReversal.alerts.length, 1)

  // 5. Closed counters & EN/ES copy
  const counters = snapshotSecurityCounters()
  assert.ok((counters.watchlist_mutation ?? 0) >= 1)
  assert.ok((counters.watchlist_price_drop_alert ?? 0) >= 3)
  assert.ok(pickCopy("en").watchlist.conflictError.length > 0)
  assert.ok(pickCopy("es").watchlist.conflictError.length > 0)

  console.log("✓ phase-255 watchlist store, threshold alerts, dedupe, reversal reset & 409 guard passed")
}

async function run() {
  await testFlagEnabled()
  await testEvaluatePriceDrop()
  await testAddToWatchlistAndRetrieve()
  await testProcessPriceDropNotification()
  await testFlagDisabledBlocksWatchlist()
  await testWiringAudit()
  await testPhase255WatchlistStoreAndAlerts()
  console.log("\nAll watchlist price-drop (phase-79 + phase-255) tests passed.\n")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
