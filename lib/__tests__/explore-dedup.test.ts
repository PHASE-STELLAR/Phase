import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { assetContentHash, dedupeExploreItems, type ExploreItem } from "@/lib/explore-domain"

const baseItem: ExploreItem = {
  tokenId: 1,
  name: "One",
  image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  collectionId: null,
  ownerTruncated: "GAAAAA...AAAA",
}

describe("phase-127 content-hash deduplication", () => {
  beforeEach(() => {
    process.env.FEATURE_PHASE_127 = "1"
  })

  it("marks repeated assets with the first token id", () => {
    const items = dedupeExploreItems([
      baseItem,
      { ...baseItem, tokenId: 2, name: "Two", image: baseItem.image.toUpperCase() },
      { ...baseItem, tokenId: 3, name: "Three", image: "ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" },
    ])

    assert.equal(items[0]?.duplicateOfTokenId, undefined)
    assert.equal(items[1]?.duplicateOfTokenId, 1)
    assert.equal(items[2]?.duplicateOfTokenId, undefined)
    assert.equal(items[0]?.contentHash, items[1]?.contentHash)
  })

  it("does not hash empty image values", () => {
    assert.equal(assetContentHash({ image: " " }), null)
  })
})
