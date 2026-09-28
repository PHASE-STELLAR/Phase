import { describe, it, before, after, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import {
  touchesHighValueField,
  requestProfileChangeConfirmation,
  verifyProfileChangeConfirmation,
  clearPendingConfirmations,
} from "@/lib/profile-2fa"

describe("phase-104 profile two-factor confirmation", () => {
  before(() => {
    process.env.FEATURE_PHASE_104 = "1"
  })
  after(() => {
    process.env.FEATURE_PHASE_104 = ""
  })
  beforeEach(() => clearPendingConfirmations())

  it("detects high-value fields", () => {
    assert.equal(touchesHighValueField({ display_name: "Neo" }), true)
    assert.equal(touchesHighValueField({ avatar_token_id: 7 }), false)
    assert.equal(touchesHighValueField({}), false)
  })

  it("accepts a matching, unexpired code", () => {
    const wallet = "GABCDEFGHIJKLMNOP"
    const body = { wallet, display_name: "Neo" }
    const { code } = requestProfileChangeConfirmation(wallet, body)
    const result = verifyProfileChangeConfirmation(wallet, body, code)
    assert.equal(result.ok, true)
  })

  it("rejects a missing code", () => {
    const wallet = "GABCDEFGHIJKLMNOP"
    const body = { wallet, display_name: "Neo" }
    requestProfileChangeConfirmation(wallet, body)
    const result = verifyProfileChangeConfirmation(wallet, body, undefined)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, "MISSING_CODE")
  })

  it("rejects a wrong code", () => {
    const wallet = "GABCDEFGHIJKLMNOP"
    const body = { wallet, display_name: "Neo" }
    requestProfileChangeConfirmation(wallet, body)
    const result = verifyProfileChangeConfirmation(wallet, body, "000000")
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, "CODE_MISMATCH")
  })

  it("rejects when the payload changed after the code was issued", () => {
    const wallet = "GABCDEFGHIJKLMNOP"
    const { code } = requestProfileChangeConfirmation(wallet, { wallet, display_name: "Neo" })
    const result = verifyProfileChangeConfirmation(wallet, { wallet, display_name: "Trinity" }, code)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, "PAYLOAD_CHANGED")
  })

  it("is single-use", () => {
    const wallet = "GABCDEFGHIJKLMNOP"
    const body = { wallet, display_name: "Neo" }
    const { code } = requestProfileChangeConfirmation(wallet, body)
    assert.equal(verifyProfileChangeConfirmation(wallet, body, code).ok, true)
    const second = verifyProfileChangeConfirmation(wallet, body, code)
    assert.equal(second.ok, false)
    if (!second.ok) assert.equal(second.reason, "NO_PENDING_REQUEST")
  })
})
