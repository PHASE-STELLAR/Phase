import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Keypair } from "@stellar/stellar-sdk"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"
import { recordTaxEvent, taxCsv, csvCell, verifyTaxExport, taxExportRateLimited } from "@/lib/tax-report"
import { taxExportMessage, type TaxExportRequest } from "@/lib/tax-export-proof"
import { decimalToStroops, formatStroops } from "@/lib/decimal-amount"
import { createListing, createOffer, decideOfferAtomic, getListing } from "@/lib/market-store"
import { resetSecurityCounters, getSecurityCounter } from "@/lib/security-counters"

const key = Keypair.random(), buyer = Keypair.random().publicKey(), wallet = key.publicKey()
const txHash = "a".repeat(64)
const start = Date.parse("2026-01-01T00:00:00Z")
const input: TaxExportRequest = { wallet, from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z", policy: "FIFO", exp: Math.floor(Date.now()/1000)+240, nonce: "abcdefghijklmnop" }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-tax-")); vi.stubEnv("PHASE_SERVER_DATA_DIR", dir); vi.stubEnv("FEATURE_PHASE_177", "1"); resetDbForTests()
})
afterEach(() => { resetDbForTests(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })
const event = { eventKey: "test:1", wallet, kind: "reward" as const, asset: "PHASELQ", amountStroops: "123456789", occurredAt: start+100, verified: true, txHash }
const snapshot = () => (getDb().prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM tax_events").get() as { seq: number }).seq

describe("durable transaction exports", () => {
  it("limits signed exports per wallet and resets at the minute boundary", () => {
    for (let i = 0; i < 60; i++) expect(taxExportRateLimited(wallet, 120_000)).toBe(false)
    expect(taxExportRateLimited(wallet, 120_000)).toBe(true)
    expect(taxExportRateLimited(buyer, 120_000)).toBe(false)
    expect(taxExportRateLimited(wallet, 180_000)).toBe(false)
  })
  it("stores once across restart and rejects conflicting idempotency keys", () => {
    recordTaxEvent(event); resetDbForTests(); recordTaxEvent(event)
    expect(snapshot()).toBe(1)
    expect(() => recordTaxEvent({ ...event, amountStroops: "1" })).toThrow("TAX_EVENT_CONFLICT")
  })
  it("performs no writes when disabled", () => {
    vi.stubEnv("FEATURE_PHASE_177", "0"); recordTaxEvent(event); expect(snapshot()).toBe(0)
  })
  it("never substitutes zero for unknown basis and excludes unverified/wash activity from proceeds", () => {
    recordTaxEvent({ ...event, kind: "disposal" })
    recordTaxEvent({ ...event, eventKey: "unverified", kind: "disposal", verified: false })
    recordTaxEvent({ ...event, eventKey: "wash", kind: "royalty", washFlagged: true })
    const csv = [...taxCsv(input, snapshot())].join("")
    expect(csv).toContain("missing_basis")
    expect(csv).toContain('"12.3456789","","12.3456789",""')
    expect(csv).toContain("wash_excluded")
    expect(csv).toContain("unverified")
  })
  it("reconstructs pre-range acquisition basis and separates royalty income", () => {
    recordTaxEvent({ ...event, eventKey: "acq", asset: "contract:1", kind: "acquisition", occurredAt: start-100, basisStroops: "10000000" })
    recordTaxEvent({ ...event, eventKey: "sale", asset: "contract:1", kind: "disposal", amountStroops: "25000000" })
    recordTaxEvent({ ...event, eventKey: "royalty", kind: "royalty", amountStroops: "5000000" })
    const csv = [...taxCsv(input, snapshot())].join("")
    expect(csv).toContain('"2.5000000","1.0000000","2.5000000","1.5000000",""')
    expect(csv).toContain('"0.5000000","","","","0.5000000"')
  })
  it("orders equal-time evidence by sequence and selects HIFO with exact big-integer costs", () => {
    recordTaxEvent({ ...event, eventKey: "low-lot", asset: "contract:2", kind: "acquisition", basisStroops: "90071992547409930" })
    recordTaxEvent({ ...event, eventKey: "high-lot", asset: "contract:2", kind: "acquisition", basisStroops: "90071992547409931" })
    recordTaxEvent({ ...event, eventKey: "disposal", asset: "contract:2", kind: "disposal", amountStroops: "90071992547409932" })
    expect([...taxCsv(input, snapshot())].join("")).toContain('"0.0000002"')
    expect([...taxCsv({ ...input, policy: "HIFO" }, snapshot())].join("")).toContain('"0.0000001"')
  })
  it("streams beyond a page with deterministic hashes, stable ordering, snapshot cutoff and wallet isolation", () => {
    for (let i=0; i<121; i++) recordTaxEvent({ ...event, eventKey: `page:${i}`, occurredAt: start+100+(i%3) })
    const cutoff = snapshot()
    const csv = [...taxCsv(input, cutoff)]
    recordTaxEvent({ ...event, eventKey: "later" })
    recordTaxEvent({ ...event, eventKey: "otherwallet", wallet: buyer })
    expect(csv).toHaveLength(122)
    expect([...taxCsv(input, cutoff)]).toEqual(csv)
    expect(csv.join("")).not.toContain("later")
    expect(csv.join("")).not.toContain("otherwallet")
    expect([...taxCsv(input, cutoff)]).toEqual(csv)
  })
  it("uses precise stroops and quotes multiline/formula fields", () => {
    expect(decimalToStroops("9007199254740993.1234567")).toBe("90071992547409931234567")
    expect(formatStroops("-12345678")).toBe("-1.2345678")
    expect(() => decimalToStroops("1e10")).toThrow()
    expect(() => decimalToStroops("0.00000001")).toThrow()
    expect(csvCell('=SUM(1,2)\n"x"')).toBe('"\'=SUM(1,2)\n""x"""')
  })
  it("binds export signatures to the wallet, network, range, policy and nonce", () => {
    const network = "Test SDF Network ; September 2015"
    const signature = key.sign(Buffer.from(`Stellar Signed Message:\n${taxExportMessage(input, network)}`)).toString("base64")
    expect(verifyTaxExport(input, network, signature)).toBe(true)
    for (const changed of [{ ...input, policy: "HIFO" as const }, { ...input, wallet: buyer }, { ...input, nonce: "differentnonce123" }]) expect(verifyTaxExport(changed, network, signature)).toBe(false)
    expect(verifyTaxExport(input, "mainnet", signature)).toBe(false)
    expect(verifyTaxExport(input, network, signature, input.exp * 1000)).toBe(false)
  })
  it("commits a single offer decision and tax evidence under overlapping writers", async () => {
    const listing = await createListing({ token_id: 1, collection_id: 1, seller_wallet: wallet, price_phaselq: 1, accepts_offers: true })
    const offer = await createOffer({ listing_id: listing.id, buyer_wallet: buyer, amount_phaselq: 2 })
    const results = await Promise.allSettled([Promise.resolve().then(() => decideOfferAtomic(listing.id, offer.id, wallet, "accept")), Promise.resolve().then(() => decideOfferAtomic(listing.id, offer.id, wallet, "accept"))])
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1)
    expect((await getListing(listing.id))?.status).toBe("sold")
    expect(getDb().prepare("SELECT * FROM tax_events").all()).toHaveLength(2)
    expect(getDb().prepare("SELECT * FROM tax_events WHERE verified=1").all()).toHaveLength(0)
  })
  it("rolls back the listing, offer and metrics if reporting evidence conflicts", async () => {
    const listing = await createListing({ token_id: 2, collection_id: 1, seller_wallet: wallet, price_phaselq: 1, accepts_offers: true })
    const offer = await createOffer({ listing_id: listing.id, buyer_wallet: buyer, amount_phaselq: 2 })
    recordTaxEvent({ ...event, eventKey: `offer:${offer.id}:buyer`, wallet: buyer, verified: false })
    resetSecurityCounters()
    expect(() => decideOfferAtomic(listing.id, offer.id, wallet, "accept")).toThrow("TAX_EVENT_CONFLICT")
    expect((await getListing(listing.id))?.status).toBe("active")
    expect(getDb().prepare("SELECT status FROM offers WHERE id=?").get(offer.id)).toMatchObject({ status: "pending" })
    expect(getDb().prepare("SELECT * FROM tax_events").all()).toHaveLength(1)
    expect(getSecurityCounter("tax_event_recorded")).toBe(0)
  })
})
