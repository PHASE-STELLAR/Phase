import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import {
  getHorizonBulkheadMetrics,
  HORIZON_BULKHEAD_LIMIT,
  resetHorizonBulkheadMetrics,
  withHorizonBulkhead,
} from "@/lib/horizon-bulkhead"

describe("Horizon shared bulkhead", () => {
  beforeEach(() => resetHorizonBulkheadMetrics())

  it("never allows more than five owner reads in flight", async () => {
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 20 }, () => withHorizonBulkhead(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
      })),
    )
    assert.equal(peak, HORIZON_BULKHEAD_LIMIT)
    assert.equal(getHorizonBulkheadMetrics().inFlight, 0)
  })

  it("counts upstream 429s without leaking a permit", async () => {
    await assert.rejects(
      withHorizonBulkhead(async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 })
      }),
    )
    assert.equal(getHorizonBulkheadMetrics().horizon_429_batch, 1)
    assert.equal(getHorizonBulkheadMetrics().inFlight, 0)
  })
})
