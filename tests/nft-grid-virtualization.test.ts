/**
 * Module #57 (Issue #79) — NFT grid virtualization windowing math.
 * Run: npx tsx tests/nft-grid-virtualization.test.ts
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"

import {
  computeGridWindow,
  computeColumnCount,
  clampScrollTop,
  sliceVisible,
  nftGridOverscanPx,
  isNftGridVirtualizationEnabled,
  VirtualGridError,
  DEFAULT_OVERSCAN_PX,
  LEGACY_OVERSCAN_PX,
} from "@/lib/nft-grid-virtualization"

describe("computeColumnCount", () => {
  it("mirrors auto-fill minmax behaviour", () => {
    assert.equal(computeColumnCount(1000, 200, 0), 5)
    assert.equal(computeColumnCount(1000, 200, 16), 4) // (1000+16)/(216) = 4.7 -> 4
    assert.equal(computeColumnCount(100, 200, 0), 1)
    assert.equal(computeColumnCount(0, 200, 0), 1)
  })
})

describe("clampScrollTop", () => {
  it("clamps to [0, totalHeight - viewportHeight]", () => {
    assert.equal(clampScrollTop(-50, 1000, 300), 0)
    assert.equal(clampScrollTop(50_000, 1000, 300), 700)
    assert.equal(clampScrollTop(400, 1000, 300), 400)
    assert.equal(clampScrollTop(Number.NaN, 1000, 300), 0)
  })
})

describe("computeGridWindow", () => {
  it("returns an empty window for zero items", () => {
    const win = computeGridWindow({
      itemCount: 0,
      rowHeight: 100,
      columns: 4,
      viewportHeight: 600,
      scrollTop: 0,
    })
    assert.deepEqual(win.visibleIndices, [])
    assert.equal(win.totalHeight, 0)
    assert.equal(win.endIndex, 0)
  })

  it("windows a large grid to a small visible slice near the top", () => {
    const win = computeGridWindow({
      itemCount: 10_000,
      rowHeight: 200,
      columns: 5,
      viewportHeight: 800,
      scrollTop: 0,
      overscanRows: 2,
      gap: 0,
    })
    // 10000 / 5 = 2000 rows; row stride 200; total height 400000
    assert.equal(win.totalRows, 2000)
    assert.equal(win.totalHeight, 400_000)
    assert.equal(win.startIndex, 0)
    // visible rows 0..4 (800/200) + 2 overscan => rows 0..6 => 7*5 = 35 items
    assert.equal(win.endIndex, 35)
    assert.equal(win.visibleIndices.length, 35)
    assert.ok(win.visibleIndices.length < 100, "must not materialize the whole grid")
  })

  it("advances the window and spacer offset when scrolled", () => {
    const win = computeGridWindow({
      itemCount: 10_000,
      rowHeight: 200,
      columns: 5,
      viewportHeight: 800,
      scrollTop: 100_000, // row 500
      overscanRows: 2,
    })
    assert.equal(win.startRow, 498)
    assert.equal(win.startIndex, 498 * 5)
    assert.equal(win.offsetY, 498 * 200)
    assert.ok(win.visibleIndices[0] === 2490)
  })

  it("does not run past the last row when scrolled to the bottom", () => {
    const win = computeGridWindow({
      itemCount: 103, // 26 rows at 4 cols (last row has 3)
      rowHeight: 100,
      columns: 4,
      viewportHeight: 500,
      scrollTop: 999_999,
      overscanRows: 1,
    })
    assert.equal(win.totalRows, 26)
    assert.equal(win.endRow, 25)
    assert.equal(win.endIndex, 103)
    assert.equal(win.visibleIndices[win.visibleIndices.length - 1], 102)
  })

  it("accounts for row gap in stride and total height", () => {
    const win = computeGridWindow({
      itemCount: 12,
      rowHeight: 100,
      columns: 3,
      viewportHeight: 250,
      scrollTop: 0,
      gap: 20,
    })
    // 4 rows, stride 120, totalHeight = 4*120 - 20 = 460
    assert.equal(win.totalRows, 4)
    assert.equal(win.totalHeight, 460)
  })

  it("throws a typed error on malformed params", () => {
    assert.throws(
      () => computeGridWindow({ itemCount: -1, rowHeight: 0, columns: 0, viewportHeight: -5, scrollTop: -1 }),
      (e: unknown) => e instanceof VirtualGridError && e.code === "VALIDATION_FAILED",
    )
  })
})

describe("sliceVisible", () => {
  it("returns only the windowed items", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i)
    const win = computeGridWindow({
      itemCount: items.length,
      rowHeight: 100,
      columns: 4,
      viewportHeight: 400,
      scrollTop: 0,
      overscanRows: 1,
    })
    const slice = sliceVisible(items, win)
    assert.equal(slice[0], win.startIndex)
    assert.equal(slice.length, win.endIndex - win.startIndex)
  })
})

describe("overscan flag gate", () => {
  it("widens overscan only when phase-157 is enabled", () => {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_157
    delete process.env.FEATURE_PHASE_157
    assert.equal(isNftGridVirtualizationEnabled(), false)
    assert.equal(nftGridOverscanPx(), LEGACY_OVERSCAN_PX)

    process.env.FEATURE_PHASE_157 = "1"
    assert.equal(isNftGridVirtualizationEnabled(), true)
    assert.equal(nftGridOverscanPx(), DEFAULT_OVERSCAN_PX)
    delete process.env.FEATURE_PHASE_157
  })
})
