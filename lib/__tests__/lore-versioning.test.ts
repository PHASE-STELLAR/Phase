// @ts-nocheck
import { describe, it, before, after, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

describe("phase-106 lore versioning (spike)", () => {
  let tmpDir: string

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "phase-106-"))
    process.env.PHASE_SERVER_DATA_DIR = tmpDir
    process.env.FEATURE_PHASE_106 = "1"
  })
  after(async () => {
    process.env.FEATURE_PHASE_106 = ""
    delete process.env.PHASE_SERVER_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await rm(path.join(tmpDir, "lore-versions.json"), { force: true })
  })

  it("word-level diff marks added and removed words", async () => {
    const { diffNarrativeText } = await import("@/lib/lore-versioning")
    const diff = diffNarrativeText("the sky was calm today", "the sky was stormy today and cold")
    const removed = diff.filter((d) => d.op === "remove").flatMap((d) => d.words)
    const added = diff.filter((d) => d.op === "add").flatMap((d) => d.words)
    assert.deepEqual(removed, ["calm"])
    assert.deepEqual(added, ["stormy", "and", "cold"])
  })

  it("records sequential versions and diffs them", async () => {
    const { recordLoreVersion, getLoreVersions, diffLoreVersions } = await import("@/lib/lore-versioning")
    await recordLoreVersion(1, { narrative: "A quiet dawn over the ruins.", lore_input: "ruins" })
    await recordLoreVersion(1, { narrative: "A stormy dawn over the ruins.", lore_input: "ruins" })

    const versions = await getLoreVersions(1)
    assert.equal(versions.length, 2)
    assert.equal(versions[0]!.version, 1)
    assert.equal(versions[1]!.version, 2)

    const diff = await diffLoreVersions(1, 1, 2)
    assert.ok(diff)
    const removed = diff!.diff.filter((d) => d.op === "remove").flatMap((d) => d.words)
    const added = diff!.diff.filter((d) => d.op === "add").flatMap((d) => d.words)
    assert.deepEqual(removed, ["quiet"])
    assert.deepEqual(added, ["stormy"])
  })

  it("is a no-op when the flag is off", async () => {
    process.env.FEATURE_PHASE_106 = "0"
    const { recordLoreVersion } = await import("@/lib/lore-versioning")
    const entry = await recordLoreVersion(2, { narrative: "x", lore_input: "y" })
    assert.equal(entry, null)
    process.env.FEATURE_PHASE_106 = "1"
  })
})

