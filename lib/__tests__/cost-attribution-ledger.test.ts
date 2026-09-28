import { describe, it, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import {
  recordRequestCost,
  getRequestCost,
  getCostLedger,
  summarizeCostByOperation,
  CostAttributionError,
  OPERATION_UNIT_COST,
  __resetCostLedgerForTests,
} from "@/lib/follow-store"

describe("phase-138 cost attribution ledger", () => {
  beforeEach(() => {
    __resetCostLedgerForTests()
    process.env.FEATURE_PHASE_138 = "1"
  })

  it("flag off: recording is a no-op and returns 0 units", () => {
    process.env.FEATURE_PHASE_138 = ""
    const units = recordRequestCost({ requestId: "r1", operation: "forge.request" })
    assert.equal(units, 0)
    assert.equal(getCostLedger().length, 0)
  })

  it("books the default unit weight per operation", () => {
    const units = recordRequestCost({ requestId: "r1", operation: "horizon.asset_holders" })
    assert.equal(units, OPERATION_UNIT_COST["horizon.asset_holders"])
    assert.equal(getRequestCost("r1").totalUnits, units)
  })

  it("scales cost by count and supports an explicit units override", () => {
    recordRequestCost({ requestId: "r2", operation: "profile.enrichment", count: 4 })
    recordRequestCost({ requestId: "r2", operation: "forge.request", units: 12.5 })
    const cost = getRequestCost("r2")
    assert.equal(cost.entries.length, 2)
    assert.equal(cost.totalUnits, OPERATION_UNIT_COST["profile.enrichment"] * 4 + 12.5)
  })

  it("aggregates a treasury summary across requests", () => {
    recordRequestCost({ requestId: "a", operation: "follow.write" })
    recordRequestCost({ requestId: "b", operation: "follow.write" })
    recordRequestCost({ requestId: "b", operation: "notification.create" })
    const s = summarizeCostByOperation()
    assert.equal(s.totalRequests, 2)
    assert.equal(s.byOperation["follow.write"]?.count, 2)
    assert.equal(s.totalUnits, s.byOperation["follow.write"]!.units + s.byOperation["notification.create"]!.units)
  })

  it("filters the ledger by operation", () => {
    recordRequestCost({ requestId: "a", operation: "follow.write" })
    recordRequestCost({ requestId: "a", operation: "horizon.account_lookup" })
    assert.equal(getCostLedger({ operation: "horizon.account_lookup" }).length, 1)
  })

  it("rejects a malformed payload with a typed error", () => {
    assert.throws(
      () => recordRequestCost({ requestId: "", operation: "not-an-op" }),
      (err: unknown) => {
        assert.ok(err instanceof CostAttributionError)
        assert.equal((err as CostAttributionError).code, "VALIDATION_FAILED")
        return true
      },
    )
  })

  it("isolates cost per requestId", () => {
    recordRequestCost({ requestId: "req-x", operation: "follow.suggestions" })
    recordRequestCost({ requestId: "req-y", operation: "forge.request" })
    assert.equal(getRequestCost("req-x").totalUnits, OPERATION_UNIT_COST["follow.suggestions"])
    assert.equal(getRequestCost("req-y").totalUnits, OPERATION_UNIT_COST["forge.request"])
  })
})
