import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { z } from "zod"
import {
  classifyProfileError,
  toProfileErrorResponse,
  ProfileError,
  ProfileErrorResponseSchema,
  PROFILE_ERROR_CODES,
} from "@/lib/profile-store"

describe("phase-137 structured profile error taxonomy", () => {
  it("passes a ProfileError through unchanged", () => {
    const original = new ProfileError("AVATAR_NOT_FOUND", "no avatar")
    assert.equal(classifyProfileError(original), original)
    assert.equal(original.status, 404)
    assert.equal(original.retryable, false)
  })

  it("maps fetch timeouts to a retryable GATEWAY_TIMEOUT (504)", () => {
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    const e = classifyProfileError(abort)
    assert.equal(e.code, "GATEWAY_TIMEOUT")
    assert.equal(e.status, 504)
    assert.equal(e.retryable, true)
    assert.equal(e.category, "upstream")
  })

  it("maps DNS / connection failures to GATEWAY_UNREACHABLE (502, retryable)", () => {
    const e = classifyProfileError(new Error("fetch failed: ECONNREFUSED"))
    assert.equal(e.code, "GATEWAY_UNREACHABLE")
    assert.equal(e.retryable, true)
  })

  it("maps checksum / tamper errors to a non-retryable CHECKSUM_MISMATCH", () => {
    const cid = Object.assign(new Error("Cached bytes fail integrity check"), { name: "CidIntegrityError" })
    const e = classifyProfileError(cid)
    assert.equal(e.code, "CHECKSUM_MISMATCH")
    assert.equal(e.category, "integrity")
    assert.equal(e.retryable, false)
  })

  it("maps an upstream { status } onto the taxonomy", () => {
    assert.equal(classifyProfileError(Object.assign(new Error("x"), { status: 503 })).code, "GATEWAY_5XX")
    assert.equal(classifyProfileError(Object.assign(new Error("x"), { status: 404 })).code, "GATEWAY_4XX")
    assert.equal(classifyProfileError(Object.assign(new Error("x"), { status: 429 })).code, "RATE_LIMITED")
  })

  it("maps Zod parse failures to MALFORMED_RESPONSE", () => {
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 })
    assert.equal(parsed.success, false)
    if (!parsed.success) {
      assert.equal(classifyProfileError(parsed.error).code, "MALFORMED_RESPONSE")
    }
  })

  it("falls back to INTERNAL (500) for unknown values", () => {
    assert.equal(classifyProfileError("boom").code, "INTERNAL")
    assert.equal(classifyProfileError(undefined).status, 500)
  })

  it("toProfileErrorResponse yields a schema-valid body + deterministic status", () => {
    const { body, status } = toProfileErrorResponse(new ProfileError("PIN_QUORUM_FAILED", "2/3 gateways", { achieved: 2 }))
    assert.equal(status, 502)
    assert.doesNotThrow(() => ProfileErrorResponseSchema.parse(body))
    assert.equal(body.retryable, true)
  })

  it("every code has a spec and serializes cleanly", () => {
    for (const code of PROFILE_ERROR_CODES) {
      const res = new ProfileError(code, code).toResponse()
      assert.doesNotThrow(() => ProfileErrorResponseSchema.parse(res))
    }
  })
})
