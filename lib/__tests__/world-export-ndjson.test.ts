/**
 * #286 — renderWorldExportNdjson: NDJSON serialisation for world exports.
 *
 * Verifies that the helper produces well-formed NDJSON (one JSON object per
 * line, trailing newline) so the export route can set Content-Type:
 * application/x-ndjson correctly instead of application/json.
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { renderWorldExportNdjson } from "@/lib/narrative-world-store"
import type { WorldExportSnapshot } from "@/lib/narrative-world-store"

function makeSnapshot(overrides: Partial<WorldExportSnapshot> = {}): WorldExportSnapshot {
  return {
    collection_id: 42,
    world_name: "Aetherfall",
    world_prompt: "A drifting sky-realm above the clouds.",
    created_at: 1_700_000_000_000,
    narratives: [
      { token_id: 1, narrative: "The spire hums.", lore_input: "ancient tower", generated_at: 1_700_000_001_000 },
      { token_id: 2, narrative: "Winds carry secrets.", lore_input: "cursed wind", generated_at: 1_700_000_002_000 },
    ],
    ...overrides,
  }
}

describe("renderWorldExportNdjson (#286)", () => {
  it("produces one JSON object per line", () => {
    const output = renderWorldExportNdjson(makeSnapshot())
    const lines = output.trimEnd().split("\n")
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `line is not valid JSON: ${line}`)
    }
  })

  it("first line is the metadata header (not a narrative)", () => {
    const output = renderWorldExportNdjson(makeSnapshot())
    const [headerLine] = output.split("\n")
    const header = JSON.parse(headerLine!)
    assert.equal(header.collection_id, 42)
    assert.equal(header.world_name, "Aetherfall")
    assert.equal(header.narrative_count, 2)
    assert.ok(!("token_id" in header), "first line must not be a narrative")
  })

  it("subsequent lines are narrative records in token_id order", () => {
    const output = renderWorldExportNdjson(makeSnapshot())
    const lines = output.trimEnd().split("\n")
    const narrativeLines = lines.slice(1)
    assert.equal(narrativeLines.length, 2)
    const first = JSON.parse(narrativeLines[0]!)
    const second = JSON.parse(narrativeLines[1]!)
    assert.equal(first.token_id, 1)
    assert.equal(second.token_id, 2)
  })

  it("output ends with a trailing newline (NDJSON convention)", () => {
    const output = renderWorldExportNdjson(makeSnapshot())
    assert.ok(output.endsWith("\n"), "NDJSON output must end with \\n")
  })

  it("total line count equals 1 header + narrative count", () => {
    const snapshot = makeSnapshot()
    const output = renderWorldExportNdjson(snapshot)
    const lines = output.trimEnd().split("\n")
    assert.equal(lines.length, 1 + snapshot.narratives.length)
  })

  it("handles a snapshot with zero narratives", () => {
    const output = renderWorldExportNdjson(makeSnapshot({ narratives: [] }))
    const lines = output.trimEnd().split("\n")
    assert.equal(lines.length, 1)
    const header = JSON.parse(lines[0]!)
    assert.equal(header.narrative_count, 0)
  })

  it("narrator_tone is null in header when absent from snapshot", () => {
    const output = renderWorldExportNdjson(makeSnapshot({ narrator_tone: undefined }))
    const header = JSON.parse(output.split("\n")[0]!)
    assert.equal(header.narrator_tone, null)
  })

  it("each narrative line contains token_id, narrative, lore_input, generated_at", () => {
    const output = renderWorldExportNdjson(makeSnapshot())
    const narrativeLine = JSON.parse(output.split("\n")[1]!)
    assert.ok("token_id" in narrativeLine)
    assert.ok("narrative" in narrativeLine)
    assert.ok("lore_input" in narrativeLine)
    assert.ok("generated_at" in narrativeLine)
  })
})
