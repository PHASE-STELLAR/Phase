import { describe, it, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import { Keypair } from "@stellar/stellar-sdk"
import { ComplianceError } from "@/lib/compliance"
import { FaucetTurnstileError } from "@/lib/faucet-turnstile"
import {
  evaluatePreCreditGate,
  isPreCreditGateEnabled,
  type PreCreditGateDeps,
} from "@/lib/faucet-pre-credit-gate"
import { getDb } from "@/lib/sqlite-db"

function passingDeps(): PreCreditGateDeps {
  return {
    checkDenyList: async () => false,
    isTurnstileRequired: () => true,
    verifyTurnstile: async () => true,
    checkSybil: async () => ({ allowed: true, score: 85 }),
    checkCompliance: async () => undefined,
  }
}

describe("phase-247 unified pre-credit gate (#698)", () => {
  const wallet = Keypair.random().publicKey()
  const clientIp = "203.0.113.42"
  const turnstileToken = "cf-turnstile-secret-token-sample"

  beforeEach(() => {
    process.env.FEATURE_PHASE_247 = "1"
    process.env.PHASE_PRE_CREDIT_HASH_KEY = "test-pre-credit-hash-key-32bytes-minimum"
  })

  afterEach(() => {
    delete process.env.FEATURE_PHASE_247
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_247
    delete process.env.PHASE_PRE_CREDIT_HASH_KEY
  })

  it("returns null when phase-247 flag is off (legacy gate order)", async () => {
    delete process.env.FEATURE_PHASE_247
    assert.equal(isPreCreditGateEnabled(wallet), false)
    const res = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", turnstileToken, clientIp },
      passingDeps(),
    )
    assert.equal(res, null)
  })

  it("admits credit when all four gates pass and persists only keyed hashes", async () => {
    const res = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", turnstileToken, clientIp },
      passingDeps(),
    )
    assert.ok(res)
    assert.equal(res.allowed, true)
    assert.equal(res.blockingGate, "none")
    assert.equal(res.reasonCode, "admitted")
    assert.equal(res.status, 200)

    const row = getDb()
      .prepare("SELECT * FROM pre_credit_gate_decisions WHERE decision_id = ?")
      .get(res.decisionId) as Record<string, unknown> | undefined
    assert.ok(row)
    const serialized = JSON.stringify(row)
    assert.equal(serialized.includes(wallet), false)
    assert.equal(serialized.includes(clientIp), false)
    assert.equal(serialized.includes(turnstileToken), false)
  })

  it("blocks independently on deny-list", async () => {
    const res = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", turnstileToken, clientIp },
      { ...passingDeps(), checkDenyList: async () => true },
    )
    assert.ok(res)
    assert.equal(res.allowed, false)
    assert.equal(res.blockingGate, "deny_list")
    assert.equal(res.reasonCode, "wallet_denied")
    assert.equal(res.status, 403)
  })

  it("blocks independently on Turnstile missing or invalid token", async () => {
    const missing = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", clientIp },
      passingDeps(),
    )
    assert.ok(missing)
    assert.equal(missing.allowed, false)
    assert.equal(missing.blockingGate, "turnstile")
    assert.equal(missing.reasonCode, "turnstile_required")
    assert.equal(missing.status, 400)

    const invalid = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", turnstileToken, clientIp },
      {
        ...passingDeps(),
        verifyTurnstile: async () => {
          throw new FaucetTurnstileError("TOKEN_INVALID", "bad token")
        },
      },
    )
    assert.ok(invalid)
    assert.equal(invalid.allowed, false)
    assert.equal(invalid.blockingGate, "turnstile")
    assert.equal(invalid.reasonCode, "turnstile_failed")
    assert.equal(invalid.status, 403)
  })

  it("blocks independently on sybil gate", async () => {
    const res = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", turnstileToken, clientIp },
      { ...passingDeps(), checkSybil: async () => ({ allowed: false, score: 12 }) },
    )
    assert.ok(res)
    assert.equal(res.allowed, false)
    assert.equal(res.blockingGate, "sybil")
    assert.equal(res.reasonCode, "sybil_blocked")
    assert.equal(res.status, 403)
  })

  it("blocks independently on compliance gate", async () => {
    const res = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", turnstileToken, clientIp },
      {
        ...passingDeps(),
        checkCompliance: async () => {
          throw new ComplianceError("SANCTIONS_BLOCKED", 403)
        },
      },
    )
    assert.ok(res)
    assert.equal(res.allowed, false)
    assert.equal(res.blockingGate, "compliance")
    assert.equal(res.reasonCode, "compliance_blocked")
    assert.equal(res.status, 403)
  })

  it("fails closed with 503 + Retry-After on provider outage", async () => {
    const turnstileOutage = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", turnstileToken, clientIp, retryAfterSeconds: 45 },
      {
        ...passingDeps(),
        verifyTurnstile: async () => {
          throw new FaucetTurnstileError("TIMEOUT", "upstream timeout")
        },
      },
    )
    assert.ok(turnstileOutage)
    assert.equal(turnstileOutage.allowed, false)
    assert.equal(turnstileOutage.status, 503)
    assert.equal(turnstileOutage.retryAfterSeconds, 45)
    assert.equal(turnstileOutage.reasonCode, "provider_outage")

    const complianceOutage = await evaluatePreCreditGate(
      { wallet, amountStroops: "20000000", turnstileToken, clientIp },
      {
        ...passingDeps(),
        checkCompliance: async () => {
          throw new ComplianceError("SCREENING_UNAVAILABLE", 503)
        },
      },
    )
    assert.ok(complianceOutage)
    assert.equal(complianceOutage.allowed, false)
    assert.equal(complianceOutage.status, 503)
    assert.ok((complianceOutage.retryAfterSeconds ?? 0) > 0)
    assert.equal(complianceOutage.reasonCode, "provider_outage")
  })
})
