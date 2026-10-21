import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll as after, beforeAll as before, beforeEach, describe, it } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import type { SaleComp } from "@/lib/market-store"
import type { AiJsonGenerator } from "@/lib/forge/ai-pipeline"

let dataDir = ""
const DAY = 24 * 3_600_000
const NOW = 1_800_000_000_000

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-pricing-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_143 = "1"
  process.env.PHASE_PRICING_CONTROL_PCT = "0"
})

after(async () => {
  const { resetDbForTests } = await import("@/lib/sqlite-db")
  resetDbForTests()
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_143
  delete process.env.PHASE_PRICING_CONTROL_PCT
  await rm(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  const { resetSecurityCounters } = await import("@/lib/security-counters")
  resetSecurityCounters()
  process.env.PHASE_PRICING_CONTROL_PCT = "0"
})

const W = Array.from({ length: 20 }, () => Keypair.random().publicKey())
const OUTSIDER = Keypair.random().publicKey()
let seq = 0
function comp(amount: number, over: Partial<SaleComp> = {}): SaleComp {
  seq++
  return {
    offer_id: `o${seq}`,
    listing_id: `l${seq}`,
    token_id: seq,
    collection_id: 1,
    seller_wallet: W[(seq * 2) % 20]!,
    buyer_wallet: W[(seq * 2 + 1) % 20]!,
    amount_phaselq: amount,
    sold_at: NOW - DAY,
    wash_flagged: false,
    wash_reason: null,
    ...over,
  }
}

const noModel: AiJsonGenerator = async () => {
  throw new Error("AI_JSON_FAILED: offline")
}

describe("phase-143 comp weighing", () => {
  it("weighted quantiles follow cumulative weight", async () => {
    const { weightedQuantile } = await import("@/lib/pricing-oracle")
    const pts = [{ value: 10, weight: 1 }, { value: 20, weight: 1 }, { value: 30, weight: 8 }]
    assert.equal(weightedQuantile(pts, 0.5), 30)
    assert.equal(weightedQuantile(pts, 0.1), 10)
    assert.ok(Number.isNaN(weightedQuantile([], 0.5)))
  })

  it("excludes the requesting seller's own sales on either side", async () => {
    const { weighComps } = await import("@/lib/pricing-oracle")
    const me = Keypair.random().publicKey()
    const w = weighComps(
      [comp(10), comp(11), comp(500, { seller_wallet: me }), comp(500, { buyer_wallet: me.toLowerCase() })],
      { now: NOW, sellerWallet: me },
    )
    assert.equal(w.selfExcluded, 2)
    assert.ok(w.used.every((c) => c.amount_phaselq < 100))
  })

  it("drops wash-flagged sales and halves each repeat between the same pair", async () => {
    const { weighComps } = await import("@/lib/pricing-oracle")
    const a = W[0]!
    const b = W[1]!
    const w = weighComps(
      [comp(10, { wash_flagged: true }), comp(10, { seller_wallet: a, buyer_wallet: b }), comp(10, { seller_wallet: b, buyer_wallet: a }), comp(10)],
      { now: NOW, sellerWallet: OUTSIDER },
    )
    assert.equal(w.washExcluded, 1)
    assert.equal(w.washDiscounted, 2)
    const pair = w.used.filter((c) => [a, b].includes(c.seller_wallet))
    assert.ok(pair.every((c) => Math.abs(c.weight - 0.5 * 0.5 ** (1 / 14)) < 1e-9))
  })

  it("decays by half-life and drops outliers beyond the factor", async () => {
    const { weighComps } = await import("@/lib/pricing-oracle")
    const w = weighComps([comp(10, { sold_at: NOW - 14 * DAY }), comp(10, { sold_at: NOW }), comp(10), comp(1000)], {
      now: NOW,
      sellerWallet: OUTSIDER,
    })
    assert.equal(w.outliersDropped, 1)
    const old = w.used.find((c) => c.sold_at === NOW - 14 * DAY)!
    assert.ok(Math.abs(old.weight - 0.5) < 1e-9)
  })

  it("washCompWeight is the single discount model", async () => {
    const { washCompWeight } = await import("@/lib/wash-screening")
    assert.equal(washCompWeight({ washFlagged: true, repeatPairCount: 1 }), 0)
    assert.equal(washCompWeight({ washFlagged: false, repeatPairCount: 1 }), 1)
    assert.equal(washCompWeight({ washFlagged: false, repeatPairCount: 3 }), 0.25)
  })
})

describe("phase-143 suggestion", () => {
  const seller = Keypair.random().publicKey()
  const byLevel = (token: SaleComp[], collection: SaleComp[], global: SaleComp[]) => (scope: { token_id?: number; collection_id?: number }) =>
    scope.token_id !== undefined ? token : scope.collection_id !== undefined ? collection : global

  it("falls back token → collection → global and reports the level used", async () => {
    const { suggestListPrice } = await import("@/lib/pricing-oracle")
    const r = await suggestListPrice(
      { sellerWallet: seller, collectionId: 1, tokenId: 5, lang: "en" },
      { comps: byLevel([comp(99)], [comp(20), comp(22), comp(24)], []), liveBids: () => [], generate: noModel, now: NOW },
    )
    assert.ok(r.ok && r.suggestion)
    assert.equal(r.suggestion.level, "collection")
    assert.equal(r.suggestion.suggested_phaselq, 22)
    assert.equal(r.suggestion.rationale_source, "template")
  })

  it("returns an explicit non-result rather than inventing a price", async () => {
    const { suggestListPrice } = await import("@/lib/pricing-oracle")
    const r = await suggestListPrice(
      { sellerWallet: seller, collectionId: 1, lang: "es" },
      { comps: () => [comp(10)], liveBids: () => [], generate: noModel, now: NOW },
    )
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.code === "INSUFFICIENT_COMPS" && /ventas/.test(r.message))
  })

  it("never suggests below a live bid, and nets out the creator royalty", async () => {
    const { suggestListPrice } = await import("@/lib/pricing-oracle")
    const r = await suggestListPrice(
      { sellerWallet: seller, collectionId: 1, royaltyBps: 1000, creatorWallet: W[3]!, lang: "en" },
      { comps: () => [comp(20), comp(20), comp(20)], liveBids: () => [{ offer_id: "b1", amount_phaselq: 30 }], generate: noModel, now: NOW },
    )
    assert.ok(r.ok && r.suggestion)
    assert.equal(r.suggestion.suggested_phaselq, 30)
    assert.equal(r.suggestion.floored_by_bid, true)
    assert.equal(r.suggestion.net_proceeds.seller_phaselq, 27)
  })

  it("the control arm is recorded but shown no number", async () => {
    process.env.PHASE_PRICING_CONTROL_PCT = "100"
    const { suggestListPrice } = await import("@/lib/pricing-oracle")
    let called = false
    const r = await suggestListPrice(
      { sellerWallet: seller, collectionId: 1, lang: "en" },
      {
        comps: () => [comp(20), comp(20), comp(20)],
        liveBids: () => [],
        generate: async () => {
          called = true
          return { json: null, modelId: "m", outputChars: 0 }
        },
        now: NOW,
      },
    )
    assert.ok(r.ok)
    assert.equal(r.suggestion, null)
    assert.equal(r.arm, "control")
    assert.equal(called, false)
  })

  it("discards a model rationale that cites an unknown sale or writes an unknown number", async () => {
    const { suggestListPrice } = await import("@/lib/pricing-oracle")
    const { getSecurityCounter } = await import("@/lib/security-counters")
    const comps = [comp(20), comp(20), comp(20)]
    const run = (summary: string, ids: string[]) =>
      suggestListPrice(
        { sellerWallet: seller, collectionId: 1, lang: "en" },
        { comps: () => comps, liveBids: () => [], generate: async () => ({ json: { summary, cited_offer_ids: ids }, modelId: "m", outputChars: 50 }), now: NOW },
      )
    const invented = await run("Similar works sold for 45 PHASELQ.", [comps[0]!.offer_id])
    assert.ok(invented.ok && invented.suggestion?.rationale_source === "template")
    const ghost = await run("Similar works sold for 20 PHASELQ.", ["o-made-up"])
    assert.ok(ghost.ok && ghost.suggestion?.rationale_source === "template")
    assert.equal(getSecurityCounter("pricing_citation_rejected"), 2)
    const good = await run("Three recent sales cleared at 20 PHASELQ.", [comps[0]!.offer_id])
    assert.ok(good.ok && good.suggestion?.rationale_source === "model")
  })
})

