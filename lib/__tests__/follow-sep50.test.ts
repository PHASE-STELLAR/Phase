import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { validateSep50MetadataBeforePin } from "@/lib/follow-store"

describe("phase-118 SEP-50 metadata validation", () => {
  const validMetadata = {
    name: "Phase Artifact #1",
    description: "Forged on Soroban",
    image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    external_url: "https://phase.example/chamber",
    attributes: [
      { trait_type: "token_id", value: 1, display_type: "number" },
      { trait_type: "network", value: "stellar-testnet" },
    ],
    collectionId: 1,
  }

  it("accepts SEP-50-compatible metadata before pinning", () => {
    const result = validateSep50MetadataBeforePin(validMetadata, { force: true })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.metadata.name, validMetadata.name)
      assert.equal(result.metadata.attributes.length, 2)
    }
  })

  it("rejects invalid metadata with structured details", () => {
    const result = validateSep50MetadataBeforePin(
      { ...validMetadata, image: "http://insecure.example/art.png", extra: true },
      { force: true },
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, "SEP50_METADATA_INVALID")
      assert.ok(result.error.details)
    }
  })

  it("is feature-flag gated by default", () => {
    delete process.env.FEATURE_PHASE_118
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_118
    const result = validateSep50MetadataBeforePin(validMetadata)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, "FLAG_DISABLED")
  })
})
