import { describe, it, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  buildReadKey,
  coalesceSorobanRead,
  getReadCoalescerMetrics,
  resetReadCoalescer,
  readCoalescerRollbackNote,
} from "@/lib/soroban-read-coalescer"

const CONTRACT = "CAZKRXQWXKM4UNDB5FY4XVMWDKKZJ2EFKMNFCFH3WC7SHE7RCO7HOR6L"

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_158 = "1"
    process.env.FEATURE_PHASE_158 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_158
    delete process.env.FEATURE_PHASE_158
  }
}

describe("phase-158 soroban read coalescer", () => {
  beforeEach(() => {
    resetReadCoalescer()
    enable(true)
  })

  it("builds a stable key from contract, method, and args", () => {
    const a = buildReadKey(CONTRACT, "get_config", [1, "x"])
    const b = buildReadKey(CONTRACT, "get_config", [1, "x"])
    const c = buildReadKey(CONTRACT, "get_config", [2, "x"])
    assert.equal(a, b)
    assert.notEqual(a, c)
  })

  it("passes through the loader when the flag is off", async () => {
    enable(false)
    let calls = 0
    const loader = async () => {
      calls += 1
      return 42
    }
    await coalesceSorobanRead(CONTRACT, "balance", [], loader)
    await coalesceSorobanRead(CONTRACT, "balance", [], loader)
    assert.equal(calls, 2)
  })

  it("serves a fresh cached value without re-invoking the loader", async () => {
    let calls = 0
    const loader = async () => {
      calls += 1
      return calls
    }
    const first = await coalesceSorobanRead(CONTRACT, "get_config", [], loader)
    const second = await coalesceSorobanRead(CONTRACT, "get_config", [], loader)
    assert.equal(first, 1)
    assert.equal(second, 1)
    assert.equal(calls, 1)
    assert.equal(getReadCoalescerMetrics().hits, 1)
  })

  it("coalesces concurrent identical reads into one loader call", async () => {
    let calls = 0
    const loader = () =>
      new Promise<number>((resolve) => {
        calls += 1
        setTimeout(() => resolve(7), 10)
      })
    const [a, b] = await Promise.all([
      coalesceSorobanRead(CONTRACT, "owner_of", [5], loader),
      coalesceSorobanRead(CONTRACT, "owner_of", [5], loader),
    ])
    assert.equal(a, 7)
    assert.equal(b, 7)
    assert.equal(calls, 1)
    assert.equal(getReadCoalescerMetrics().coalesced, 1)
  })

  it("serves stale-on-error when enabled and a prior value exists", async () => {
    await coalesceSorobanRead(CONTRACT, "balance", ["G1"], async () => 99, { ttlMs: -1 })
    const recovered = await coalesceSorobanRead(
      CONTRACT,
      "balance",
      ["G1"],
      async () => {
        throw new Error("rpc down")
      },
      { staleOnError: true },
    )
    assert.equal(recovered, 99)
    assert.equal(getReadCoalescerMetrics().stale_served, 1)
  })

  it("exposes a rollback note", () => {
    assert.match(readCoalescerRollbackNote(), /phase-158/)
  })
})
