import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll as after, beforeAll as before, beforeEach, describe, it } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import type { AiJsonGenerator } from "@/lib/forge/ai-pipeline"
import type { LoreDocument } from "@/lib/narrative-search"

let dataDir = ""

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-curator-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_142 = "1"
})

after(async () => {
  const { resetDbForTests } = await import("@/lib/sqlite-db")
  resetDbForTests()
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_142
  await rm(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  const { resetSecurityCounters } = await import("@/lib/security-counters")
  const { resetCostLedger } = await import("@/lib/cost-attribution-ledger")
  resetSecurityCounters()
  resetCostLedger()
})

const OWNERS = Array.from({ length: 12 }, () => Keypair.random().publicKey())

/** 16 tidal lores across 4 worlds, plus unrelated noise. */
function corpus(): LoreDocument[] {
  const docs: LoreDocument[] = []
  for (let i = 0; i < 16; i++) {
    docs.push({
      tokenId: 100 + i,
      collectionId: 1 + (i % 4),
      generatedAt: 1_000 + i,
      narrative: `The tide archive hums below the harbor. Relic ${i} remembers the drowned tide and the lantern keepers.`,
    })
  }
  for (let i = 0; i < 6; i++) {
    docs.push({
      tokenId: 300 + i,
      collectionId: 9,
      generatedAt: 500 + i,
      narrative: `A desert engine grinds sand into glass, cycle ${i}.`,
    })
  }
  return docs
}

function ownerMap(ids: number[], pick: (id: number) => string = (id) => OWNERS[id % OWNERS.length]!) {
  return new Map(ids.map((id) => [id, pick(id)]))
}

const validModel = (overrides: Partial<{ title: string; statement: string }> = {}): AiJsonGenerator => async ({ prompt }) => {
  const ids = [...prompt.matchAll(/"token_id":(\d+)/g)].map((m) => Number(m[1]))
  return {
    modelId: "test-model",
    outputChars: 400,
    json: {
      title: overrides.title ?? "Tidewrack",
      statement: overrides.statement ?? "A show about what the tide keeps.",
      walls: ids.map((id) => ({ token_id: id, text: `Wall for #${id}.` })),
    },
  }
}

describe("phase-142 retrieval primitives", () => {
  it("ranks by BM25 and drops documents without a query term", async () => {
    const { rankLoreDocuments } = await import("@/lib/narrative-search")
    const ranked = rankLoreDocuments(corpus(), ["tide"])
    assert.equal(ranked.length, 16)
    assert.ok(ranked.every((d) => d.matchedTerms.includes("tide")))
  })

  it("induces a cross-collection theme and ignores one-world vocabulary", async () => {
    const { induceThemeTerms } = await import("@/lib/narrative-search")
    const terms = induceThemeTerms(corpus().concat(corpus().slice(0, 4).map((d) => ({ ...d, tokenId: d.tokenId + 1000 }))))
    // "desert" appears 6× but only in collection 9, so it cannot seed a theme.
    assert.ok(!terms.includes("desert"))
  })

  it("accent-folds Spanish lore so 'marea' and 'maréa' are one term", async () => {
    const { tokenizeLore } = await import("@/lib/narrative-search")
    assert.deepEqual(tokenizeLore("La maréa y la MAREA"), ["marea", "marea"])
  })
})

describe("phase-142 hang planning", () => {
  it("caps any single owner at the configured share of the hang", async () => {
    const { planHang } = await import("@/lib/exhibition-curator")
    const { rankLoreDocuments } = await import("@/lib/narrative-search")
    const ranked = rankLoreDocuments(corpus(), ["tide"])
    const whale = OWNERS[0]!
    const owners = ownerMap(ranked.map((d) => d.tokenId), (id) => (id < 110 ? whale : OWNERS[(id % 11) + 1]!))
    const plan = planHang(ranked, { maxWorks: 8, maxOwnerShare: 0.25, ownerOf: owners })
    const whaleCount = plan.slots.filter((s) => s.owner === whale.toUpperCase()).length
    assert.ok(whaleCount <= 2, `whale hung ${whaleCount} times`)
    assert.ok(plan.ownerCapApplied > 0)
  })

  it("excludes tokens whose owner could not be verified", async () => {
    const { planHang } = await import("@/lib/exhibition-curator")
    const { rankLoreDocuments } = await import("@/lib/narrative-search")
    const ranked = rankLoreDocuments(corpus(), ["tide"])
    const owners = ownerMap(ranked.filter((d) => d.tokenId % 2 === 0).map((d) => d.tokenId))
    const plan = planHang(ranked, { maxWorks: 8, maxOwnerShare: 0.5, ownerOf: owners })
    assert.ok(plan.slots.every((s) => s.tokenId % 2 === 0))
  })

  it("does not hang two works from the same world side by side when it can avoid it", async () => {
    const { planHang } = await import("@/lib/exhibition-curator")
    const { rankLoreDocuments } = await import("@/lib/narrative-search")
    const ranked = rankLoreDocuments(corpus(), ["tide"])
    const plan = planHang(ranked, { maxWorks: 8, maxOwnerShare: 0.5, ownerOf: ownerMap(ranked.map((d) => d.tokenId)) })
    assert.equal(plan.slots.length, 8)
    for (let i = 1; i < plan.slots.length - 1; i++) {
      assert.notEqual(plan.slots[i]!.collectionId, plan.slots[i - 1]!.collectionId)
    }
  })

  it("picks the sentence that carries the theme as the excerpt", async () => {
    const { excerptForTheme } = await import("@/lib/exhibition-curator")
    assert.equal(excerptForTheme("A quiet room. The tide tide returns. Dust.", ["tide"]), "The tide tide returns.")
  })
})

describe("phase-142 wall text validation", () => {
  it("rejects a reply that invents a token, skips a wall, or cites an unhung id", async () => {
    const { validateWallText } = await import("@/lib/exhibition-curator")
    const base = { title: "T", statement: "S", walls: [{ token_id: 1, text: "a" }, { token_id: 2, text: "b" }] }
    assert.equal(validateWallText(base, [1, 2]).ok, true)
    assert.deepEqual(validateWallText({ ...base, walls: [...base.walls, { token_id: 3, text: "c" }] }, [1, 2]), { ok: false, reason: "unknown_token" })
    assert.deepEqual(validateWallText({ ...base, walls: base.walls.slice(0, 1) }, [1, 2]), { ok: false, reason: "missing_wall" })
    assert.deepEqual(validateWallText({ ...base, statement: "See also #99." }, [1, 2]), { ok: false, reason: "citation" })
    assert.deepEqual(validateWallText("not json", [1]), { ok: false, reason: "shape" })
  })
})

describe("phase-142 drafting and lifecycle", () => {
  const deps = (generate: AiJsonGenerator, washed: number[] = []) => ({
    corpus: async () => corpus(),
    worldNames: async () => ({ "1": "Harbor", "2": "Reef", "3": "Delta", "4": "Shoal" }),
    washFlaggedTokenIds: (ids: number[]) => new Set(ids.filter((id) => washed.includes(id))),
    resolveOwners: async (ids: number[]) => ownerMap(ids),
    generate,
  })

  it("stores model text when it validates, and charges the call once", async () => {
    const { draftExhibition } = await import("@/lib/exhibition-curator")
    const { getEntries } = await import("@/lib/cost-attribution-ledger")
    const { exhibition, reused } = await draftExhibition({ scope: "s-model", theme: "tide lantern", lang: "en" }, deps(validModel()))
    assert.equal(reused, false)
    assert.equal(exhibition.text_source, "model")
    assert.equal(exhibition.title, "Tidewrack")
    assert.equal(exhibition.cover_token_id, exhibition.hang[0]!.token_id)
    assert.equal(getEntries().filter((e) => e.step === "curator.wall_text").length, 1)
  })

  it("falls back to grounded template copy when the model hallucinates a token", async () => {
    const { draftExhibition } = await import("@/lib/exhibition-curator")
    const { getSecurityCounter } = await import("@/lib/security-counters")
    const liar = validModel({ statement: "Do not miss #4242." })
    const { exhibition } = await draftExhibition({ scope: "s-liar", theme: "tide", lang: "es" }, deps(liar))
    assert.equal(exhibition.text_source, "fallback")
    assert.match(exhibition.title, /^Sobre /)
    assert.equal(getSecurityCounter("curator_citation_rejected"), 1)
  })

  it("falls back when the model is unavailable", async () => {
    const { draftExhibition } = await import("@/lib/exhibition-curator")
    const down: AiJsonGenerator = async () => {
      throw new Error("AI_JSON_FAILED: timeout")
    }
    const { exhibition } = await draftExhibition({ scope: "s-down", theme: "tide", lang: "en" }, deps(down))
    assert.equal(exhibition.text_source, "fallback")
    assert.ok(exhibition.hang.every((s) => s.wall_text.length > 0))
  })

  it("reuses the stored draft on retry instead of calling the model again", async () => {
    const { draftExhibition } = await import("@/lib/exhibition-curator")
    let calls = 0
    const counting: AiJsonGenerator = async (input) => {
      calls++
      return validModel()(input)
    }
    const first = await draftExhibition({ scope: "s-retry", theme: "tide", lang: "en" }, deps(counting))
    const second = await draftExhibition({ scope: "s-retry", theme: "tide", lang: "en" }, deps(counting))
    assert.equal(second.reused, true)
    assert.equal(second.exhibition.id, first.exhibition.id)
    assert.equal(calls, 1)
  })

  it("never hangs a token with a wash-flagged sale", async () => {
    const { draftExhibition } = await import("@/lib/exhibition-curator")
    const washed = [100, 101, 102, 103]
    const { exhibition } = await draftExhibition({ scope: "s-wash", theme: "tide", lang: "en" }, deps(validModel(), washed))
    assert.ok(exhibition.hang.every((s) => !washed.includes(s.token_id)))
  })

  it("refuses a show it cannot fill", async () => {
    const { draftExhibition, CuratorError } = await import("@/lib/exhibition-curator")
    await assert.rejects(
      draftExhibition({ scope: "s-thin", theme: "volcano", lang: "en" }, deps(validModel())),
      (e: unknown) => e instanceof CuratorError && e.code === "INSUFFICIENT_CANDIDATES",
    )
  })

  it("publishing rotates the live show in the same scope; stale versions conflict", async () => {
    const { draftExhibition, transitionExhibition, getExhibition, CuratorError } = await import("@/lib/exhibition-curator")
    const a = (await draftExhibition({ scope: "s-life", theme: "tide", lang: "en" }, deps(validModel()))).exhibition
    const b = (await draftExhibition({ scope: "s-life", theme: "lantern keepers", lang: "en" }, deps(validModel()))).exhibition

    const pubA = transitionExhibition(a.id, 1, "published")
    assert.equal(pubA.exhibition.status, "published")
    assert.equal(pubA.exhibition.version, 2)

    assert.throws(
      () => transitionExhibition(b.id, 7, "published"),
      (e: unknown) => e instanceof CuratorError && e.code === "VERSION_CONFLICT",
    )
    const pubB = transitionExhibition(b.id, 1, "published")
    assert.deepEqual(pubB.rotated, [a.id])
    assert.equal(getExhibition(a.id)!.status, "rotated")

    assert.throws(
      () => transitionExhibition(b.id, 2, "published"),
      (e: unknown) => e instanceof CuratorError && e.code === "INVALID_TRANSITION",
    )
  })
})
