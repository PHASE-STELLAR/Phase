import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import {
  checkWorldConflict,
  compareVectorClocks,
  incrementVectorClock,
  normalizeVectorClock,
} from "@/lib/world-conflict"
import type { WorldCollectionData } from "@/lib/narrative-world-store"

describe("phase-105 world conflict detection", () => {
  before(() => {
    process.env.FEATURE_PHASE_105 = "1"
  })
  after(() => {
    process.env.FEATURE_PHASE_105 = ""
  })

  const world: WorldCollectionData = {
    world_name: "Aetherfall",
    world_prompt: "A drifting sky-realm.",
    created_at: 1,
    version: 3,
  }

  it("no conflict when world does not exist yet", () => {
    const res = checkWorldConflict(null, 0)
    assert.equal(res.conflict, false)
  })

  it("no conflict when client omits expected_version (legacy callers)", () => {
    const res = checkWorldConflict(world, undefined)
    assert.equal(res.conflict, false)
  })

  it("no conflict when client version matches server version", () => {
    const res = checkWorldConflict(world, 3)
    assert.equal(res.conflict, false)
  })

  it("reports a conflict when client version is stale", () => {
    const res = checkWorldConflict(world, 2)
    assert.equal(res.conflict, true)
    if (res.conflict) {
      assert.equal(res.serverVersion, 3)
      assert.equal(res.clientVersion, 2)
      assert.equal(res.current.world_name, "Aetherfall")
    }
  })

  it("never reports a conflict when the flag is off", () => {
    process.env.FEATURE_PHASE_105 = "0"
    const res = checkWorldConflict(world, 2)
    assert.equal(res.conflict, false)
    process.env.FEATURE_PHASE_105 = "1"
  })

  const clocked: WorldCollectionData = { ...world, vector_clock: { alice: 2, bob: 1 } }

  it("normalizes Map, object and entries-array clocks to the same shape", () => {
    const fromObject = normalizeVectorClock({ alice: 2, bob: 1 })
    const fromMap = normalizeVectorClock(new Map([["bob", 1], ["alice", 2]]))
    const fromArray = normalizeVectorClock([["alice", 2], ["bob", 1]])
    assert.deepEqual(fromMap, fromObject)
    assert.deepEqual(fromArray, fromObject)
  })

  it("drops zero counters and keeps the max of duplicate entries", () => {
    assert.deepEqual(normalizeVectorClock({ alice: 0 }), {})
    assert.deepEqual(normalizeVectorClock([["alice", 1], ["alice", 3]]), { alice: 3 })
  })

  it("rejects malformed clocks", () => {
    assert.equal(normalizeVectorClock(null), null)
    assert.equal(normalizeVectorClock("alice:1"), null)
    assert.equal(normalizeVectorClock({ alice: -1 }), null)
    assert.equal(normalizeVectorClock({ alice: 1.5 }), null)
    assert.equal(normalizeVectorClock([["alice"]]), null)
    assert.equal(normalizeVectorClock([[1, 1]]), null)
  })

  it("orders vector clocks", () => {
    assert.equal(compareVectorClocks({ a: 1 }, { a: 1 }), "equal")
    assert.equal(compareVectorClocks({ a: 1 }, { a: 2 }), "before")
    assert.equal(compareVectorClocks({ a: 2, b: 1 }, { a: 2 }), "after")
    assert.equal(compareVectorClocks({ a: 2 }, { b: 1 }), "concurrent")
  })

  it("increments a clock stored as an entries array", () => {
    assert.deepEqual(incrementVectorClock([["alice", 2]], "alice"), { alice: 3 })
    assert.deepEqual(incrementVectorClock(undefined, "bob"), { bob: 1 })
  })

  it("no conflict when an entries-array clock matches a stored object clock", () => {
    const expected = normalizeVectorClock([["bob", 1], ["alice", 2]])!
    const res = checkWorldConflict(clocked, 3, expected)
    assert.equal(res.conflict, false)
  })

  it("no conflict when a Map clock matches a stored entries-array clock", () => {
    const stored = { ...world, vector_clock: [["alice", 2], ["bob", 1]] } as unknown as WorldCollectionData
    const expected = normalizeVectorClock(new Map([["alice", 2], ["bob", 1]]))!
    const res = checkWorldConflict(stored, undefined, expected)
    assert.equal(res.conflict, false)
  })

  it("reports a stale clock as 'before'", () => {
    const res = checkWorldConflict(clocked, undefined, { alice: 2 })
    assert.equal(res.conflict, true)
    if (res.conflict) {
      assert.equal(res.order, "before")
      assert.deepEqual(res.serverVectorClock, { alice: 2, bob: 1 })
    }
  })

  it("reports a diverged clock as 'concurrent'", () => {
    const res = checkWorldConflict(clocked, undefined, { alice: 3 })
    assert.equal(res.conflict, true)
    if (res.conflict) assert.equal(res.order, "concurrent")
  })

  it("still checks version for worlds saved before vector clocks existed", () => {
    const res = checkWorldConflict(world, 2, {})
    assert.equal(res.conflict, true)
    if (res.conflict) assert.equal(res.order, "before")
  })
})
