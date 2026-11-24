// @ts-nocheck
import { describe, it, beforeAll as before, afterAll as after, beforeEach } from "vitest"
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

  it("snapshots edits with author proof, enforces If-Match 409, and appends on rollback (phase-257 / #710)", async () => {
    process.env.FEATURE_PHASE_106 = "0"
    process.env.FEATURE_PHASE_257 = "1"
    const {
      LoreVersionConflictError,
      commitLoreEdit,
      getLoreVersions,
      rollbackLoreVersion,
    } = await import("@/lib/lore-versioning")
    const { pickCopy } = await import("@/lib/phase-copy")

    const c1 = await commitLoreEdit(
      10,
      { narrative: "First dawn in the citadel.", lore_input: "dawn", author: "G123" },
      { ifMatch: "0" },
    )
    assert.equal(c1.legacyOverwrite, false)
    assert.ok(c1.entry?.author_proof)
    assert.ok(c1.entry?.etag)

    const c2 = await commitLoreEdit(
      10,
      { narrative: "Second eclipse in the citadel.", lore_input: "eclipse", author: "G456" },
      { ifMatch: c1.entry!.etag },
    )
    assert.equal(c2.legacyOverwrite, false)
    assert.equal(c2.entry?.version, 2)

    await assert.rejects(
      () =>
        commitLoreEdit(
          10,
          { narrative: "Stale edit", lore_input: "stale" },
          { ifMatch: c1.entry!.etag },
        ),
      (err: unknown) => err instanceof LoreVersionConflictError && err.status === 409 && err.currentVersion === 2,
    )

    const rb = await rollbackLoreVersion(10, 1, { author: "G123", ifMatch: c2.entry!.etag })
    assert.ok(rb)
    assert.equal(rb!.version, 3)
    assert.equal(rb!.rolled_back_from, 1)
    assert.equal(rb!.narrative, "First dawn in the citadel.")

    const history = await getLoreVersions(10)
    assert.equal(history.length, 3)
    assert.equal(history[1]!.narrative, "Second eclipse in the citadel.")

    assert.ok(pickCopy("en").loreVersioning.conflictError.includes("409"))
    assert.ok(pickCopy("es").loreVersioning.conflictError.includes("409"))

    process.env.FEATURE_PHASE_257 = "0"
    const legacy = await commitLoreEdit(10, { narrative: "Legacy", lore_input: "legacy" })
    assert.equal(legacy.legacyOverwrite, true)
    assert.equal(legacy.entry, null)
    process.env.FEATURE_PHASE_106 = "1"
  })
})

