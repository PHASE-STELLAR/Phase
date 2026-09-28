import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

describe("phase-110 narrative search", () => {
  let tmpDir: string

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "phase-110-"))
    process.env.PHASE_SERVER_DATA_DIR = tmpDir
    process.env.FEATURE_PHASE_110 = "1"

    const { saveWorldForCollection, saveNarrativeForToken } = await import("@/lib/narrative-world-store")
    await saveWorldForCollection(1, { world_name: "Aetherfall", world_prompt: "Sky realm", narrator_tone: "epic" })
    await saveWorldForCollection(2, { world_name: "Underdrift", world_prompt: "Sunken city", narrator_tone: "enigmatic" })
    await saveNarrativeForToken(101, { narrative: "A lone knight guards the Aetherfall gate.", collection_id: 1, lore_input: "knight" })
    await saveNarrativeForToken(102, { narrative: "Merchants trade rare relics in Underdrift.", collection_id: 2, lore_input: "merchants" })
  })
  after(async () => {
    process.env.FEATURE_PHASE_110 = ""
    delete process.env.PHASE_SERVER_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("finds a narrative by entity (token id)", async () => {
    const { searchNarratives } = await import("@/lib/narrative-search")
    const results = await searchNarratives({ entity: 101 })
    assert.equal(results.length, 1)
    assert.equal(results[0]!.tokenId, 101)
  })

  it("finds narratives by location (world name substring)", async () => {
    const { searchNarratives } = await import("@/lib/narrative-search")
    const results = await searchNarratives({ location: "under" })
    assert.equal(results.length, 1)
    assert.equal(results[0]!.worldName, "Underdrift")
  })

  it("finds narratives by free text", async () => {
    const { searchNarratives } = await import("@/lib/narrative-search")
    const results = await searchNarratives({ text: "relics" })
    assert.equal(results.length, 1)
    assert.equal(results[0]!.tokenId, 102)
  })

  it("returns no results for a non-matching query", async () => {
    const { searchNarratives } = await import("@/lib/narrative-search")
    const results = await searchNarratives({ text: "does-not-exist" })
    assert.equal(results.length, 0)
  })
})
