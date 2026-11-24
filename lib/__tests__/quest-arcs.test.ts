import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll as after, beforeAll as before, beforeEach, describe, it } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import type { AiJsonGenerator } from "@/lib/forge/ai-pipeline"
import type { QuestCondition } from "@/lib/quest-registry"

let dataDir = ""
const PHASELQ = 10_000_000n
/** What the default static registry pays for (see DEFAULT_QUESTS). */
const STATIC_KEYS = new Set(["wallet_connected", "collection_created", "nft_minted", "settlement_completed", "world_created", "collection_count:3"])

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-arcs-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_147 = "1"
})

after(async () => {
  const { resetDbForTests } = await import("@/lib/sqlite-db")
  resetDbForTests()
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_147
  await rm(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  const { resetSecurityCounters } = await import("@/lib/security-counters")
  resetSecurityCounters()
})

type World = { satisfied: Set<string>; minted: number; streak: number }

function fakeDeps(world: World, over: Partial<import("@/lib/quest-arcs").ArcDeps> = {}): import("@/lib/quest-arcs").ArcDeps {
  const key = (c: QuestCondition) => (c.params?.minCount ? `${c.type}:${c.params.minCount}` : c.params?.minDays ? `${c.type}:${c.params.minDays}` : c.type)
  return {
    isSatisfied: async (_w, c) => {
      if (c.type === "collection_count") return world.minted >= Number(c.params?.minCount)
      if (c.type === "daily_streak") return world.streak >= Number(c.params?.minDays)
      return world.satisfied.has(key(c))
    },
    mintedCollections: async () => world.minted,
    streak: async () => world.streak,
    ageBand: async () => "new",
    identityBlocked: async () => false,
    staticConditionKeys: async () => STATIC_KEYS,
    treasury: async () => ({ availableStroops: 10_000n * PHASELQ, healthy: true }),
    generate: async () => {
      throw new Error("AI_JSON_FAILED: offline")
    },
    ...over,
  }
}

const freshWorld = (): World => ({ satisfied: new Set(), minted: 0, streak: 0 })

describe("phase-147 planning and sizing", () => {
  it("plans a ramped arc for a new wallet that ends on a paid on-chain step", async () => {
    const { planArcSteps } = await import("@/lib/quest-arcs")
    const plan = planArcSteps({ ageBand: "new", satisfied: [], mintedCollections: 0, streak: 0 })
    assert.equal(plan.length, 5)
    assert.deepEqual(plan[0]!.kinds, ["create_collection", "mint_nft"])
    const last = plan[plan.length - 1]!
    assert.deepEqual([last.kinds, last.target, last.onchain], [["collection_count"], 2, true])
    for (let i = 1; i < plan.length; i++) assert.ok(plan[i]!.difficulty >= plan[i - 1]!.difficulty)
  })

  it("never targets 3 collections (the static quest pays it) and gives veterans no arc", async () => {
    const { planArcSteps } = await import("@/lib/quest-arcs")
    const two = planArcSteps({ ageBand: "new", satisfied: [], mintedCollections: 2, streak: 0 })
    assert.equal(two[two.length - 1]!.target, 4)
    assert.deepEqual(planArcSteps({ ageBand: "established", satisfied: [], mintedCollections: 5, streak: 9 }), [])
  })

  it("zeroes statically paid steps, puts the bonus on the finale, and scales to the treasury", async () => {
    const { planArcSteps, sizeArcRewards } = await import("@/lib/quest-arcs")
    const plan = planArcSteps({ ageBand: "new", satisfied: [], mintedCollections: 0, streak: 0 })
    const rich = sizeArcRewards(plan, STATIC_KEYS, { availableStroops: 10_000n * PHASELQ, healthy: true })
    assert.equal(rich[0]!.reward, 0n)
    assert.equal(rich[0]!.paidByStatic, true)
    assert.equal(rich[rich.length - 1]!.reward, 3n * PHASELQ + 2n * PHASELQ)

    const lean = sizeArcRewards(plan, STATIC_KEYS, { availableStroops: 400n * PHASELQ, healthy: true })
    const leanTotal = lean.reduce((s, r) => s + r.reward, 0n)
    assert.ok(leanTotal <= 2n * PHASELQ, `total ${leanTotal}`)
  })

  it("refuses to promise rewards when the treasury is unhealthy or nearly empty", async () => {
    const { planArcSteps, sizeArcRewards, QuestArcError } = await import("@/lib/quest-arcs")
    const plan = planArcSteps({ ageBand: "new", satisfied: [], mintedCollections: 0, streak: 0 })
    const isLow = (e: unknown) => e instanceof QuestArcError && e.code === "TREASURY_LOW"
    assert.throws(() => sizeArcRewards(plan, STATIC_KEYS, { availableStroops: null, healthy: false }), isLow)
    assert.throws(() => sizeArcRewards(plan, STATIC_KEYS, { availableStroops: 10n * PHASELQ, healthy: true }), isLow)
  })

  it("the farm gate rejects farmable-heavy, off-catalog, flat or unramped plans", async () => {
    const { reviewArc } = await import("@/lib/quest-arcs")
    const step = (o: Partial<import("@/lib/quest-arcs").ArcStep>) => ({
      kinds: ["post_signal"] as import("@/lib/quest-arcs").StepKind[],
      onchain: false,
      farmable: true,
      reward_stroops: String(PHASELQ),
      paid_by_static: false,
      difficulty: 1,
      ...o,
    })
    const onchainFinale = step({ kinds: ["collection_count"], onchain: true, farmable: false, reward_stroops: String(5n * PHASELQ), difficulty: 3 })
    assert.deepEqual(reviewArc([step({}), step({ kinds: ["daily_streak"], difficulty: 2 }), onchainFinale]), { ok: true })

    const farmy = reviewArc([step({}), step({ reward_stroops: String(4n * PHASELQ) }), { ...onchainFinale, reward_stroops: String(PHASELQ) }])
    assert.ok(!farmy.ok && farmy.reasons.includes("farmable_share"))
    const offCatalog = reviewArc([step({ kinds: ["refer_a_friend" as never] }), step({}), onchainFinale])
    assert.ok(!offCatalog.ok && offCatalog.reasons.includes("outside_catalog"))
    const flat = reviewArc([step({}), step({}), step({})])
    assert.ok(!flat.ok && flat.reasons.includes("no_onchain_step"))
    const unramped = reviewArc([step({ difficulty: 2 }), step({ difficulty: 1 }), onchainFinale])
    assert.ok(!unramped.ok && unramped.reasons.includes("difficulty_ramp"))
  })
})

describe("phase-147 generation", () => {
  it("rejects blocked identities and enforces one active arc, replace, and the window cap", async () => {
    const { generateArc, QuestArcError } = await import("@/lib/quest-arcs")
    const blocked = Keypair.random().publicKey()
    await assert.rejects(
      generateArc({ wallet: blocked, lang: "en" }, fakeDeps(freshWorld(), { identityBlocked: async () => true })),
      (e: unknown) => e instanceof QuestArcError && e.code === "IDENTITY_BLOCKED",
    )

    const wallet = Keypair.random().publicKey()
    const first = await generateArc({ wallet, lang: "en" }, fakeDeps(freshWorld()))
    assert.equal(first.status, "active")
    assert.equal(first.text_source, "fallback")
    await assert.rejects(
      generateArc({ wallet, lang: "en" }, fakeDeps(freshWorld())),
      (e: unknown) => e instanceof QuestArcError && e.code === "ALREADY_ACTIVE",
    )
    const second = await generateArc({ wallet, lang: "en", replace: true }, fakeDeps(freshWorld()))
    const { getArc } = await import("@/lib/quest-arcs")
    assert.equal(getArc(first.id)!.status, "superseded")
    assert.equal(getArc(first.id)!.superseded_by, second.id)
    await generateArc({ wallet, lang: "en", replace: true }, fakeDeps(freshWorld()))
    await assert.rejects(
      generateArc({ wallet, lang: "en", replace: true }, fakeDeps(freshWorld())),
      (e: unknown) => e instanceof QuestArcError && e.code === "RATE_LIMITED",
    )
  })

  it("keeps model narrative only when it names every step and mentions no amounts", async () => {
    const { generateArc } = await import("@/lib/quest-arcs")
    const reply = (texts: (i: number) => string): AiJsonGenerator => async ({ prompt }) => {
      const indices = [...prompt.matchAll(/"index":(\d+)/g)].map((m) => Number(m[1]))
      return { json: { title: "The Long Tide", steps: indices.map((i) => ({ index: i, text: texts(i) })) }, modelId: "m", outputChars: 200 }
    }
    const greedy = await generateArc({ wallet: Keypair.random().publicKey(), lang: "es" }, fakeDeps(freshWorld(), { generate: reply(() => "Earn 500 PHASELQ now") }))
    assert.equal(greedy.text_source, "fallback")
    assert.equal(greedy.title, "Tu próximo capítulo")

    const good = await generateArc({ wallet: Keypair.random().publicKey(), lang: "en" }, fakeDeps(freshWorld(), { generate: reply((i) => `Chapter step ${i === 4 ? 2 : "one"}`) }))
    assert.equal(good.text_source, "model")
    assert.equal(good.title, "The Long Tide")
  })

  it("won't replace an arc while an earned reward is unclaimed", async () => {
    const { generateArc, refreshArc, QuestArcError } = await import("@/lib/quest-arcs")
    const wallet = Keypair.random().publicKey()
    const world = freshWorld()
    const arc = await generateArc({ wallet, lang: "en" }, fakeDeps(world))
    world.satisfied.add("signal_posted")
    await refreshArc(arc.id, fakeDeps(world))
    await assert.rejects(
      generateArc({ wallet, lang: "en", replace: true }, fakeDeps(world)),
      (e: unknown) => e instanceof QuestArcError && e.code === "ALREADY_ACTIVE",
    )
  })
})

describe("phase-147 progress and claims", () => {
  it("credits out-of-order progress, auto-claims story steps, and keeps claims ordered", async () => {
    const { generateArc, refreshArc, stepClaimable } = await import("@/lib/quest-arcs")
    const world = freshWorld()
    const arc = await generateArc({ wallet: Keypair.random().publicKey(), lang: "en" }, fakeDeps(world))
    const postIdx = arc.steps.findIndex((s) => s.kinds.includes("post_signal"))
    assert.ok(postIdx > 0)

    world.satisfied.add("signal_posted")
    let { arc: a } = await refreshArc(arc.id, fakeDeps(world))
    assert.equal(a.steps[postIdx]!.state, "done")
    assert.equal(stepClaimable(a, postIdx), false, "step 0 (story) is not done yet")

    world.satisfied.add("nft_minted")
    a = (await refreshArc(arc.id, fakeDeps(world))).arc
    assert.equal(a.steps[0]!.state, "claimed", "zero-reward story step auto-claims")
    assert.equal(stepClaimable(a, postIdx), true)
  })

  it("two-phase claims: begin once, complete idempotently, abort returns the hold, stale claims restart", async () => {
    const { generateArc, refreshArc, beginStepClaim, completeStepClaim, abortStepClaim, getArc, ARC_LIMITS, QuestArcError } =
      await import("@/lib/quest-arcs")
    const world = freshWorld()
    world.satisfied.add("nft_minted")
    world.satisfied.add("signal_posted")
    const arc = await generateArc({ wallet: Keypair.random().publicKey(), lang: "en" }, fakeDeps(freshWorld()))
    await refreshArc(arc.id, fakeDeps(world))
    const idx = getArc(arc.id)!.steps.findIndex((s) => s.kinds.includes("post_signal"))
    const t0 = Date.now()

    const begun = beginStepClaim(arc.id, idx, "hold-1", t0)
    assert.equal(begun.amountStroops, String(PHASELQ))
    assert.throws(() => beginStepClaim(arc.id, idx, "hold-2", t0 + 1), (e: unknown) => e instanceof QuestArcError && e.code === "STEP_NOT_CLAIMABLE")

    assert.equal(abortStepClaim(arc.id, idx), "hold-1")
    assert.equal(getArc(arc.id)!.steps[idx]!.state, "done")

    beginStepClaim(arc.id, idx, "hold-3", t0)
    const restarted = beginStepClaim(arc.id, idx, "hold-4", t0 + ARC_LIMITS.CLAIM_TTL_MS + 1)
    assert.equal(restarted.staleHoldId, "hold-3")

    const done = completeStepClaim(arc.id, idx, "tx-1")
    assert.equal(done.holdId, "hold-4")
    const again = completeStepClaim(arc.id, idx, "tx-1")
    assert.equal(again.holdId, null)
    assert.equal(getArc(arc.id)!.steps[idx]!.tx_hash, "tx-1")
  })

  it("claiming the last step completes the arc", async () => {
    const { generateArc, refreshArc, beginStepClaim, completeStepClaim, getArc } = await import("@/lib/quest-arcs")
    const world: World = { satisfied: new Set(["nft_minted", "collection_created", "signal_posted", "settlement_completed", "world_created"]), minted: 0, streak: 0 }
    const arc = await generateArc({ wallet: Keypair.random().publicKey(), lang: "en" }, fakeDeps(freshWorld()))
    world.minted = 5
    world.streak = 9
    await refreshArc(arc.id, fakeDeps(world))
    let completed = false
    for (const step of getArc(arc.id)!.steps) {
      if (getArc(arc.id)!.steps[step.index]!.state !== "done") continue
      beginStepClaim(arc.id, step.index, null)
      completed = completeStepClaim(arc.id, step.index, `tx-${step.index}`).completedNow
    }
    assert.equal(completed, true)
    assert.equal(getArc(arc.id)!.status, "completed")
  })

  it("expiry is lazy and leaves earned steps claimable", async () => {
    const { generateArc, refreshArc, stepClaimable, ARC_LIMITS } = await import("@/lib/quest-arcs")
    const world = freshWorld()
    const arc = await generateArc({ wallet: Keypair.random().publicKey(), lang: "en" }, fakeDeps(world))
    world.satisfied.add("nft_minted")
    world.satisfied.add("signal_posted")
    await refreshArc(arc.id, fakeDeps(world))
    const later = Date.now() + ARC_LIMITS.TTL_MS + 1
    const { arc: expired } = await refreshArc(arc.id, fakeDeps(world, { now: later }))
    assert.equal(expired.status, "expired")
    const idx = expired.steps.findIndex((s) => s.kinds.includes("post_signal"))
    assert.equal(stepClaimable(expired, idx, later), true)
  })

  it("parses only well-formed faucet reward ids", async () => {
    const { arcRewardId, parseArcRewardId } = await import("@/lib/quest-arcs")
    const id = "0f8b7c1e-1234-4abc-9def-0123456789ab"
    assert.deepEqual(parseArcRewardId(arcRewardId(id.toUpperCase(), 2)), { arcId: id, index: 2 })
    assert.equal(parseArcRewardId("arc:not-a-uuid:1"), null)
    assert.equal(parseArcRewardId(`arc:${id}:7`), null)
    assert.equal(parseArcRewardId("quest_first_world"), null)
  })
})
