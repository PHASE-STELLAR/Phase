import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { after, beforeEach, describe, it } from "node:test"
import { NextRequest } from "next/server"
import { POST } from "@/app/api/claim-bounty/route"
import {
  BountyClaimError,
  claimBountyWithSnapshot,
  isBountyClaimEnabled,
} from "@/lib/bounty-claim"
import { pickCopy } from "@/lib/phase-copy"
import { saveVersionedQuestSnapshot, type QuestId, type QuestProgress } from "@/lib/quest-snapshot"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const ORIGINAL_ENV = { ...process.env }
const WALLET_A = "G" + "A".repeat(55)
const WALLET_B = "G" + "B".repeat(55)

function makeProgress(overrides: Partial<Record<QuestId, QuestProgress>> = {}): Record<QuestId, QuestProgress> {
  return {
    quest_connect_wallet: { completed: true, progressPct: 100, requirementText: "ok" },
    quest_first_collection: { completed: false, progressPct: 0, requirementText: "pending" },
    quest_first_settle: { completed: false, progressPct: 0, requirementText: "pending" },
    quest_first_world: { completed: false, progressPct: 0, requirementText: "pending" },
    quest_three_collections: { completed: false, progressPct: 0, requirementText: "pending" },
    ...overrides,
  }
}

describe("bounty-claim (phase-254 / #705)", () => {
  beforeEach(() => {
    process.env.PHASE_SERVER_DATA_DIR = path.join(
      os.tmpdir(),
      `phase-bounty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    process.env.NEXT_PUBLIC_FEATURE_PHASE_254 = "1"
    process.env.FEATURE_PHASE_254 = "1"
    resetSecurityCounters()
  })

  after(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it("returns 404 on claim route when phase-254 flag is off", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_254
    delete process.env.FEATURE_PHASE_254
    assert.equal(isBountyClaimEnabled(), false)

    const req = new NextRequest("http://localhost/api/claim-bounty", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bountyId: "quest_connect_wallet", snapshotVersion: 1 }),
    })
    const res = await POST(req)
    assert.equal(res.status, 404)
  })

  it("rejects second claim for same wallet and bounty (409 ALREADY_CLAIMED)", async () => {
    const snap = await saveVersionedQuestSnapshot(WALLET_A, makeProgress())
    const first = await claimBountyWithSnapshot({
      sessionWallet: WALLET_A,
      bountyId: "quest_connect_wallet",
      snapshotVersion: snap.version!,
      snapshotHash: snap.snapshotHash,
    })
    assert.equal(first.bountyId, "quest_connect_wallet")
    assert.equal(getSecurityCounter("bounty_claim_succeeded"), 1)

    await assert.rejects(
      () =>
        claimBountyWithSnapshot({
          sessionWallet: WALLET_A,
          bountyId: "quest_connect_wallet",
          snapshotVersion: snap.version!,
          snapshotHash: snap.snapshotHash,
        }),
      (err: unknown) =>
        err instanceof BountyClaimError &&
        err.code === "ALREADY_CLAIMED" &&
        err.status === 409,
    )
    assert.equal(getSecurityCounter("bounty_claim_duplicate"), 1)
  })

  it("rejects stale snapshot version or hash (409 STALE_SNAPSHOT)", async () => {
    await saveVersionedQuestSnapshot(WALLET_A, makeProgress())
    const snap2 = await saveVersionedQuestSnapshot(WALLET_A, makeProgress())
    assert.equal(snap2.version, 2)

    await assert.rejects(
      () =>
        claimBountyWithSnapshot({
          sessionWallet: WALLET_A,
          bountyId: "quest_connect_wallet",
          snapshotVersion: 1,
        }),
      (err: unknown) =>
        err instanceof BountyClaimError &&
        err.code === "STALE_SNAPSHOT" &&
        err.status === 409,
    )
    assert.equal(getSecurityCounter("bounty_claim_stale_snapshot"), 1)
  })

  it("verifies eligibility from server snapshot and rejects wallet mismatch", async () => {
    const snap = await saveVersionedQuestSnapshot(WALLET_A, makeProgress())

    await assert.rejects(
      () =>
        claimBountyWithSnapshot({
          sessionWallet: WALLET_A,
          bountyId: "quest_first_collection",
          snapshotVersion: snap.version!,
        }),
      (err: unknown) =>
        err instanceof BountyClaimError &&
        err.code === "NOT_ELIGIBLE" &&
        err.status === 403,
    )

    await assert.rejects(
      () =>
        claimBountyWithSnapshot({
          sessionWallet: WALLET_A,
          claimedWallet: WALLET_B,
          bountyId: "quest_connect_wallet",
          snapshotVersion: snap.version!,
        }),
      (err: unknown) =>
        err instanceof BountyClaimError &&
        err.code === "WALLET_MISMATCH" &&
        err.status === 403,
    )
  })

  it("concurrent claims yield one winner and ordered 409s", async () => {
    const snap = await saveVersionedQuestSnapshot(WALLET_A, makeProgress())

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        claimBountyWithSnapshot({
          sessionWallet: WALLET_A,
          bountyId: "quest_connect_wallet",
          snapshotVersion: snap.version!,
          snapshotHash: snap.snapshotHash,
        }),
      ),
    )

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    )

    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 4)
    for (const rej of rejected) {
      assert.ok(rej.reason instanceof BountyClaimError)
      assert.equal(rej.reason.code, "ALREADY_CLAIMED")
      assert.equal(rej.reason.status, 409)
    }
    assert.equal(getSecurityCounter("bounty_claim_succeeded"), 1)
    assert.equal(getSecurityCounter("bounty_claim_duplicate"), 4)
  })

  it("provides EN and ES bountyClaim copy", () => {
    const en = pickCopy("en").bountyClaim
    const es = pickCopy("es").bountyClaim
    assert.ok(en.claimSuccess.length > 0 && es.claimSuccess.length > 0)
    assert.notEqual(en.alreadyClaimed, es.alreadyClaimed)
  })
})
