import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { getDb, resetDbForTests } from "@/lib/sqlite-db"
import {
  createReply,
  createSignal,
  getReplies,
  getSignal,
  getSignals,
  parseVersionHeader,
  signalETag,
  upvoteSignal,
  VersionConflictError,
  type Signal,
} from "@/lib/signal-store"

const CONCURRENCY = 50

let dataDir: string
let previousDataDir: string | undefined

beforeEach(async () => {
  // getDb() caches its connection process-wide, so it has to be dropped
  // before the new data dir is picked up — otherwise every test would share
  // the first test's database.
  resetDbForTests()
  dataDir = await mkdtemp(path.join(tmpdir(), "phase-signal-store-"))
  previousDataDir = process.env.PHASE_SERVER_DATA_DIR
  process.env.PHASE_SERVER_DATA_DIR = dataDir
})

afterEach(async () => {
  resetDbForTests()
  if (previousDataDir === undefined) {
    delete process.env.PHASE_SERVER_DATA_DIR
  } else {
    process.env.PHASE_SERVER_DATA_DIR = previousDataDir
  }
  await rm(dataDir, { recursive: true, force: true })
})

function signalData(i: number): Omit<Signal, "id" | "created_at" | "version"> {
  return {
    author_wallet: `G_AUTHOR_${i}`,
    author_display: `author-${i}`,
    channel: "general",
    title: `Signal ${i}`,
    body: `Body ${i}`,
    upvotes: [],
    signature: `sig-${i}`,
  }
}

function replyData(signalId: string, i: number) {
  return {
    signal_id: signalId,
    author_wallet: `G_REPLIER_${i}`,
    author_display: `replier-${i}`,
    body: `Reply ${i}`,
    upvotes: [],
    signature: `sig-${i}`,
  }
}

async function seedSignal(): Promise<Signal> {
  return createSignal(signalData(0))
}

describe("lost updates", () => {
  it(`loses no upvotes across ${CONCURRENCY} concurrent writers on one signal`, async () => {
    const signal = await seedSignal()

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        upvoteSignal(signal.id, `G_VOTER_${i}`),
      ),
    )

    const stored = await getSignal(signal.id)
    expect(stored).not.toBeNull()
    expect(stored!.upvotes).toHaveLength(CONCURRENCY)
    expect(new Set(stored!.upvotes).size).toBe(CONCURRENCY)
  })

  it(`loses no signals across ${CONCURRENCY} concurrent creates`, async () => {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => createSignal(signalData(i))),
    )

    const all = await getSignals()
    expect(all).toHaveLength(CONCURRENCY)
    expect(new Set(all.map((s) => s.id)).size).toBe(CONCURRENCY)
  })

  it(`loses no replies across ${CONCURRENCY} concurrent appends to one signal`, async () => {
    const signal = await seedSignal()

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        createReply(replyData(signal.id, i)),
      ),
    )

    const replies = await getReplies(signal.id)
    expect(replies).toHaveLength(CONCURRENCY)
    expect(new Set(replies.map((r) => r.id)).size).toBe(CONCURRENCY)
  })

  it("bumps version once per mutation", async () => {
    const signal = await seedSignal()
    expect(signal.version).toBe(1)

    const afterFirst = await upvoteSignal(signal.id, "G_VOTER_A")
    expect(afterFirst.version).toBe(2)

    const afterSecond = await upvoteSignal(signal.id, "G_VOTER_B")
    expect(afterSecond.version).toBe(3)

    // Toggling off is a mutation too, so the counter must keep climbing.
    const afterToggleOff = await upvoteSignal(signal.id, "G_VOTER_A")
    expect(afterToggleOff.version).toBe(4)
    expect(afterToggleOff.upvotes).toEqual(["G_VOTER_B"])
  })

  it("keeps upvote_count in step with upvotes_json", async () => {
    const signal = await seedSignal()
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => upvoteSignal(signal.id, `G_VOTER_${i}`)),
    )

    const row = getDb()
      .prepare("SELECT upvotes_json, upvote_count FROM signals WHERE id = ?")
      .get(signal.id) as { upvotes_json: string; upvote_count: number }

    expect(row.upvote_count).toBe(10)
    expect(JSON.parse(row.upvotes_json)).toHaveLength(10)
  })
})

