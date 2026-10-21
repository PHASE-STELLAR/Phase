/**
 * Module #57 (Issue #79) — Virtualize the Chamber NFT grid so 10k+ owned tokens
 * render without jank on low-end devices.
 *
 * AUDIT NOTE (execution flow, grid + avatar rendering):
 * Rendering every owned token mounts thousands of DOM nodes and fires thousands
 * of avatar fetches at once, freezing low-end devices. There was no shared,
 * testable windowing primitive — each surface (grid, avatar row) reimplemented
 * ad-hoc lazy loading.
 *
 * This module is the isolated, dependency-free domain for windowed rendering:
 *   - VirtualGridParamsSchema — type-safe windowing inputs
 *   - computeGridWindow()     — pure: which item indices are on screen (+ overscan),
 *     the spacer offset, and the total scroll height
 *   - computeColumnCount()    — responsive column count from container width
 *   - clampScrollTop() / sliceVisible() — supporting pure helpers
 *
 * It contains ZERO React / DOM / network imports so it can be unit-tested in
 * isolation with `npx tsx` and imported from both server and client code.
 *
 * Flag: phase-157 (NEXT_PUBLIC_FEATURE_PHASE_157 / FEATURE_PHASE_157). The math
 * is always available; the flag only gates whether call sites opt into the
 * wider overscan / batch behaviour (zero regression when off).
 *
 * Rollback: unset the flag. No persisted state.
 */

import { z } from "zod"

export function isNftGridVirtualizationEnabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_157 ??
    process.env.FEATURE_PHASE_157 ??
    ""
  )
    .trim()
    .toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag157RollbackNote(): string {
  return "Rollback phase-157: unset NEXT_PUBLIC_FEATURE_PHASE_157 / FEATURE_PHASE_157 or set 0/false and restart. No persisted state."
}

export const DEFAULT_OVERSCAN_ROWS = 3
/** IntersectionObserver rootMargin used by lazy-mounted avatars (wider when phase-157 is on). */
export const DEFAULT_OVERSCAN_PX = 240
export const LEGACY_OVERSCAN_PX = 50

export function nftGridOverscanPx(): number {
  return isNftGridVirtualizationEnabled() ? DEFAULT_OVERSCAN_PX : LEGACY_OVERSCAN_PX
}

export const VirtualGridParamsSchema = z.object({
  itemCount: z.number().int().min(0),
  rowHeight: z.number().positive(),
  columns: z.number().int().min(1),
  viewportHeight: z.number().min(0),
  scrollTop: z.number().min(0),
  overscanRows: z.number().int().min(0).default(DEFAULT_OVERSCAN_ROWS),
  gap: z.number().min(0).default(0),
})

export type VirtualGridParams = z.input<typeof VirtualGridParamsSchema>

export type VirtualGridWindow = {
  startRow: number
  endRow: number
  totalRows: number
  startIndex: number
  /** exclusive */
  endIndex: number
  visibleIndices: number[]
  /** translateY / padding-top for the spacer, in px */
  offsetY: number
  /** full scrollable height in px */
  totalHeight: number
}

export class VirtualGridError extends Error {
  readonly code: "VALIDATION_FAILED"
  readonly details?: unknown
  constructor(message: string, details?: unknown) {
    super(message)
    this.name = "VirtualGridError"
    this.code = "VALIDATION_FAILED"
    this.details = details
  }
}

/**
 * Pure — computes the on-screen item window for a fixed-row-height grid.
 * `rowHeight` is the stride between row tops (item height + gap is handled via
 * the `gap` field: stride = rowHeight + gap).
 */
export function computeGridWindow(rawParams: VirtualGridParams): VirtualGridWindow {
  const parsed = VirtualGridParamsSchema.safeParse(rawParams)
  if (!parsed.success) {
    throw new VirtualGridError("Virtual grid params failed schema validation", parsed.error.flatten())
  }
  const { itemCount, rowHeight, columns, viewportHeight, scrollTop, overscanRows, gap } = parsed.data

  const totalRows = Math.ceil(itemCount / columns)
  const stride = rowHeight + gap
  const totalHeight = totalRows === 0 ? 0 : totalRows * stride - gap

  if (itemCount === 0) {
    return {
      startRow: 0,
      endRow: 0,
      totalRows: 0,
      startIndex: 0,
      endIndex: 0,
      visibleIndices: [],
      offsetY: 0,
      totalHeight: 0,
    }
  }

  const clampedScrollTop = clampScrollTop(scrollTop, totalHeight, viewportHeight)
  const firstVisibleRow = Math.floor(clampedScrollTop / stride)
  const lastVisibleRow = Math.floor((clampedScrollTop + viewportHeight) / stride)

  const startRow = Math.max(0, firstVisibleRow - overscanRows)
  const endRow = Math.min(totalRows - 1, lastVisibleRow + overscanRows)

  const startIndex = startRow * columns
  const endIndex = Math.min(itemCount, (endRow + 1) * columns)

  const visibleIndices: number[] = []
  for (let i = startIndex; i < endIndex; i++) visibleIndices.push(i)

  return {
    startRow,
    endRow,
    totalRows,
    startIndex,
    endIndex,
    visibleIndices,
    offsetY: startRow * stride,
    totalHeight,
  }
}

export function clampScrollTop(
  scrollTop: number,
  totalHeight: number,
  viewportHeight: number,
): number {
  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return 0
  return Math.min(scrollTop, maxScroll)
}

/**
 * Pure — responsive column count from a container width. Mirrors a CSS
 * `repeat(auto-fill, minmax(minItemWidth, 1fr))` grid.
 */
export function computeColumnCount(
  containerWidth: number,
  minItemWidth: number,
  gap = 0,
): number {
  if (containerWidth <= 0 || minItemWidth <= 0) return 1
  const cols = Math.floor((containerWidth + gap) / (minItemWidth + gap))
  return Math.max(1, cols)
}

/** Generic — returns the slice of `items` covered by a computed window. */
export function sliceVisible<T>(items: readonly T[], win: VirtualGridWindow): T[] {
  return items.slice(win.startIndex, win.endIndex)
}
