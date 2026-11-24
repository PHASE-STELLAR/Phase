import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Keypair } from "@stellar/stellar-sdk"
import { beforeEach, describe, expect, it } from "vitest"
import { readJsonFile, updateJsonFile, writeJsonFileAtomic } from "@/lib/json-store"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { followUser, getFollowers, getFollowing, unfollowUser } from "@/lib/follow-store"
import { saveProfile, getProfile } from "@/lib/profile-store"
import { createNotification, createNotificationBatch, getNotifications } from "@/lib/notification-store"
import { checkAndUnlock, getWalletData, unlockAchievement } from "@/lib/achievement-store"
import { saveWorldForCollection, getWorldForCollection, markNarrativeRead, getReaderProgress } from "@/lib/narrative-world-store"
import { recordCreatorProfileView, getCreatorProfileViewAnalytics } from "@/lib/market-store"

const CONCURRENCY = 50

let dataDir = ""

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "phase-store-test-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
})

/**
 * Deterministic, genuinely valid ed25519 public keys. The market-store profile
 * view schema runs `StrKey.isValidEd25519PublicKey`, so synthetic `G...` strings
 * are rejected.
 */
const wallet = (n: number) =>
  Keypair.fromRawEd25519Seed(createHash("sha256").update(`phase-test-${n}`).digest())
    .publicKey()

describe("follow-store: no lost updates", () => {
  it("persists all 50 concurrent distinct follows", async () => {
    const target = wallet(500)
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => followUser(wallet(600 + i), target)),
    )
    expect((await getFollowers(target)).length).toBe(CONCURRENCY)
  })

  it("records both directions of a follow", async () => {
    const a = wallet(700)
    const b = wallet(701)
    await followUser(a, b)
    expect(await getFollowing(a)).toEqual([b])
    expect(await getFollowers(b)).toEqual([a])
  })

  it("unfollow removes both directions", async () => {
    const a = wallet(702)
    const b = wallet(703)
    await followUser(a, b)
    await unfollowUser(a, b)
    expect(await getFollowing(a)).toEqual([])
    expect(await getFollowers(b)).toEqual([])
  })

  it("does not drop a follow when block and follow interleave", async () => {
    // Same file, different keys: the unserialized version lost one of the two.
    const a = wallet(704)
    const b = wallet(705)
    const c = wallet(706)
    await Promise.all([followUser(a, b), followUser(c, b), followUser(a, c)])
    expect((await getFollowers(b)).sort()).toEqual([a, c].sort())
    expect((await getFollowing(a)).sort()).toEqual([b, c].sort())
  })
})

describe("profile-store: no lost updates", () => {
  it("persists all 50 concurrent profile saves", async () => {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        saveProfile(wallet(800 + i), { display_name: `name-${i}` }),
      ),
    )
    for (let i = 0; i < CONCURRENCY; i++) {
      expect((await getProfile(wallet(800 + i)))?.display_name).toBe(`name-${i}`)
    }
  })
})

describe("achievement-store: checkAndUnlock persists what it reports", () => {
  it("persists an unlock in a single call (regression: stale snapshot clobber)", async () => {
    const w = wallet(1)
    const unlocked = await checkAndUnlock(w, { mints: 1 })
    expect(unlocked).toEqual(["first_mint"])

    const data = await getWalletData(w)
    expect(data.unlocked.map((a) => a.id)).toEqual(["first_mint"])
    expect(data.mint_count).toBe(1)
  })

  it("unlockAchievement is idempotent under concurrent calls", async () => {
    const w = wallet(2)
    const results = await Promise.all(
      Array.from({ length: 10 }, () => unlockAchievement(w, "first_collection")),
    )
    expect(results.filter(Boolean).length).toBe(1)
    expect((await getWalletData(w)).unlocked.length).toBe(1)
  })

  it("accumulates counters across 50 concurrent checkAndUnlock calls", async () => {
    const w = wallet(3)
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => checkAndUnlock(w, { upvote_delta: 1 })),
    )
    const data = await getWalletData(w)
    expect(data.total_upvotes).toBe(CONCURRENCY)
    expect(data.unlocked.map((a) => a.id)).toEqual(["community_voice"])
  })

  it("daily_claim streak advances across sequential calls", async () => {
    const w = wallet(4)
    await checkAndUnlock(w, { daily_claim: true })
    await checkAndUnlock(w, { daily_claim: true })
    expect((await getWalletData(w)).daily_streak).toBe(2)
  })
})

