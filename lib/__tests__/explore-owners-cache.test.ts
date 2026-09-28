import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import {
  getCachedExploreOwners,
  setCachedExploreOwners,
  isExploreOwnersEntryFresh,
  clearExploreOwnersCache,
} from "@/lib/explore-owners-cache"

const CONTRACT = "CAZKRXQWXKM4UNDB5FY4XVMWDKKZJ2EFKMNFCFH3WC7SHE7RCO7HOR6L"

describe("phase-135 explore owners-scan cache", () => {
  beforeEach(() => clearExploreOwnersCache())

  it("returns null for a miss and the stored entry for a hit", () => {
    assert.equal(getCachedExploreOwners(CONTRACT, 500), null)
    setCachedExploreOwners(CONTRACT, 500, [{ id: 1, owner: "GABC" }])
    const entry = getCachedExploreOwners(CONTRACT, 500)
    assert.ok(entry)
    assert.deepEqual(entry!.owners, [{ id: 1, owner: "GABC" }])
  })

  it("scopes cache entries by scanCap independently", () => {
    setCachedExploreOwners(CONTRACT, 500, [{ id: 1, owner: "GABC" }])
    setCachedExploreOwners(CONTRACT, 1000, [{ id: 1, owner: "GABC" }, { id: 2, owner: "GDEF" }])
    assert.equal(getCachedExploreOwners(CONTRACT, 500)!.owners.length, 1)
    assert.equal(getCachedExploreOwners(CONTRACT, 1000)!.owners.length, 2)
  })

  it("treats a freshly-written entry as fresh and an old one as stale", () => {
    setCachedExploreOwners(CONTRACT, 500, [])
    const entry = getCachedExploreOwners(CONTRACT, 500)!
    assert.ok(isExploreOwnersEntryFresh(entry))
    const aged = { ...entry, cachedAt: Date.now() - 60_000 }
    assert.equal(isExploreOwnersEntryFresh(aged, 30_000), false)
  })
})