describe("phase-143 against the real market store", () => {
  it("reads sales from accepted offers only: no royalty double count, no lazily-expired bids", async () => {
    const { createListing, createOffer, updateOfferStatus, getSaleComps, getLiveBids, recordRoyaltyPayout, computeRoyaltySplit } =
      await import("@/lib/market-store")
    const { getDb } = await import("@/lib/sqlite-db")
    const collection_id = 777
    for (let i = 0; i < 3; i++) {
      const seller = Keypair.random().publicKey()
      const listing = await createListing({
        token_id: 7000 + i,
        collection_id,
        seller_wallet: seller,
        price_phaselq: 50,
        accepts_offers: true,
        creator_wallet: W[0]!,
        royalty_bps: 500,
      })
      const offer = await createOffer({ listing_id: listing.id, buyer_wallet: Keypair.random().publicKey(), amount_phaselq: 40 + i })
      await updateOfferStatus(offer.id, "accepted")
      await recordRoyaltyPayout(listing, offer.id, computeRoyaltySplit(listing, offer.amount_phaselq))
    }
    const open = await createListing({ token_id: 7100, collection_id, seller_wallet: W[5]!, price_phaselq: 60, accepts_offers: true })
    const stale = await createOffer({ listing_id: open.id, buyer_wallet: W[6]!, amount_phaselq: 99 })
    getDb().prepare("UPDATE offers SET expires_at = ? WHERE id = ?").run(Date.now() - 1, stale.id)
    const live = await createOffer({ listing_id: open.id, buyer_wallet: W[7]!, amount_phaselq: 45 })

    const comps = getSaleComps({ collection_id })
    assert.equal(comps.length, 3)
    assert.ok(comps.every((c) => typeof c.sold_at === "number" && c.sold_at > 0))
    assert.deepEqual(getLiveBids(collection_id).map((b) => b.offer_id), [live.id])
  })

  it("records the outcome once, by the same seller, within the TTL", async () => {
    const { suggestListPrice, recordSuggestionOutcome, markSuggestionSold, getPricingExperimentStats } = await import("@/lib/pricing-oracle")
    const seller = Keypair.random().publicKey()
    const r = await suggestListPrice(
      { sellerWallet: seller, collectionId: 1, lang: "en" },
      { comps: () => [comp(20), comp(20), comp(20)], liveBids: () => [], generate: noModel },
    )
    assert.ok(r.ok)
    const base = { suggestionId: r.suggestion_id, sellerWallet: seller, collectionId: 1, listingId: "L-1", listedPrice: 20.2 }

    assert.deepEqual(recordSuggestionOutcome({ ...base, sellerWallet: W[9]! }), { recorded: false, reason: "MISMATCH" })
    assert.deepEqual(recordSuggestionOutcome(base), { recorded: true, outcome: "accepted" })
    assert.deepEqual(recordSuggestionOutcome({ ...base, listedPrice: 90 }), { recorded: false, reason: "ALREADY_RECORDED" })
    assert.deepEqual(recordSuggestionOutcome({ ...base, suggestionId: "nope" }), { recorded: false, reason: "NOT_FOUND" })

    assert.equal(markSuggestionSold("L-1"), true)
    assert.equal(markSuggestionSold("L-1"), false)
    const treatment = getPricingExperimentStats().find((s) => s.arm === "treatment")!
    assert.ok(treatment.listed >= 1 && treatment.sold >= 1 && treatment.accept_rate !== null)
  })

  it("expired suggestions cannot be claimed", async () => {
    const { suggestListPrice, recordSuggestionOutcome, classifyOutcome } = await import("@/lib/pricing-oracle")
    const seller = Keypair.random().publicKey()
    const r = await suggestListPrice(
      { sellerWallet: seller, collectionId: 1, lang: "en" },
      { comps: () => [comp(20), comp(20), comp(20)], liveBids: () => [], generate: noModel, now: NOW },
    )
    assert.ok(r.ok)
    const outcome = recordSuggestionOutcome({
      suggestionId: r.suggestion_id,
      sellerWallet: seller,
      collectionId: 1,
      listingId: "L-2",
      listedPrice: 20,
      now: NOW + 2 * DAY,
    })
    assert.deepEqual(outcome, { recorded: false, reason: "EXPIRED" })
    assert.equal(classifyOutcome("treatment", 100, 110), "adjusted_up")
    assert.equal(classifyOutcome("treatment", 100, 90), "adjusted_down")
  })
})
