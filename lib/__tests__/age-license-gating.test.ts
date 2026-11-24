import { describe, it, beforeEach, afterEach } from "vitest"
import * as assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "phase-gating-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_216 = "1"
  process.env.FEATURE_PHASE_164 = "1"
  process.env.PHASE_VIEWER_AGE_GATE = "21+"
  process.env.PHASE_CLAIM_AGE_GATE = "18+"
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_216
  delete process.env.FEATURE_PHASE_164
  delete process.env.PHASE_VIEWER_AGE_GATE
  delete process.env.PHASE_CLAIM_AGE_GATE
})

describe("phase-216 age gate", () => {
  it("computes conservative bands", async () => {
    const { bandFromBirthYear, meetsAgeGate } = await import("@/lib/age-gate")
    assert.equal(bandFromBirthYear(1980, 2026), "21+")
    assert.equal(bandFromBirthYear(2005, 2026), "18+")
    assert.equal(bandFromBirthYear(2015, 2026), "under-18")
    assert.equal(meetsAgeGate("18+", "21+"), false)
    assert.equal(meetsAgeGate("21+", "18+"), true)
    assert.equal(meetsAgeGate(null, "none"), true)
  })

  it("returns 451 for an unverified viewer and audits the decision", async () => {
    const { enforceAgeGate216, AgeRestrictedError, configuredAgeGate } = await import("@/lib/age-gate-216")
    const { listGatingDecisions } = await import("@/lib/gating-audit")
    assert.equal(configuredAgeGate("viewer"), "21+")

    await assert.rejects(
      enforceAgeGate216("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ", "viewer"),
      (error: unknown) => error instanceof AgeRestrictedError && error.status === 451,
    )
    const decisions = await listGatingDecisions("age_gate.viewer")
    assert.equal(decisions[0].decision, "denied")
  })

  it("allows a declared 21+ viewer and is a no-op when the flag is off", async () => {
    const { declareAge } = await import("@/lib/age-gate")
    const { enforceAgeGate216 } = await import("@/lib/age-gate-216")
    const wallet = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    await declareAge(wallet, 1980)
    assert.equal(await enforceAgeGate216(wallet, "viewer"), "allowed")

    delete process.env.FEATURE_PHASE_216
    assert.equal(await enforceAgeGate216("GOTHER", "claim"), "not-configured")
    process.env.FEATURE_PHASE_216 = "1"
  })
})

describe("phase-216 license revocation and CSV", () => {
  async function seedAttestation(collectionId: number) {
    const { updateStore } = await import("@/lib/json-store")
    await updateStore<Record<string, unknown>>("licenseAttestations", (store) => {
      store[String(collectionId)] = {
        wallet: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        collection_id: collectionId,
        rights_basis: "licensed",
        evidence_cid: "bafyevidence",
        issued_at: 1_700_000_000,
        nonce: randomUUID(),
        signature: "c2lnbmF0dXJl",
        recorded_at: 1_700_000_001,
      }
    })
  }

  it("surfaces active then revoked license metadata", async () => {
    const { getLicenseMetadata, revokeLicense } = await import("@/lib/license-revocation")
    await seedAttestation(42)
    assert.equal((await getLicenseMetadata(42)).status, "active")
    assert.equal((await getLicenseMetadata(42)).rights_basis, "licensed")

    await revokeLicense(42, "GADMIN", "rights holder request")
    const revoked = await getLicenseMetadata(42)
    assert.equal(revoked.status, "revoked")
    assert.equal(revoked.rights_basis, "licensed")
    assert.equal(typeof revoked.revoked_at, "number")
  })

  it("cascades revocation to active listings within one call", async () => {
    const { getDb } = await import("@/lib/sqlite-db")
    const db = getDb()
    db.prepare(
      `INSERT INTO listings (id, token_id, collection_id, seller_wallet, price_phaselq, accepts_offers, listed_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("listing-1", 7, 43, "GSELLER", 100, 0, Date.now(), "active")
    await seedAttestation(43)

    const { revokeLicense } = await import("@/lib/license-revocation")
    const result = await revokeLicense(43, "GADMIN", "complaint")
    assert.equal(result.delisted, 1)
    const row = db.prepare("SELECT status FROM listings WHERE id = ?").get("listing-1") as { status: string }
    assert.equal(row.status, "cancelled")

    const { listGatingDecisions } = await import("@/lib/gating-audit")
    assert.equal((await listGatingDecisions("license.cascade")).length, 1)
  })

  it("carries the license field in bulk CSV only when the flag is on", async () => {
    const { generateCSVTemplate, exportListingsWithLicenseToCSV } = await import("@/lib/bulk-listing")
    assert.match(generateCSVTemplate(), /license_status/)

    await seedAttestation(44)
    const csv = await exportListingsWithLicenseToCSV([{ token_id: 9, collection_id: 44 }])
    assert.match(csv, /rights_basis/)
    assert.match(csv, /licensed/)
    assert.match(csv, /"active"/)

    delete process.env.FEATURE_PHASE_216
    assert.doesNotMatch(generateCSVTemplate(), /license_status/)
    process.env.FEATURE_PHASE_216 = "1"
  })
})
