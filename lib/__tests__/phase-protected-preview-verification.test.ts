/**
 * Module #26: client-side verification for PhaseProtectedPreview.
 * Regression guard for app/explore/page.tsx previously hardcoding
 * chainVerified={false}, which permanently disabled the HD/verified state.
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { resolvePhaseProtectedPreviewVerified } from "@/components/phase-protected-preview"
import { truncateAddress } from "@/lib/explore-domain"

const OWNER = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV"
const OTHER = "GZYXWVUTSRQPONMLKJIHGFEDCBA765432ZYXWVUTSRQPONMLKJIHGFE"

describe("resolvePhaseProtectedPreviewVerified", () => {
  it("defers to an explicit chainVerified result when provided", () => {
    assert.equal(resolvePhaseProtectedPreviewVerified(true, undefined, null), true)
    assert.equal(resolvePhaseProtectedPreviewVerified(false, truncateAddress(OWNER), OWNER), false)
  })

  it("verifies when the truncated owner matches the connected viewer", () => {
    const ownerTruncated = truncateAddress(OWNER)
    assert.equal(resolvePhaseProtectedPreviewVerified(undefined, ownerTruncated, OWNER), true)
  })

  it("does not verify a different viewer wallet", () => {
    const ownerTruncated = truncateAddress(OWNER)
    assert.equal(resolvePhaseProtectedPreviewVerified(undefined, ownerTruncated, OTHER), false)
  })

  it("does not verify with no wallet connected", () => {
    const ownerTruncated = truncateAddress(OWNER)
    assert.equal(resolvePhaseProtectedPreviewVerified(undefined, ownerTruncated, null), false)
    assert.equal(resolvePhaseProtectedPreviewVerified(undefined, ownerTruncated, undefined), false)
  })

  it("does not verify when ownerTruncated is missing", () => {
    assert.equal(resolvePhaseProtectedPreviewVerified(undefined, undefined, OWNER), false)
  })
})
