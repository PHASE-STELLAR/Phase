import { describe, it } from "vitest"
import * as assert from "node:assert/strict"
import { migrateMetadataPayload, batchMigrateMetadataPayloads, CURRENT_METADATA_VERSION, generateMigrationManifest, computePayloadChecksum, NftMetadataV1Schema } from "@/lib/metadata-migration"

describe("phase-124 metadata migration", () => {
  const OLD_V1 = { name: "Test", description: "Old", image: "ipfs://Qm123" }
  const V2 = { version: 2 as const, name: "Test", description: "New", image: "ipfs://Qm123", external_url: "", attributes: [], collectionId: null }

  it("migrates v1 -> v2 with force flag", () => {
    const res = migrateMetadataPayload(OLD_V1, { force: true })
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.version, 2)
      assert.equal(res.migrated, true)
      assert.equal(res.data.version, CURRENT_METADATA_VERSION)
      assert.equal(res.data.name, "Test")
    }
  })

  it("passes through v2 unchanged", () => {
    const res = migrateMetadataPayload(V2, { force: true })
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.migrated, false)
  })

  it("fails when flag disabled without force", () => {
    const res = migrateMetadataPayload(OLD_V1, {})
    if (process.env.FEATURE_PHASE_124 !== "1" && process.env.NEXT_PUBLIC_FEATURE_PHASE_124 !== "1") {
      assert.equal(res.ok, false)
      if (!res.ok) assert.equal(res.error.code, "FLAG_DISABLED")
    }
  })

  it("batch migrates", () => {
    const report = batchMigrateMetadataPayloads([OLD_V1, V2], { force: true })
    assert.equal(report.total, 2)
    assert.equal(report.migrated, 1)
    assert.equal(report.alreadyCurrent, 1)
    assert.equal(report.failed, 0)
  })

  it("two-phase migration with dry-run diff, checksums, and manifest", () => {
    const raw = { name: "Artifact", description: "Desc", image: "ipfs://test" }
    const res = migrateMetadataPayload(raw, { dryRun: true, force: true })
    assert.equal(res.ok, true)
    if (res.ok) {
      const manifest = generateMigrationManifest({
        records: [{ id: 1, before: raw, after: res.data }],
        isDryRun: true,
      })
      assert.equal(manifest.isDryRun, true)
      assert.equal(manifest.records.length, 1)
      assert.equal(manifest.records[0].beforeChecksum, computePayloadChecksum(raw))
      assert.equal(manifest.records[0].afterChecksum, computePayloadChecksum(res.data))
    }
  })

  it("v1 readers can still parse additive v2 fields", () => {
    const v2 = { version: 2 as const, name: "Artifact", description: "Desc", image: "ipfs://test", external_url: "https://phase.fun", attributes: [{ trait_type: "tier", value: "gold" }], collectionId: 10 }
    const parsedV1 = NftMetadataV1Schema.safeParse(v2)
    assert.equal(parsedV1.success, true)
    if (parsedV1.success) {
      assert.equal(parsedV1.data.name, "Artifact")
    }
  })

  it("validates invalid payload", () => {
    const res = migrateMetadataPayload({ name: "" }, { force: true })
    assert.equal(res.ok, false)
  })

  it("handles null, undefined, and non-object payloads without throwing", () => {
    const resNull = migrateMetadataPayload(null, { force: true })
    assert.equal(resNull.ok, false)
    if (!resNull.ok) assert.equal(resNull.error.code, "UNSUPPORTED_VERSION")

    const resUndefined = migrateMetadataPayload(undefined, { force: true })
    assert.equal(resUndefined.ok, false)
    if (!resUndefined.ok) assert.equal(resUndefined.error.code, "UNSUPPORTED_VERSION")

    const resNum = migrateMetadataPayload(12345, { force: true })
    assert.equal(resNum.ok, false)
    if (!resNum.ok) assert.equal(resNum.error.code, "UNSUPPORTED_VERSION")
  })
})

