/**
 * #239 — streaming NDJSON world export with cursor pagination.
 *
 * Verifies that the export path pages through narratives in bounded batches of
 * 50 (never materialising every record at once) and that a ?cursor= resume
 * continues exactly where the previous page stopped.
 *
 * Run: npx tsx --test lib/__tests__/world-export-stream.test.ts
 */
import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// serverDataJsonPath() resolves the data root per call, so pointing it at a temp
// dir here keeps the seeded fixture isolated from the real .data sidecars.
const dataDir = await mkdtemp(path.join(tmpdir(), "phase-world-export-"))
process.env.PHASE_SERVER_DATA_DIR = dataDir

import {
  getWorldNarrativesPage,
  countWorldNarratives,
  streamWorldExportNdjson,
  WORLD_EXPORT_PAGE_SIZE,
} from "@/lib/narrative-world-store"

const COLLECTION_ID = 7
const TOTAL = 120

async function seed(): Promise<void> {
  const narratives: Record<string, unknown> = {}
  for (let i = 1; i <= TOTAL; i++) {
    narratives[String(i)] = {
      narrative: `lore ${i}`,
      collection_id: COLLECTION_ID,
      lore_input: `input ${i}`,
      generated_at: 1_700_000_000_000 + i,
    }
  }
  // A second collection must never leak into the export.
  narratives["999"] = {
    narrative: "other world",
    collection_id: 999,
    lore_input: "other",
    generated_at: 1,
  }
  await writeFile(
    path.join(dataDir, "world-narratives.json"),
    JSON.stringify(narratives),
    "utf8",
  )
  await writeFile(
    path.join(dataDir, "world-collections.json"),
    JSON.stringify({
      [String(COLLECTION_ID)]: {
        world_name: "Aetherfall",
        world_prompt: "A drifting sky-realm.",
        created_at: 1_700_000_000_000,
      },
    }),
    "utf8",
  )
}

describe("world export cursor pagination (#239)", () => {
  before(seed)
  after(() => rm(dataDir, { recursive: true, force: true }))

  it("pages in batches of 50", async () => {
    assert.equal(WORLD_EXPORT_PAGE_SIZE, 50)
    const first = await getWorldNarrativesPage(COLLECTION_ID)
    assert.equal(first.items.length, 50)
    assert.equal(first.items[0].token_id, 1)
    assert.equal(first.nextCursor, 50)
  })

  it("resumes from the cursor without repeating or skipping records", async () => {
    const second = await getWorldNarrativesPage(COLLECTION_ID, { cursor: 50 })
    assert.equal(second.items.length, 50)
    assert.equal(second.items[0].token_id, 51)
    assert.equal(second.nextCursor, 100)

    const third = await getWorldNarrativesPage(COLLECTION_ID, { cursor: 100 })
    assert.equal(third.items.length, 20)
    assert.equal(third.nextCursor, null)
  })

  it("clamps an oversized limit to the page size", async () => {
    const page = await getWorldNarrativesPage(COLLECTION_ID, { limit: 5000 })
    assert.equal(page.items.length, WORLD_EXPORT_PAGE_SIZE)
  })

  it("counts narratives for the collection only", async () => {
    assert.equal(await countWorldNarratives(COLLECTION_ID), TOTAL)
    assert.equal(await countWorldNarratives(999), 1)
  })

  it("streams a header plus one line per narrative", async () => {
    const lines: string[] = []
    for await (const line of streamWorldExportNdjson(COLLECTION_ID)) {
      lines.push(line)
    }
    assert.equal(lines.length, TOTAL + 1)
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `invalid JSON line: ${line}`)
    }
    const header = JSON.parse(lines[0])
    assert.equal(header.world_name, "Aetherfall")
    assert.equal(header.narrative_count, TOTAL)
    assert.equal(JSON.parse(lines[1]).token_id, 1)
    assert.equal(JSON.parse(lines[lines.length - 1]).token_id, TOTAL)
  })

  it("streams from a cursor and stops at the collection end", async () => {
    const lines: string[] = []
    for await (const line of streamWorldExportNdjson(COLLECTION_ID, { cursor: 118 })) {
      lines.push(line)
    }
    assert.equal(lines.length, 3)
    assert.equal(JSON.parse(lines[0]).narrative_count, TOTAL)
    assert.equal(JSON.parse(lines[1]).token_id, 119)
    assert.equal(JSON.parse(lines[2]).token_id, 120)
  })

  it("yields nothing for an unknown collection", async () => {
    const lines: string[] = []
    for await (const line of streamWorldExportNdjson(4242)) lines.push(line)
    assert.equal(lines.length, 0)
  })
})
