import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { serverDataJsonPath } from "@/lib/server-data-paths"
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
  dataDir = await mkdtemp(path.join(tmpdir(), "phase-signal-store-"))
  previousDataDir = process.env.PHASE_SERVER_DATA_DIR
  process.env.PHASE_SERVER_DATA_DIR = dataDir
})

afterEach(async () => {
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

describe("signal store concurrency", () => {
  it("loses no writes across 50 concurrent createSignal calls", async () => {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => createSignal(signalData(i))),
    )

    const stored = await getSignals()
    expect(stored).toHaveLength(CONCURRENCY)
    expect(new Set(stored.map((s) => s.id)).size).toBe(CONCURRENCY)
  })

  it("loses no upvotes across 50 concurrent writers on one signal", async () => {
    const signal = await seedSignal()
    expect(signal.version).toBe(1)

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        upvoteSignal(signal.id, `G_VOTER_${i}`),
      ),
    )

    const reloaded = await getSignal(signal.id)
    expect(reloaded?.upvotes).toHaveLength(CONCURRENCY)
    expect(new Set(reloaded?.upvotes).size).toBe(CONCURRENCY)
    expect(reloaded?.version).toBe(CONCURRENCY + 1)
  })

  it("loses no replies across 50 concurrent appends to one signal", async () => {
    const signal = await seedSignal()

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => createReply(replyData(signal.id, i))),
    )

    const replies = await getReplies(signal.id)
    expect(replies).toHaveLength(CONCURRENCY)
    expect(new Set(replies.map((r) => r.id)).size).toBe(CONCURRENCY)
  })

  it("keeps concurrent readers from ever observing a torn file", async () => {
    const writes = Array.from({ length: CONCURRENCY }, (_, i) => createSignal(signalData(i)))

    const reader = (async () => {
      for (let i = 0; i < CONCURRENCY * 2; i += 1) {
        // A non-atomic writer would let this throw on a half-flushed file.
        await getSignals()
      }
    })()

    await Promise.all([...writes, reader])
    expect(await getSignals()).toHaveLength(CONCURRENCY)
  })
})

describe("compare-and-swap", () => {
  it("rejects the second of two writers racing on the same version", async () => {
    const signal = await seedSignal()

    const first = upvoteSignal(signal.id, "G_A", signal.version)
    const second = upvoteSignal(signal.id, "G_B", signal.version)

    await expect(first).resolves.toMatchObject({ version: 2 })
    await expect(second).rejects.toBeInstanceOf(VersionConflictError)
    await expect(second).rejects.toMatchObject({ currentVersion: 2 })

    const reloaded = await getSignal(signal.id)
    expect(reloaded?.upvotes).toEqual(["G_A"])
  })

  it("accepts a single winner when 50 writers race on one version", async () => {
    const signal = await seedSignal()

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        upvoteSignal(signal.id, `G_RACER_${i}`, signal.version),
      ),
    )

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(CONCURRENCY - 1)
    for (const outcome of rejected) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError)
    }

    const reloaded = await getSignal(signal.id)
    expect(reloaded?.upvotes).toHaveLength(1)
    expect(reloaded?.version).toBe(2)
  })

  it("still applies writes from clients that send no version", async () => {
    const signal = await seedSignal()
    await upvoteSignal(signal.id, "G_LEGACY")
    const reloaded = await getSignal(signal.id)
    expect(reloaded?.upvotes).toEqual(["G_LEGACY"])
    expect(reloaded?.version).toBe(2)
  })

  it("rejects a reply composed against a stale parent version", async () => {
    const signal = await seedSignal()
    await upvoteSignal(signal.id, "G_SOMEONE")

    await expect(createReply(replyData(signal.id, 1), signal.version)).rejects
      .toBeInstanceOf(VersionConflictError)
    await expect(createReply(replyData(signal.id, 2), signal.version)).rejects
      .toMatchObject({ currentVersion: 2 })

    expect(await getReplies(signal.id)).toHaveLength(0)

    const fresh = await createReply(replyData(signal.id, 3), 2)
    expect(fresh.signal_id).toBe(signal.id)
    expect(await getReplies(signal.id)).toHaveLength(1)
  })
})

describe("durability", () => {
  it("refuses to write over a corrupt store instead of silently emptying it", async () => {
    const filePath = serverDataJsonPath("signals")
    await writeFile(filePath, '{"broken": ', "utf8")

    await expect(seedSignal()).rejects.toThrow(/Corrupt JSON store/)
    expect(await readFile(filePath, "utf8")).toBe('{"broken": ')
  })

  it("treats a missing store as empty", async () => {
    const seed = await seedSignal()
    expect(await getSignals()).toHaveLength(1)
    expect(seed.version).toBe(1)
  })

  it("backfills a version onto pre-existing records that lack one", async () => {
    const filePath = serverDataJsonPath("signals")
    await writeFile(
      filePath,
      JSON.stringify({
        legacy: {
          id: "legacy",
          author_wallet: "G_LEGACY",
          author_display: "legacy",
          channel: "general",
          title: "Legacy",
          body: "Legacy body",
          upvotes: ["G_A"],
          created_at: 1,
          signature: "sig",
        },
      }),
      "utf8",
    )

    const reloaded = await getSignal("legacy")
    expect(reloaded?.version).toBe(1)

    const updated = await upvoteSignal("legacy", "G_B", 1)
    expect(updated.version).toBe(2)
    expect(updated.upvotes).toEqual(["G_A", "G_B"])
  })
})

describe("version headers", () => {
  it("round-trips an ETag", () => {
    expect(signalETag(7)).toBe('"7"')
    expect(parseVersionHeader('"7"')).toBe(7)
    expect(parseVersionHeader("7")).toBe(7)
    expect(parseVersionHeader('  "12" ')).toBe(12)
  })

  it("rejects malformed or out-of-range version headers", () => {
    expect(parseVersionHeader("")).toBeNull()
    expect(parseVersionHeader("abc")).toBeNull()
    expect(parseVersionHeader('"abc"')).toBeNull()
    expect(parseVersionHeader("0")).toBeNull()
    expect(parseVersionHeader("-3")).toBeNull()
    expect(parseVersionHeader("1.5")).toBeNull()
  })
})
