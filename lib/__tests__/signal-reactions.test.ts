import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, beforeEach, describe, it } from "node:test"
import { Keypair } from "@stellar/stellar-sdk"
import {
  createSignal,
  getSignalReactionSummary,
  REACTION_EMOJI,
  SignalReactionError,
  toggleSignalReaction,
  __resetSignalReactionRateLimitForTests,
} from "@/lib/signal-store"

let dataDir = ""

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-signal-reactions-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_83 = "1"
})

beforeEach(() => {
  __resetSignalReactionRateLimitForTests()
})

after(async () => {
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_83
  await rm(dataDir, { recursive: true, force: true })
})

async function makeSignal(author: string) {
  return createSignal({
    author_wallet: author,
    author_display: "Reactor",
    channel: "general",
    title: "React to me",
    body: "Body",
    upvotes: [],
    signature: author,
    type: "post",
  })
}

describe("phase-83 emoji reaction aggregation", () => {
  it("toggles a wallet's reaction on and off", async () => {
    const author = Keypair.random().publicKey()
    const wallet = Keypair.random().publicKey()
    const signal = await makeSignal(author)

    const added = await toggleSignalReaction(signal.id, wallet, "🔥")
    assert.equal(added.toggled, "added")
    assert.equal(added.summary.find((r) => r.emoji === "🔥")?.count, 1)
    assert.equal(added.summary.find((r) => r.emoji === "🔥")?.reacted, true)

    const removed = await toggleSignalReaction(signal.id, wallet, "🔥")
    assert.equal(removed.toggled, "removed")
    assert.equal(removed.summary.find((r) => r.emoji === "🔥")?.count, 0)
    assert.equal(removed.summary.find((r) => r.emoji === "🔥")?.reacted, false)
  })

  it("aggregates counts across wallets and reports per-viewer reacted flags independently", async () => {
    const author = Keypair.random().publicKey()
    const walletA = Keypair.random().publicKey()
    const walletB = Keypair.random().publicKey()
    const signal = await makeSignal(author)

    await toggleSignalReaction(signal.id, walletA, "👍")
    await toggleSignalReaction(signal.id, walletB, "👍")
    await toggleSignalReaction(signal.id, walletA, "❤️")

    const summaryForA = await getSignalReactionSummary(signal.id, walletA)
    assert.equal(summaryForA.find((r) => r.emoji === "👍")?.count, 2)
    assert.equal(summaryForA.find((r) => r.emoji === "👍")?.reacted, true)
    assert.equal(summaryForA.find((r) => r.emoji === "❤️")?.reacted, true)

    const summaryForB = await getSignalReactionSummary(signal.id, walletB)
    assert.equal(summaryForB.find((r) => r.emoji === "❤️")?.reacted, false)
  })

  it("rejects an emoji outside the curated allowlist", async () => {
    const author = Keypair.random().publicKey()
    const wallet = Keypair.random().publicKey()
    const signal = await makeSignal(author)

    await assert.rejects(
      () => toggleSignalReaction(signal.id, wallet, "🦄"),
      (error: unknown) => error instanceof SignalReactionError && error.code === "VALIDATION_FAILED",
    )
  })

  it("rate-limits a wallet reacting too many times in the window", async () => {
    const author = Keypair.random().publicKey()
    const wallet = Keypair.random().publicKey()
    const signal = await makeSignal(author)

    for (let i = 0; i < REACTION_EMOJI.length; i++) {
      await toggleSignalReaction(signal.id, wallet, REACTION_EMOJI[i]!)
    }
    // 6 emoji toggles used; toggling back and forth on one emoji repeatedly
    // exhausts the remaining budget within the 60s window (limit is 20).
    for (let i = 0; i < 14; i++) {
      await toggleSignalReaction(signal.id, wallet, "👍")
    }

    await assert.rejects(
      () => toggleSignalReaction(signal.id, wallet, "👍"),
      (error: unknown) => error instanceof SignalReactionError && error.code === "RATE_LIMITED" && typeof error.retryAfterMs === "number",
    )
  })

  it("throws FLAG_DISABLED when phase-83 is off", async () => {
    const author = Keypair.random().publicKey()
    const wallet = Keypair.random().publicKey()
    const signal = await makeSignal(author)

    delete process.env.FEATURE_PHASE_83
    try {
      await assert.rejects(
        () => toggleSignalReaction(signal.id, wallet, "👍"),
        (error: unknown) => error instanceof SignalReactionError && error.code === "FLAG_DISABLED",
      )
    } finally {
      process.env.FEATURE_PHASE_83 = "1"
    }
  })
})
