import { describe, it, beforeAll as before, afterAll as after, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  touchesHighValueField,
  requestProfileChangeConfirmation,
  verifyProfileChangeConfirmation,
  clearPendingConfirmations,
  isProfile2faV2Enabled,
  issueSessionBound2faChallenge,
  verifySessionBound2faChallenge,
  initiateProfile2faRecovery,
  completeProfile2faRecovery,
  listProfile2faAudit,
  pickProfile2faCopy,
} from "@/lib/profile-2fa"
import { Keypair } from "@stellar/stellar-sdk"
import { getDb } from "@/lib/sqlite-db"

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

describe("phase-244 session-bound profile 2FA, lockout, and recovery (#695)", () => {
  const wallet = Keypair.random().publicKey()
  const sessionA = "session-hash-alpha"
  const sessionB = "session-hash-beta"

  before(() => {
    process.env.FEATURE_PHASE_244 = "1"
    process.env.PROFILE_2FA_MAX_ATTEMPTS = "3"
    process.env.PROFILE_2FA_LOCKOUT_MS = "60000"
  })

  after(() => {
    delete process.env.FEATURE_PHASE_244
    delete process.env.PROFILE_2FA_MAX_ATTEMPTS
    delete process.env.PROFILE_2FA_LOCKOUT_MS
  })

  it("gates on phase-244 flag", () => {
    assert.equal(isProfile2faV2Enabled(wallet), true)
    delete process.env.FEATURE_PHASE_244
    assert.equal(isProfile2faV2Enabled(wallet), false)
    process.env.FEATURE_PHASE_244 = "1"
  })

  it("binds challenges to the SEP-10 session and never stores raw codes", () => {
    const body = { wallet, display_name: "Neo" }
    const issued = issueSessionBound2faChallenge(wallet, sessionA, body, "en")
    assert.equal(issued.ok, true)
    if (!issued.ok) return

    const dbRows = JSON.stringify(getDb().prepare("SELECT * FROM profile_2fa_challenges").all())
    assert.equal(dbRows.includes(issued.code), false)
    assert.equal(dbRows.includes(wallet), false)

    const wrongSession = verifySessionBound2faChallenge(wallet, sessionB, body, issued.code, "en")
    assert.equal(wrongSession.ok, false)
    if (!wrongSession.ok) assert.equal(wrongSession.reason, "SESSION_MISMATCH")

    const ok = verifySessionBound2faChallenge(wallet, sessionA, body, issued.code, "en")
    assert.equal(ok.ok, true)
  })

  it("triggers lockout after configured attempts and supports auditable recovery + EN/ES copy", () => {
    const body = { wallet, twitter: "@phase" }
    const issued = issueSessionBound2faChallenge(wallet, sessionA, body, "es")
    assert.equal(issued.ok, true)

    const a1 = verifySessionBound2faChallenge(wallet, sessionA, body, "000001", "es")
    assert.equal(a1.ok, false)
    const a2 = verifySessionBound2faChallenge(wallet, sessionA, body, "000002", "es")
    assert.equal(a2.ok, false)
    const a3 = verifySessionBound2faChallenge(wallet, sessionA, body, "000003", "es")
    assert.equal(a3.ok, false)
    if (!a3.ok) {
      assert.equal(a3.reason, "LOCKED_OUT")
      assert.equal(a3.status, 429)
      assert.ok((a3.retryAfterSeconds ?? 0) > 0)
    }

    const recovery = initiateProfile2faRecovery(wallet, "user")
    const completed = completeProfile2faRecovery(wallet, recovery.recoveryCode, "es")
    assert.equal(completed.ok, true)

    const audit = listProfile2faAudit(wallet, 20)
    assert.ok(audit.some((e) => e.eventType === "lockout_triggered"))
    assert.ok(audit.some((e) => e.eventType === "recovery_initiated"))
    assert.ok(audit.some((e) => e.eventType === "recovery_completed"))

    assert.notEqual(pickProfile2faCopy("en").lockedOut, pickProfile2faCopy("es").lockedOut)
  })
})