describe("compare-and-swap", () => {
  it("rejects the second of two writers racing on the same version", async () => {
    const signal = await seedSignal()

    const winner = await upvoteSignal(signal.id, "G_VOTER_A", signal.version)
    expect(winner.version).toBe(2)

    await expect(
      upvoteSignal(signal.id, "G_VOTER_B", signal.version),
    ).rejects.toBeInstanceOf(VersionConflictError)
  })

  it(`lets exactly one of ${CONCURRENCY} writers win a single version`, async () => {
    const signal = await seedSignal()

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        upvoteSignal(signal.id, `G_VOTER_${i}`, signal.version),
      ),
    )

    const won = results.filter((r) => r.status === "fulfilled")
    const conflicted = results.filter((r) => r.status === "rejected")
    expect(won).toHaveLength(1)
    expect(conflicted).toHaveLength(CONCURRENCY - 1)
    expect(
      conflicted.every(
        (r) => r.status === "rejected" && r.reason instanceof VersionConflictError,
      ),
    ).toBe(true)

    // The losers must not have leaked their upvote into the stored row.
    const stored = await getSignal(signal.id)
    expect(stored!.upvotes).toHaveLength(1)
  })

  it("reports the current version on conflict", async () => {
    const signal = await seedSignal()
    await upvoteSignal(signal.id, "G_VOTER_A")

    try {
      await upvoteSignal(signal.id, "G_VOTER_B", signal.version)
      expect.unreachable("expected a VersionConflictError")
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictError)
      expect((error as VersionConflictError).currentVersion).toBe(2)
    }
  })

  it("applies writes from clients that send no version", async () => {
    const signal = await seedSignal()
    const after = await upvoteSignal(signal.id, "G_VOTER_A")
    expect(after.version).toBe(2)
    expect(after.upvotes).toEqual(["G_VOTER_A"])
  })

  it("refuses a reply composed against a stale parent version", async () => {
    const signal = await seedSignal()
    await upvoteSignal(signal.id, "G_VOTER_A")

    await expect(
      createReply(replyData(signal.id, 1), signal.version),
    ).rejects.toBeInstanceOf(VersionConflictError)

    expect(await getReplies(signal.id)).toHaveLength(0)
  })

  it("accepts a reply composed against the live parent version", async () => {
    const signal = await seedSignal()
    const fresh = await createReply(replyData(signal.id, 1), signal.version)
    expect(fresh.signal_id).toBe(signal.id)
    expect(await getReplies(signal.id)).toHaveLength(1)
  })
})

