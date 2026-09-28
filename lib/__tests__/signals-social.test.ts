import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { Keypair } from "@stellar/stellar-sdk"
import { rankFollowSuggestions } from "@/lib/follow-store"
import {
  cancelScheduledSignal,
  createSignal,
  getScheduledSignals,
  getSignals,
  voteOnPoll,
} from "@/lib/signal-store"
import { appendModerationAuditEvent, getModerationAuditEvents } from "@/lib/moderation-audit"

let dataDir = ""

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-signals-social-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_89 = "1"
  process.env.FEATURE_PHASE_90 = "1"
  process.env.FEATURE_PHASE_91 = "1"
})

after(async () => {
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_89
  delete process.env.FEATURE_PHASE_90
  delete process.env.FEATURE_PHASE_91
  await rm(dataDir, { recursive: true, force: true })
})

test("rankFollowSuggestions combines mutual and on-chain graph evidence", () => {
  const viewer = "viewer"
  const alreadyFollowing = "followed"
  const mutualCandidate = "mutual"
  const chainCandidate = "chain"
  const store = {
    [viewer]: { following: [alreadyFollowing], followers: [] },
    [alreadyFollowing]: { following: [mutualCandidate], followers: [viewer] },
    [mutualCandidate]: { following: [], followers: [alreadyFollowing, "another"] },
    [chainCandidate]: { following: [], followers: [] },
  }

  const suggestions = rankFollowSuggestions(viewer, store, [
    { wallet: alreadyFollowing, sharedAssets: 4 },
    { wallet: mutualCandidate, sharedAssets: 1 },
    { wallet: chainCandidate, sharedAssets: 2 },
  ])

  assert.deepEqual(suggestions.map((item) => item.wallet), [mutualCandidate, chainCandidate])
  assert.equal(suggestions[0]?.mutualFollows, 1)
  assert.equal(suggestions[0]?.sharedAssets, 1)
})

test("scheduled broadcasts stay out of the feed and can be cancelled by their creator", async () => {
  const wallet = Keypair.random().publicKey()
  const signal = await createSignal({
    author_wallet: wallet,
    author_display: "Scheduler",
    channel: "general",
    title: "Later",
    body: "Publish this later",
    upvotes: [],
    signature: wallet,
    type: "post",
    scheduled_for: Date.now() + 60_000,
  })

  assert.equal(signal.status, "scheduled")
  assert.equal((await getSignals()).some((item) => item.id === signal.id), false)
  assert.equal((await getScheduledSignals(wallet)).length, 1)

  const cancelled = await cancelScheduledSignal(signal.id, wallet)
  assert.equal(cancelled.status, "cancelled")
  assert.equal((await getScheduledSignals(wallet)).length, 0)
})

test("poll voting keeps one active choice per wallet", async () => {
  const author = Keypair.random().publicKey()
  const voter = Keypair.random().publicKey()
  const poll = await createSignal({
    author_wallet: author,
    author_display: "Pollster",
    channel: "general",
    title: "Choose",
    body: "Pick one",
    upvotes: [],
    signature: author,
    type: "poll",
    poll: {
      options: [
        { id: "alpha", text: "Alpha", voters: [] },
        { id: "beta", text: "Beta", voters: [] },
      ],
    },
  })

  await voteOnPoll(poll.id, "alpha", voter)
  const changed = await voteOnPoll(poll.id, "beta", voter)
  assert.deepEqual(changed.poll?.options[0]?.voters, [])
  assert.deepEqual(changed.poll?.options[1]?.voters, [voter])
})

test("moderation audit events retain moderator identity", async () => {
  const moderator = Keypair.random().publicKey()
  const event = await appendModerationAuditEvent({
    signal_id: "signal-1",
    action: "takedown",
    moderator_wallet: moderator,
    moderator_signature: "signed-intent",
    reason: "spam",
  })

  const events = await getModerationAuditEvents("signal-1")
  assert.equal(events.length, 1)
  assert.equal(events[0]?.id, event.id)
  assert.equal(events[0]?.moderator_wallet, moderator)
  assert.equal(events[0]?.reason, "spam")
})
