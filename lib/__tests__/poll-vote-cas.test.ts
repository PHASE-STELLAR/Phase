import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"
import { createSignal, getSignal, voteOnPoll } from "@/lib/signal-store"
import { snapshotSignalVersionMetrics } from "@/lib/signal-version-metrics"

let dataDir: string
let previousDataDir: string | undefined

beforeEach(async () => {
  resetDbForTests()
  dataDir = await mkdtemp(path.join(tmpdir(), "phase-poll-vote-cas-"))
  previousDataDir = process.env.PHASE_SERVER_DATA_DIR
  process.env.PHASE_SERVER_DATA_DIR = dataDir
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetDbForTests()
  if (previousDataDir === undefined) delete process.env.PHASE_SERVER_DATA_DIR
  else process.env.PHASE_SERVER_DATA_DIR = previousDataDir
  await rm(dataDir, { recursive: true, force: true })
})

async function makePoll(closesAt?: number) {
  return createSignal({
    author_wallet: Keypair.random().publicKey(),
    author_display: "Author",
    channel: "general",
    title: "Poll",
    body: "Body",
    upvotes: [],
    signature: "sig",
    type: "poll",
    poll: {
      options: [{ id: "yes", text: "Yes", voters: [] }, { id: "no", text: "No", voters: [] }],
      ...(closesAt ? { closes_at: closesAt } : {}),
    },
  })
}

describe("voteOnPoll is version-guarded (spike 596)", () => {
  it("records the vote, bumps the version once, and moves a wallet that re-votes", async () => {
    const poll = await makePoll()
    const first = await voteOnPoll(poll.id, "yes", "G_ONE")
    expect(first.version).toBe(poll.version + 1)
    expect(first.poll!.options.find((o) => o.id === "yes")!.voters).toEqual(["G_ONE"])

    const moved = await voteOnPoll(poll.id, "no", "G_ONE")
    expect(moved.version).toBe(poll.version + 2)
    expect(moved.poll!.options.find((o) => o.id === "yes")!.voters).toEqual([])
    expect(moved.poll!.options.find((o) => o.id === "no")!.voters).toEqual(["G_ONE"])
  })

  it("keeps its existing errors", async () => {
    await expect(voteOnPoll("missing", "yes", "G")).rejects.toThrow("Poll not found")
    const poll = await makePoll()
    await expect(voteOnPoll(poll.id, "maybe", "G")).rejects.toThrow("Poll option not found")
    const closed = await makePoll(Date.now() - 1000)
    await expect(voteOnPoll(closed.id, "yes", "G")).rejects.toThrow("Poll is closed")
  })

  it("does not lose a vote committed by a second connection between our read and our write", async () => {
    const poll = await makePoll()
    const db = getDb()
    const realPrepare = db.prepare.bind(db)
    const peer = new DatabaseSync(serverDataJsonPath("sqliteDb"))
    let fired = false

    // The first time voteOnPoll reads the row, a peer instance commits its own
    // vote straight afterwards, so our write is computed from a stale read.
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql)
      if (!/SELECT \* FROM signals WHERE id/.test(sql)) return stmt
      return {
        get: (...args: unknown[]) => {
          const row = stmt.get(...(args as [string])) as { version: number; poll_json: string }
          if (!fired) {
            fired = true
            const theirs = JSON.parse(row.poll_json)
            theirs.options[0].voters.push("G_PEER")
            peer.exec("BEGIN IMMEDIATE")
            peer
              .prepare("UPDATE signals SET poll_json = ?, version = ? WHERE id = ?")
              .run(JSON.stringify(theirs), row.version + 1, poll.id)
            peer.exec("COMMIT")
          }
          return row
        },
      }
    }) as unknown as typeof db.prepare)

    const before = snapshotSignalVersionMetrics().bySurface.vote
    try {
      const result = await voteOnPoll(poll.id, "yes", "G_OURS")
      expect(fired).toBe(true)
      expect(result.poll!.options[0].voters).toEqual(expect.arrayContaining(["G_PEER", "G_OURS"]))
      expect(result.version).toBe(poll.version + 2)
      expect(snapshotSignalVersionMetrics().bySurface.vote).toBe(before + 1)
    } finally {
      peer.close()
    }

    const stored = await getSignal(poll.id)
    expect(stored!.poll!.options[0].voters.sort()).toEqual(["G_OURS", "G_PEER"])
  })
})