describe("version guard", () => {
  // The retry loop inside upvoteSignal depends on this: a write that names a
  // superseded version must affect zero rows, otherwise two processes could
  // still clobber each other.
  it("makes a stale-version UPDATE a no-op", async () => {
    const created = await seedSignal()
    const stale = created.version

    const bumped = getDb()
      .prepare("UPDATE signals SET version = ? WHERE id = ?")
      .run(stale + 1, created.id)
    expect(bumped.changes).toBe(1)

    const guarded = getDb()
      .prepare(
        "UPDATE signals SET upvotes_json = ?, upvote_count = ?, version = ? WHERE id = ? AND version = ?",
      )
      .run("[]", 0, stale + 2, created.id, stale)
    expect(guarded.changes).toBe(0)
  })

  // A single-process Promise.all cannot demonstrate this race: node:sqlite is
  // synchronous and upvoteSignal has no await inside its read-modify-write, so
  // an in-process interleaving point does not exist. The real hazard is a
  // second writer on a *different* connection — two Vercel instances sharing
  // the database file. This drives that directly with a second DatabaseSync
  // handle, committing between our read and our write.
  it("does not clobber a concurrent write from a second connection", async () => {
    const created = await seedSignal()
    const ours = getDb()

    // Connection A reads and computes, exactly as upvoteSignal does.
    const row = ours
      .prepare("SELECT * FROM signals WHERE id = ?")
      .get(created.id) as { version: number; upvotes_json: string }
    const readVersion = row.version

    // Connection B — a separate handle, standing in for another instance —
    // commits first.
    const other = new DatabaseSync(serverDataJsonPath("sqliteDb"))
    try {
      other.exec("BEGIN IMMEDIATE")
      other
        .prepare(
          "UPDATE signals SET upvotes_json = ?, upvote_count = ?, version = ? WHERE id = ?",
        )
        .run(JSON.stringify(["G_OTHER_INSTANCE"]), 1, readVersion + 1, created.id)
      other.exec("COMMIT")

      // Connection A now tries to commit the write it computed from the stale
      // read. The version guard has to reject it.
      const guarded = ours
        .prepare(
          "UPDATE signals SET upvotes_json = ?, upvote_count = ?, version = ? WHERE id = ? AND version = ?",
        )
        .run(
          JSON.stringify([...(JSON.parse(row.upvotes_json) as string[]), "G_OURS"]),
          1,
          readVersion + 1,
          created.id,
          readVersion,
        )
      expect(guarded.changes).toBe(0)

      // B's write survives untouched, and re-reading drives the retry loop to
      // a state that preserves both upvotes.
      const stored = await getSignal(created.id)
      expect(stored!.upvotes).toContain("G_OTHER_INSTANCE")
      expect(stored!.upvotes).not.toContain("G_OURS")

      const recovered = await upvoteSignal(created.id, "G_OURS")
      expect(recovered.upvotes).toEqual(
        expect.arrayContaining(["G_OTHER_INSTANCE", "G_OURS"]),
      )
      expect(recovered.version).toBe(readVersion + 2)
    } finally {
      other.close()
    }
  })

  it("backfills a 1-based version onto rows written before the column existed", async () => {
    const signal = await seedSignal()
    getDb()
      .prepare("UPDATE signals SET version = 0 WHERE id = ?")
      .run(signal.id)

    resetDbForTests()
    getDb()

    const stored = await getSignal(signal.id)
    expect(stored!.version).toBe(1)
  })
})

describe("version headers", () => {
  it("round-trips an ETag", () => {
    expect(parseVersionHeader(signalETag(7))).toBe(7)
  })

  it("rejects malformed or out-of-range version headers", () => {
    expect(parseVersionHeader("*")).toBeNull()
    expect(parseVersionHeader('"abc"')).toBeNull()
    expect(parseVersionHeader("0")).toBeNull()
    expect(parseVersionHeader("-3")).toBeNull()
    expect(parseVersionHeader("1.5")).toBeNull()
  })

  it("accepts an unquoted version", () => {
    expect(parseVersionHeader("4")).toBe(4)
  })
})

describe("durability", () => {
  it("does not lose a signal when the store is reopened", async () => {
    const signal = await seedSignal()
    await upvoteSignal(signal.id, "G_VOTER_A")

    resetDbForTests()

    const stored = await getSignal(signal.id)
    expect(stored!.upvotes).toEqual(["G_VOTER_A"])
    expect(stored!.version).toBe(2)
  })

  it("stores signals in the sqlite sidecar, not a json file", async () => {
    await seedSignal()
    // Guard against a regression to the JSON sidecar: the concurrency contract
    // now lives in SQLite transactions and the version column.
    await expect(
      (await import("node:fs/promises")).stat(serverDataJsonPath("signals")),
    ).rejects.toThrow()
  })
})