describe("notification-store: no lost updates", () => {
  it("caps concurrent notifications per wallet without losing the newest", async () => {
    const w = wallet(800)
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => createNotification(w, "signal_reply", { seq: i })),
    )
    const list = await getNotifications(w, 100)
    expect(list.length).toBe(50)
  })

  it("persists every wallet in a concurrent batch", async () => {
    const wallets = Array.from({ length: CONCURRENCY }, (_, i) => wallet(900 + i))
    const res = await createNotificationBatch(wallets, "new_follower", { ok: true })
    expect(res.succeeded).toBe(CONCURRENCY)
    expect(res.failed).toBe(0)
    for (const w of wallets) {
      expect((await getNotifications(w, 10)).length).toBe(1)
    }
  })

  it("does not lose notifications when a batch and singles interleave", async () => {
    const w = wallet(950)
    await Promise.all([
      createNotificationBatch([w], "signal_reply", { batch: true }),
      createNotification(w, "signal_upvote", { single: true }),
    ])
    const sources = (await getNotifications(w, 10)).map((n) => n.data)
    expect(sources).toContainEqual({ batch: true })
    expect(sources).toContainEqual({ single: true })
  })
})

describe("narrative-world-store: version and vector clock are race-free", () => {
  it("serializes concurrent world saves into distinct versions", async () => {
    const collectionId = 42
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        saveWorldForCollection(collectionId, {
          world_name: `world-${i}`,
          world_prompt: "p",
        }),
      ),
    )
    const saved = await getWorldForCollection(collectionId)
    // Every writer must have observed a distinct prior version, so the counter
    // has to reach the number of writers rather than collapsing to 1.
    expect(saved?.version).toBe(CONCURRENCY)
  })

  it("accumulates concurrent reader progress", async () => {
    const w = wallet(1000)
    const collectionId = 7
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => markNarrativeRead(w, collectionId, i)),
    )
    const read = await getReaderProgress(w, collectionId)
    expect(read.length).toBe(20)
  })
})

describe("market-store: profile view counters", () => {
  it("counts all 50 concurrent profile views", async () => {
    const creator = wallet(1100)
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        recordCreatorProfileView(
          { creator_wallet: creator, viewer_wallet: wallet(1200 + i), source: "profile" },
          { force: true },
        ),
      ),
    )
    const analytics = await getCreatorProfileViewAnalytics(creator)
    expect(analytics?.total_views).toBe(CONCURRENCY)
    expect(analytics?.unique_viewers).toBe(CONCURRENCY)
  })
})

describe("json-store primitives", () => {
  it("atomic write leaves no temp files behind", async () => {
    const file = path.join(dataDir, "atomic.json")
    await writeJsonFileAtomic(file, { ok: true })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ok: true })
    const entries = await readdir(dataDir)
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([])
  })

  it("atomic write overwrites an existing file completely", async () => {
    const file = path.join(dataDir, "atomic.json")
    await writeJsonFileAtomic(file, { big: "x".repeat(50_000) })
    await writeJsonFileAtomic(file, { small: true })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ small: true })
  })

  it("returns the fallback for a missing file", async () => {
    const missing = path.join(dataDir, "nope.json")
    expect(await readJsonFile(missing, { fallback: true })).toEqual({ fallback: true })
  })

  it("throws on a corrupt store instead of degrading to empty", async () => {
    const file = path.join(dataDir, "corrupt.json")
    await writeFile(file, "{ not json", "utf8")
    await expect(readJsonFile(file, {})).rejects.toThrow(/Corrupt JSON store/)
  })

  it("does not poison the lock chain when a mutation throws", async () => {
    const file = path.join(dataDir, "chain.json")
    await expect(
      updateJsonFile<{ n: number }, void>(file, {
        mutate: () => {
          throw new Error("boom")
        },
      }),
    ).rejects.toThrow(/boom/)

    await updateJsonFile<{ n: number }, void>(file, {
      mutate: (s) => {
        s.n = 1
      },
    })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ n: 1 })
  })

  it("serializes overlapping mutations on the same path", async () => {
    const file = path.join(dataDir, "serial.json")
    const order: string[] = []
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        updateJsonFile<{ seen: number[] }, void>(file, {
          mutate: async (s) => {
            order.push(`enter-${i}`)
            await new Promise((r) => setTimeout(r, 5))
            s.seen = [...(s.seen ?? []), i]
            order.push(`exit-${i}`)
          },
        }),
      ),
    )
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].replace("enter-", "")).toBe(order[i + 1].replace("exit-", ""))
    }
    expect(JSON.parse(await readFile(file, "utf8")).seen.length).toBe(5)
  })

  it("applies the read adapter before mutating", async () => {
    const file = path.join(dataDir, "adapter.json")
    await writeJsonFileAtomic(file, { legacy: 7 })
    const seen = await updateJsonFile<{ value: number }, number>(file, {
      read: (raw) => ({ value: (raw as { legacy?: number }).legacy ?? 0 }),
      mutate: (s) => {
        s.value += 1
        return s.value
      },
    })
    expect(seen).toBe(8)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ value: 8 })
  })
})
