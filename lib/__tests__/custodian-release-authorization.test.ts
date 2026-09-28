import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { isCustodianReleaseAuthorized } from "@/lib/phase-protocol"

describe("custodian-release multi-claim guard", () => {
  it("authorizes when the recipient's on-chain phase artifact matches the requested tokenId", () => {
    assert.equal(isCustodianReleaseAuthorized({ tokenId: 42 }, 42), true)
  })

  it("rejects when the recipient phased a different tokenId", () => {
    assert.equal(isCustodianReleaseAuthorized({ tokenId: 7 }, 42), false)
  })

  it("rejects when the recipient has no on-chain phase artifact at all", () => {
    assert.equal(isCustodianReleaseAuthorized(null, 42), false)
  })
})
