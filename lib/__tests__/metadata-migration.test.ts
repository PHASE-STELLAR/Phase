import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { migrateMetadataPayload, batchMigrateMetadataPayloads, CURRENT_METADATA_VERSION } from "@/lib/metadata-migration"

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

