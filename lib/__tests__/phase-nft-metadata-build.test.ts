import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { PhaseTokenMetadataJsonSchema } from "@/lib/phase-nft-metadata-build"

describe("SEP-50 token metadata schema", () => {
  const base = {
    name: "Phase Artifact #1",
    description: "Forged on Soroban via x402 AI Protocol",
    image: "https://www.phasee.xyz/og-phase.png",
    external_url: "https://www.phasee.xyz/chamber",
    attributes: [
      { trait_type: "token_id", value: 1, display_type: "number" as const },
      { trait_type: "network", value: "stellar-testnet" },
    ],
    collectionId: null,
  }

  it("accepts a well-formed no-collection payload", () => {
    const result = PhaseTokenMetadataJsonSchema.safeParse(base)
    assert.equal(result.success, true)
  })

  it("accepts an ipfs:// image URI", () => {
    const result = PhaseTokenMetadataJsonSchema.safeParse({
      ...base,
      image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    })
    assert.equal(result.success, true)
  })

  it("rejects collectionId: 0 — the codebase convention for 'no collection' is null, not 0", () => {
    const result = PhaseTokenMetadataJsonSchema.safeParse({ ...base, collectionId: 0 })
    assert.equal(result.success, false)
  })

  it("rejects a non-https, non-ipfs image URI", () => {
    const result = PhaseTokenMetadataJsonSchema.safeParse({ ...base, image: "http://insecure.example/art.png" })
    assert.equal(result.success, false)
  })

  it("rejects an empty description", () => {
    const result = PhaseTokenMetadataJsonSchema.safeParse({ ...base, description: "" })
    assert.equal(result.success, false)
  })

  it("accepts a valid collectionId with a matching attribute", () => {
    const result = PhaseTokenMetadataJsonSchema.safeParse({
      ...base,
      external_url: "https://www.phasee.xyz/chamber?collection=3",
      attributes: [{ trait_type: "collection_id", value: 3, display_type: "number" as const }, ...base.attributes],
      collectionId: 3,
    })
    assert.equal(result.success, true)
  })
})
