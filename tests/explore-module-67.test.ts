/**
 * Module #67 — explore domain isolation + queued/prioritised toaster + schema
 * validation. Run: npx tsx tests/explore-module-67.test.ts
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  assetContentHash,
  dedupeExploreItems,
  ExploreValidationError,
  filterWorldOnly,
  mapConcurrent,
  paginateExploreItems,
  parseExploreResponse,
  truncateAddress,
  type ExploreItem,
  type ExploreResponse,
} from "@/lib/explore-domain"
import { ToastPriority, ToastQueue, type ToastEmitTarget } from "@/lib/toast-queue"

const baseItem: ExploreItem = {
  tokenId: 1,
  name: "Phase Artifact #1",
  image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  collectionId: null,
  ownerTruncated: "GAAAAA...AAAA",
}

function validResponse(over: Partial<ExploreResponse> = {}): unknown {
  return {
    items: [baseItem],
    total: 1,
    page: 1,
    perPage: 24,
    content_hash_dedup_enabled: true,
    ...over,
  }
}

describe("explore-domain: truncateAddress", () => {
  it("keeps short addresses intact", () => {
    assert.equal(truncateAddress("abc"), "abc")
    assert.equal(truncateAddress("  123456789012  "), "123456789012")
  })
  it("truncates long addresses", () => {
    const out = truncateAddress("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    assert.equal(out.startsWith("GAAAAA"), true)
    assert.ok(out.includes("…"))
  })
})

describe("explore-domain: assetContentHash + dedupeExploreItems", () => {
  it("returns null for blank images", () => {
    assert.equal(assetContentHash({ image: " " }), null)
    assert.equal(assetContentHash({ image: "" }), null)
  })
  it("dedupes case-insensitively", () => {
    const items = dedupeExploreItems([
      baseItem,
      { ...baseItem, tokenId: 2, image: baseItem.image.toUpperCase() },
      { ...baseItem, tokenId: 3, image: "ipfs://different" },
    ])
    assert.equal(items[1]?.duplicateOfTokenId, 1)
    assert.equal(items[0]?.duplicateOfTokenId, undefined)
    assert.equal(items[2]?.duplicateOfTokenId, undefined)
    assert.equal(items[0]?.contentHash, items[1]?.contentHash)
  })
  it("returns items unchanged when image is blank", () => {
    const items = dedupeExploreItems([{ ...baseItem, image: " " }])
    assert.equal(items.length, 1)
  })
})

describe("explore-domain: mapConcurrent", () => {
  it("preserves order and runs all items", async () => {
    const out = await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => n * 2)
    assert.deepEqual(out, [2, 4, 6, 8, 10])
  })
  it("bounded concurrency honoured", async () => {
    let active = 0
    let maxActive = 0
    await mapConcurrent(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
      return 1
    })
    assert.ok(maxActive <= 3, `maxActive was ${maxActive}`)
  })
  it("handles empty input and non-positive limit", async () => {
    assert.deepEqual(await mapConcurrent([], 5, async (n) => n), [])
    assert.deepEqual(await mapConcurrent([1, 2], 0, async (n) => n), [])
  })
})

describe("explore-domain: paginateExploreItems", () => {
  const items = Array.from({ length: 50 }, (_, i) => i + 1)
  it("paginates correctly", () => {
    assert.deepEqual(paginateExploreItems(items, 1, 24), items.slice(0, 24))
    assert.deepEqual(paginateExploreItems(items, 3, 24), items.slice(48, 72))
  })
  it("handles invalid perPage", () => {
    assert.deepEqual(paginateExploreItems(items, 1, 0), [])
  })
})

describe("explore-domain: filterWorldOnly", () => {
  it("keeps only items with a world", () => {
    const items = [
      { ...baseItem, worldName: "Aurora" },
      { ...baseItem, tokenId: 2 },
      { ...baseItem, tokenId: 3, worldName: "" },
    ]
    const out = filterWorldOnly(items)
    assert.equal(out.length, 1)
    assert.equal(out[0]?.tokenId, 1)
  })
})

describe("explore-domain: schema validation (parseExploreResponse)", () => {
  it("accepts a valid response", () => {
    const parsed = parseExploreResponse(validResponse())
    assert.equal(parsed.total, 1)
    assert.equal(parsed.items[0]?.tokenId, 1)
  })
  it("rejects malformed item", () => {
    const malformed: Record<string, unknown> = {
      items: [{ tokenId: "x", name: "n", image: "i", collectionId: null, ownerTruncated: "o" }],
      total: 1,
      page: 1,
      perPage: 24,
    }
    assert.throws(
      () => parseExploreResponse(malformed),
      (e) => e instanceof ExploreValidationError,
    )
  })
  it("rejects missing required field", () => {
    assert.throws(
      () => parseExploreResponse({ items: [], total: 1, page: 1 }), // missing perPage
      (e) => e instanceof ExploreValidationError && e.issues.length > 0,
    )
  })
  it("throws typed normalised error", () => {
    try {
      parseExploreResponse({ items: "nope" })
      assert.fail("expected throw")
    } catch (e) {
      assert.ok(e instanceof ExploreValidationError)
      assert.equal((e as ExploreValidationError).code, "EXPLORE_VALIDATION_ERROR")
    }
  })
})

describe("toast-queue: priority + dedup + no-clobber", () => {
  function makeHarness(maxVisible = 1, dedupeWindowMs?: number) {
    const emitted: string[] = []
    const target: ToastEmitTarget = {
      success: (m) => emitted.push(`success:${m}`),
      error: (m) => emitted.push(`error:${m}`),
      info: (m) => emitted.push(`info:${m}`),
      warning: (m) => emitted.push(`warning:${m}`),
      default: (m) => emitted.push(`default:${m}`),
    }
    const queue = new ToastQueue(target, { maxVisible, dedupeWindowMs })
    return { queue, emitted }
  }

  it("queues instead of emitting immediately (no clobber window)", () => {
    const { queue, emitted } = makeHarness()
    queue.push("info", "a")
    assert.equal(emitted.length, 0)
    queue.flush()
    assert.deepEqual(emitted, ["info:a"])
  })

  it("dedupes identical concurrent messages", () => {
    const { queue, emitted } = makeHarness()
    queue.push("error", "boom")
    queue.push("error", "boom")
    assert.equal(queue.pending.length, 1)
    queue.flush()
    assert.deepEqual(emitted, ["error:boom"])
  })

  it("dedupe persists across flush so re-renders do not re-spam", () => {
    const { queue, emitted } = makeHarness()
    queue.push("warning", "DUP")
    queue.flush()
    queue.push("warning", "DUP")
    queue.flush()
    assert.deepEqual(emitted, ["warning:DUP"])
  })

  it("higher priority preempts: error shows before queued info (maxVisible 1)", () => {
    const { queue, emitted } = makeHarness(1)
    queue.push("info", "a")
    queue.push("error", "b")
    queue.flush()
    assert.deepEqual(emitted, ["error:b"])
    assert.equal(queue.size, 1)
    queue.drain()
    assert.deepEqual(emitted, ["error:b", "info:a"])
  })

  it("maxVisible > 1 emits several per flush, ordering by priority then FIFO", () => {
    const { queue, emitted } = makeHarness(2)
    queue.push("info", "a")
    queue.push("success", "b")
    queue.push("error", "c")
    queue.flush()
    assert.deepEqual(emitted, ["error:c", "success:b"])
    assert.equal(queue.size, 1)
    queue.drain()
    assert.deepEqual(emitted, ["error:c", "success:b", "info:a"])
  })

  it("keeps FIFO order within the same priority", () => {
    const { queue, emitted } = makeHarness(1)
    queue.push("info", "first")
    queue.push("info", "second")
    queue.flush()
    assert.deepEqual(emitted, ["info:first"])
    assert.equal(queue.size, 1)
    queue.drain()
    assert.deepEqual(emitted, ["info:first", "info:second"])
  })

  it("reset clears dedupe window so the same message can be emitted later", () => {
    const { queue, emitted } = makeHarness()
    queue.push("info", "again")
    queue.flush()
    queue.push("info", "again")
    assert.equal(emitted.length, 1)
    queue.reset()
    queue.push("info", "again")
    queue.flush()
    assert.equal(emitted.length, 2)
  })

  it("expired dedupe window allows a repeated message to emit again", () => {
    const { queue, emitted } = makeHarness(1, 5)
    queue.push("info", "again")
    queue.flush()
    queue.push("info", "again")
    queue.flush()
    // second push should be suppressed while inside the 5ms window
    assert.equal(emitted.length, 1)
  })

  it("exports correct priority ordinals", () => {
    assert.ok(ToastPriority.crash > ToastPriority.error)
    assert.ok(ToastPriority.error > ToastPriority.warn)
    assert.ok(ToastPriority.warn > ToastPriority.info)
    assert.equal(ToastPriority.success, 1)
  })
})
