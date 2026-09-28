import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { submitTrustlineBatch } from "@/lib/classic-liq"

function rateLimitError(): Error {
  const e = new Error("rate limited") as Error & { response: { status: number } }
  e.response = { status: 429 }
  return e
}

describe("phase-134 batch trustline submission", () => {
  it("submits sequentially with no retry when the flag is off", async () => {
    delete process.env.FEATURE_PHASE_134
    let calls = 0
    const results = await submitTrustlineBatch(["xdr-a", "xdr-b"], {
      submit: async (xdr) => {
        calls++
        if (xdr === "xdr-a") throw rateLimitError()
        return { hash: `hash-${xdr}` }
      },
    })
    assert.equal(calls, 2)
    assert.equal(results.length, 2)
    assert.equal(results[0]!.ok, false)
    if (!results[0]!.ok) assert.equal(results[0]!.attempts, 1)
    assert.equal(results[1]!.ok, true)
  })

  it("retries 429s with backoff and succeeds when the flag is on", async () => {
    process.env.FEATURE_PHASE_134 = "1"
    let attempts = 0
    const results = await submitTrustlineBatch(["xdr-a"], {
      baseDelayMs: 5,
      submit: async (xdr) => {
        attempts++
        if (attempts < 3) throw rateLimitError()
        return { hash: `hash-${xdr}` }
      },
    })
    assert.equal(attempts, 3)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.ok, true)
    if (results[0]!.ok) assert.equal(results[0]!.attempts, 3)
    delete process.env.FEATURE_PHASE_134
  })

  it("gives up after maxRetries and reports the failure", async () => {
    process.env.FEATURE_PHASE_134 = "1"
    let attempts = 0
    const results = await submitTrustlineBatch(["xdr-a"], {
      baseDelayMs: 5,
      maxRetries: 2,
      submit: async () => {
        attempts++
        throw rateLimitError()
      },
    })
    assert.equal(attempts, 3) // initial attempt + 2 retries
    assert.equal(results[0]!.ok, false)
    if (!results[0]!.ok) assert.equal(results[0]!.attempts, 3)
    delete process.env.FEATURE_PHASE_134
  })

  it("does not retry non-rate-limit errors", async () => {
    process.env.FEATURE_PHASE_134 = "1"
    let attempts = 0
    const results = await submitTrustlineBatch(["xdr-a"], {
      baseDelayMs: 5,
      submit: async () => {
        attempts++
        throw new Error("bad sequence number")
      },
    })
    assert.equal(attempts, 1)
    assert.equal(results[0]!.ok, false)
    delete process.env.FEATURE_PHASE_134
  })

  it("processes every XDR under bounded concurrency and preserves result order", async () => {
    process.env.FEATURE_PHASE_134 = "1"
    const xdrs = ["xdr-1", "xdr-2", "xdr-3", "xdr-4", "xdr-5"]
    let inFlight = 0
    let maxInFlight = 0
    const results = await submitTrustlineBatch(xdrs, {
      concurrency: 2,
      submit: async (xdr) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 10))
        inFlight--
        return { hash: `hash-${xdr}` }
      },
    })
    assert.equal(results.length, 5)
    assert.ok(maxInFlight <= 2)
    for (let i = 0; i < xdrs.length; i++) {
      assert.equal(results[i]!.signedXdr, xdrs[i])
    }
    delete process.env.FEATURE_PHASE_134
  })
})
