/**
 * Issue #733: Quest expiry boundary tests and snapshot integrity tests.
 *
 * Verifies:
 * - A claim one second after expiry is rejected
 * - A tampered snapshot is rejected
 * - Boundaries are consistently inclusive at start, exclusive at end
 *
 * Run: npx tsx tests/quest-snapshot-integrity.test.ts
 */
import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import {
  QuestClaimError,
  computeQuestExpiryWindow,
  computeSnapshotHash,
  verifySnapshotIntegrity,
  validateQuestClaim,
  type QuestExpiryWindow,
  type QuestSnapshotEntry,
} from "@/lib/quest-snapshot"

describe("Issue #733: Quest expiry windows and snapshot integrity", () => {
  before(() => {
    process.env.FEATURE_PHASE_275 = "1"
  })
  after(() => {
    process.env.FEATURE_PHASE_275 = ""
  })

  const window: QuestExpiryWindow = {
    createdAt: 10_000,
    ttlMs: 1_000,
    graceMs: 500,
  }

  describe("expiry boundaries (INCLUSIVE start, EXCLUSIVE end)", () => {
    it("is active at creation time (inclusive)", () => {
      const r = computeQuestExpiryWindow(window, 10_000)
      assert.equal(r.state, "active")
    })

    it("is active one ms before expiry", () => {
      const r = computeQuestExpiryWindow(window, 10_999)
      assert.equal(r.state, "active")
    })

    it("transitions to grace at expiry (inclusive start of grace)", () => {
      const r = computeQuestExpiryWindow(window, 11_000)
      assert.equal(r.state, "grace")
    })

    it("is in grace one ms before grace ends", () => {
      const r = computeQuestExpiryWindow(window, 11_499)
      assert.equal(r.state, "grace")
    })

    it("is expired at grace end (exclusive)", () => {
      const r = computeQuestExpiryWindow(window, 11_500)
      assert.equal(r.state, "expired")
    })

    it("is expired one second after expiry", () => {
      const r = computeQuestExpiryWindow(window, 11_501)
      assert.equal(r.state, "expired")
    })

    it("is expired well after expiry", () => {
      const r = computeQuestExpiryWindow(window, 50_000)
      assert.equal(r.state, "expired")
    })
  })

  describe("claim validation rejects late and early claims", () => {
    it("rejects a claim one second after expiry", () => {
      const result = validateQuestClaim(window, 11_501)
      assert.equal(result.ok, false)
      assert.ok(result.error instanceof QuestClaimError)
      assert.equal(result.error.code, "CLAIM_EXPIRED")
    })

    it("rejects a claim at grace end (exclusive)", () => {
      const result = validateQuestClaim(window, 11_500)
      assert.equal(result.ok, false)
      assert.ok(result.error instanceof QuestClaimError)
      assert.equal(result.error.code, "CLAIM_EXPIRED")
    })

    it("rejects an early claim (before creation)", () => {
      const result = validateQuestClaim(window, 9_999)
      assert.equal(result.ok, false)
      assert.ok(result.error instanceof QuestClaimError)
      assert.equal(result.error.code, "CLAIM_TOO_EARLY")
    })

    it("accepts a claim during active period", () => {
      const result = validateQuestClaim(window, 10_500)
      assert.equal(result.ok, true)
      assert.equal(result.expiryState, "active")
    })

    it("accepts a claim during grace period", () => {
      const result = validateQuestClaim(window, 11_200)
      assert.equal(result.ok, true)
      assert.equal(result.expiryState, "grace")
    })

    it("accepts a claim at creation time (inclusive)", () => {
      const result = validateQuestClaim(window, 10_000)
      assert.equal(result.ok, true)
      assert.equal(result.expiryState, "active")
    })
  })

  describe("snapshot integrity", () => {
    const snapshot: QuestSnapshotEntry = {
      wallet: "GABC123",
      progress: {
        quest_connect_wallet: { completed: true, progressPct: 100, requirementText: "Connect wallet" },
        quest_first_collection: { completed: false, progressPct: 0, requirementText: "First collection" },
        quest_first_settle: { completed: false, progressPct: 0, requirementText: "First settle" },
        quest_first_world: { completed: false, progressPct: 0, requirementText: "First world" },
        quest_three_collections: { completed: false, progressPct: 0, requirementText: "Three collections" },
      },
      snapshotAt: 10_000,
    }

    it("computes a deterministic hash for a snapshot", () => {
      const hash = computeSnapshotHash(snapshot)
      assert.equal(typeof hash, "string")
      assert.equal(hash.length, 64) // SHA-256 hex
    })

    it("verifies a snapshot with the correct hash", () => {
      const hash = computeSnapshotHash(snapshot)
      const result = verifySnapshotIntegrity(snapshot, hash)
      assert.equal(result.ok, true)
    })

    it("rejects a tampered snapshot", () => {
      const hash = computeSnapshotHash(snapshot)
      const tampered: QuestSnapshotEntry = {
        ...snapshot,
        progress: {
          ...snapshot.progress,
          quest_first_collection: { completed: true, progressPct: 100, requirementText: "First collection" },
        },
      }
      const result = verifySnapshotIntegrity(tampered, hash)
      assert.equal(result.ok, false)
      assert.ok(result.error instanceof QuestClaimError)
      assert.equal(result.error.code, "SNAPSHOT_TAMPERED")
    })

    it("rejects a claim with a tampered snapshot via validateQuestClaim", () => {
      const hash = computeSnapshotHash(snapshot)
      const tampered: QuestSnapshotEntry = {
        ...snapshot,
        progress: {
          ...snapshot.progress,
          quest_first_collection: { completed: true, progressPct: 100, requirementText: "First collection" },
        },
      }
      const result = validateQuestClaim(window, 10_500, tampered, hash)
      assert.equal(result.ok, false)
      assert.ok(result.error instanceof QuestClaimError)
      assert.equal(result.error.code, "SNAPSHOT_TAMPERED")
    })

    it("rejects a claim when a hash is expected but no snapshot is provided", () => {
      const result = validateQuestClaim(window, 10_500, undefined, "somehash")
      assert.equal(result.ok, false)
      assert.ok(result.error instanceof QuestClaimError)
      assert.equal(result.error.code, "SNAPSHOT_MISSING")
    })
  })
})
