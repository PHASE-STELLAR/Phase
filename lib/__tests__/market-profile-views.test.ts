import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { Keypair } from "@stellar/stellar-sdk"
import { getCreatorProfileViewAnalytics, recordCreatorProfileView } from "@/lib/market-store"

describe("phase-100 creator profile view analytics", () => {
  beforeEach(async () => {
    process.env.PHASE_SERVER_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "phase-profile-views-"))
  })

  it("aggregates total and unique profile views", async () => {
    const creator = Keypair.random().publicKey()
    const viewer = Keypair.random().publicKey()
    await recordCreatorProfileView({ creator_wallet: creator, viewer_wallet: viewer, source: "profile" }, { force: true, now: 1_000 })
    const analytics = await recordCreatorProfileView({ creator_wallet: creator, viewer_wallet: viewer, source: "market" }, { force: true, now: 2_000 })

    assert.equal(analytics.total_views, 2)
    assert.equal(analytics.unique_viewers, 1)
    assert.equal(analytics.last_viewed_at, 2_000)
    assert.equal(analytics.sources.profile, 1)
    assert.equal(analytics.sources.market, 1)
    assert.match(analytics.viewer_hashes[0] ?? "", /^[a-f0-9]{64}$/)
    assert.notEqual(analytics.viewer_hashes[0], viewer)
  })

  it("reads analytics by creator wallet", async () => {
    const creator = Keypair.random().publicKey()
    await recordCreatorProfileView({ creator_wallet: creator, source: "dashboard" }, { force: true, now: 3_000 })
    const analytics = await getCreatorProfileViewAnalytics(creator)
    assert.equal(analytics?.total_views, 1)
    assert.equal(analytics?.sources.dashboard, 1)
  })
})
