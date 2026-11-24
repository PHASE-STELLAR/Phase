import { describe, it, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  NetworkUnreachableError,
  RateLimitError,
  TransportTimeoutError,
  UpstreamServerError,
  backoffDelayMs,
  classifyTransportError,
  isPhase214Enabled,
  mapPhaseError,
  parseRetryAfter,
  phase214RollbackNote,
  withTransportRetry,
} from "@/lib/phase-transport-error"
import { TRANSPORT_ERROR_TAXONOMY, TRANSPORT_ERROR_CODES, describeAnyPhaseError } from "@/lib/phase-error-taxonomy"
import { humanizePhaseError } from "@/lib/phase-error-presentation"

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_214 = "1"
    process.env.FEATURE_PHASE_214 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_214
    delete process.env.FEATURE_PHASE_214
  }
}

const LINES = ["", "legacy #1", "legacy #2"]
const UNKNOWN = "unknown #{code}"

describe("phase-214 transport classification", () => {
  beforeEach(() => enable(true))

  it("parses Retry-After seconds and HTTP dates, clamped", () => {
    assert.equal(parseRetryAfter("2", 1000), 2000)
    assert.equal(parseRetryAfter("  3.5 ", 0), 3500)
    assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 0), 5000)
    assert.equal(parseRetryAfter("nonsense", 0), null)
    assert.equal(parseRetryAfter(null, 0), null)
    assert.equal(parseRetryAfter("9999999", 0), 60_000)
  })

  it("classifies 429, 5xx, timeout and network errors with retryable hints", () => {
    const limited = classifyTransportError({ status: 429, message: "slow down", retryAfterMs: 1500 })
    assert.ok(limited instanceof RateLimitError)
    assert.equal(limited!.retryable, true)
    assert.equal(limited!.retryAfterMs, 1500)
    assert.equal(limited!.descriptor.userMessageKey, "phase.error.transport_rate_limited")

    const server = classifyTransportError(Object.assign(new Error("bad gateway"), { status: 503 }))
    assert.ok(server instanceof UpstreamServerError)
    assert.equal(server!.descriptor.retryable, true)

    const timeout = classifyTransportError(Object.assign(new Error("boom"), { name: "AbortError" }))
    assert.ok(timeout instanceof TransportTimeoutError)

    const network = classifyTransportError(new Error("connect ECONNREFUSED 10.0.0.1"))
    assert.ok(network instanceof NetworkUnreachableError)

    assert.equal(classifyTransportError(new Error("Error(Contract, #11)")), null)
  })

  it("maps transport codes into the same descriptor shape without touching 1..39", () => {
    assert.equal(TRANSPORT_ERROR_TAXONOMY[TRANSPORT_ERROR_CODES.RATE_LIMITED].retryable, true)
    assert.equal(describeAnyPhaseError(11)!.discriminant, "NftNotFound")
    assert.equal(describeAnyPhaseError(TRANSPORT_ERROR_CODES.TIMEOUT)!.discriminant, "TransportTimeout")
    assert.equal(mapPhaseError({ status: 500 })!.code, TRANSPORT_ERROR_CODES.UPSTREAM_5XX)
  })

  it("honours Retry-After and keeps backoff bounded with jitter", () => {
    assert.equal(backoffDelayMs(50, null, { maxDelayMs: 8000 }, () => 0.5), 8000)
    const low = backoffDelayMs(1, null, { baseDelayMs: 1000, jitterRatio: 0.2 }, () => 0)
    const high = backoffDelayMs(1, null, { baseDelayMs: 1000, jitterRatio: 0.2 }, () => 1)
    assert.ok(low >= 1600 && low <= 2000)
    assert.ok(high >= 2000 && high <= 2400)
    assert.equal(backoffDelayMs(0, 5000, { baseDelayMs: 250 }, () => 0.5), 5000)
  })

  it("bounds retries and propagates the last error", async () => {
    let attempts = 0
    const sleeps: number[] = []
    await assert.rejects(
      withTransportRetry(
        async () => {
          attempts += 1
          throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 3000 })
        },
        { maxAttempts: 3, sleep: async (ms) => { sleeps.push(ms) } },
      ),
    )
    assert.equal(attempts, 3)
    assert.equal(sleeps.length, 2)
    assert.ok(sleeps.every((ms) => ms >= 3000 && ms <= 60_000))
  })

  it("does not retry non-transport errors", async () => {
    let attempts = 0
    await assert.rejects(
      withTransportRetry(
        async () => {
          attempts += 1
          throw new Error("Error(Contract, #12)")
        },
        { sleep: async () => undefined },
      ),
    )
    assert.equal(attempts, 1)
  })
})

describe("phase-214 caller migration", () => {
  it("uses legacy string helpers when the flag is off", () => {
    enable(false)
    assert.equal(isPhase214Enabled(), false)
    assert.equal(humanizePhaseError("Error(Contract, #2)", LINES, UNKNOWN, "es"), "legacy #2")
    assert.equal(
      humanizePhaseError(Object.assign(new Error("429"), { status: 429 }), LINES, UNKNOWN, "es"),
      null,
    )
    assert.match(phase214RollbackNote(), /phase-214/)
  })

  it("returns localized transport copy when the flag is on", () => {
    enable(true)
    const message = humanizePhaseError(
      Object.assign(new Error("429"), { status: 429 }),
      LINES,
      UNKNOWN,
      "es",
    )
    assert.match(message ?? "", /limitando/)
  })
})
