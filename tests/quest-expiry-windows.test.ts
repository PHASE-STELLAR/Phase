/**
 * Module #52 (phase-52) — quest_expiry windows with grace-period extension.
 * Run: npx tsx tests/quest-expiry-windows.test.ts
 */
import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import {
  QuestExpiryError,
  auditQuestExpiryWiring,
  computeQuestExpiry,
  grantGracePeriodExtension,
  partitionQuestsByExpiry,
  pruneExpiredQuests,
} from "@/lib/explore-domain"

const POLICY = { ttlMs: 1_000, graceMs: 500, extensionMs: 1_000, maxExtensions: 2 }
const RECORD = { questId: "daily-signal", createdAt: 10_000 }

describe("phase-52 quest_expiry windows", () => {
  before(() => {
    process.env.FEATURE_PHASE_52 = "1"
  })
  after(() => {
    process.env.FEATURE_PHASE_52 = ""
  })

  it("walks active → grace → expired", () => {
    assert.equal(computeQuestExpiry(RECORD, POLICY, 10_500).state, "active")
    assert.equal(computeQuestExpiry(RECORD, POLICY, 11_200).state, "grace")
    assert.equal(computeQuestExpiry(RECORD, POLICY, 12_000).state, "expired")
  })

  it("a completed quest never expires", () => {
    const done = { ...RECORD, completedAt: 10_400 }
    assert.equal(computeQuestExpiry(done, POLICY, 999_999).state, "active")
  })

  it("reports remaining time and extension budget", () => {
    const status = computeQuestExpiry(RECORD, POLICY, 10_500)
    assert.equal(status.expiresAt, 11_000)
    assert.equal(status.graceUntil, 11_500)
    assert.equal(status.msRemaining, 1_000)
    assert.equal(status.extensionsRemaining, 2)
  })

  it("grants a grace-period extension that pushes expiry out", () => {
    const extended = grantGracePeriodExtension(RECORD, POLICY, 11_200)
    assert.equal(extended.extensionsGranted, 1)
    const status = computeQuestExpiry(extended, POLICY, 11_200)
    assert.equal(status.state, "active")
    assert.equal(status.expiresAt, 12_000)
  })

  it("refuses to extend past the budget", () => {
    const maxed = { ...RECORD, extensionsGranted: 2 }
    assert.throws(
      () => grantGracePeriodExtension(maxed, POLICY, 10_500),
      (e: unknown) => e instanceof QuestExpiryError && e.code === "EXTENSION_EXHAUSTED",
    )
  })

  it("refuses to revive a fully expired quest", () => {
    assert.throws(
      () => grantGracePeriodExtension(RECORD, POLICY, 50_000),
      (e: unknown) => e instanceof QuestExpiryError && e.code === "ALREADY_EXPIRED",
    )
  })

  it("partitions a batch by lifecycle state", () => {
    const records = [
      { questId: "a", createdAt: 10_000 },
      { questId: "b", createdAt: 10_800 },
      { questId: "c", createdAt: 0 },
    ]
    const parts = partitionQuestsByExpiry(records, POLICY, 11_200)
    assert.deepEqual(parts.active.map((s) => s.questId), ["b"])
    assert.deepEqual(parts.grace.map((s) => s.questId), ["a"])
    assert.deepEqual(parts.expired.map((s) => s.questId), ["c"])
  })

  it("prunes only fully expired quests from a store", () => {
    const store = [
      { id: 1, quest: { questId: "keep", createdAt: 10_900 } },
      { id: 2, quest: { questId: "drop", createdAt: 0 } },
    ]
    const { kept, removed } = pruneExpiredQuests(store, POLICY, (row) => row.quest, 11_200)
    assert.deepEqual(kept.map((r) => r.id), [1])
    assert.deepEqual(removed.map((r) => r.id), [2])
  })

  it("rejects an invalid policy with a typed error", () => {
    assert.throws(
      () => computeQuestExpiry(RECORD, { ttlMs: -1 }, 0),
      (e: unknown) => e instanceof QuestExpiryError && e.code === "VALIDATION_FAILED",
    )
  })

  it("diagnose-env wiring audit passes", () => {
    assert.equal(auditQuestExpiryWiring().ok, true)
  })
})
