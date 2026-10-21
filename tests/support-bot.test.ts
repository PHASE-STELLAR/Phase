import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_150 = "1"
process.env.FEATURE_PHASE_150 = "1"

import {
  redactSensitiveData,
  diagnoseErrorTrace,
  processSupportQuery,
} from "@/lib/support-bot"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

function testSecretRedaction() {
  const secretSeed = "SBV4DY2T6ZPQYTRZ76A2J3P4P32XQW34P4K72XRP4P32XQW34P4K72XR"
  const rawLog = `Failed transaction with seed ${secretSeed} and secret 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`
  const cleaned = redactSensitiveData(rawLog)

  assert.ok(!cleaned.includes(secretSeed), "Seed must be redacted")
  assert.ok(cleaned.includes("[REDACTED_STELLAR_SEED]"))
  assert.ok(cleaned.includes("[REDACTED_PRIVATE_KEY]"))
}

function testErrorTaxonomy() {
  resetSecurityCounters()

  const gateDiagnosis = diagnoseErrorTrace("Error [ ERROR: BIOMETRIC_TRUST_GATE_CLOSED ] gate #13")
  assert.ok(gateDiagnosis)
  assert.equal(gateDiagnosis.code, "BIOMETRIC_TRUST_GATE_CLOSED")
  assert.equal(gateDiagnosis.category, "PROTOCOL_GATE")
  assert.equal(gateDiagnosis.retryable, false)
  assert.ok(gateDiagnosis.runbookSteps.length >= 2)
  assert.ok(getSecurityCounter("support_bot_errors_diagnosed") >= 1)

  const casDiagnosis = diagnoseErrorTrace("HTTP 409 If-Match stale version_conflict")
  assert.ok(casDiagnosis)
  assert.equal(casDiagnosis.code, "STALE_VERSION_CONFLICT")
  assert.equal(casDiagnosis.category, "CONCURRENCY_CONFLICT")
  assert.equal(casDiagnosis.retryable, true)
}

function testProcessSupportQuery() {
  resetSecurityCounters()

  // Query matching docs keyword
  const docRes = processSupportQuery("How do I setup a trustline with Horizon?")
  assert.ok(docRes.answer.includes("PHASERLIQ"))
  assert.ok(docRes.citations.includes("lib/classic-liq.ts"))
  assert.equal(docRes.escalateToHuman, false)
  assert.ok(getSecurityCounter("support_bot_queries_total") >= 1)

  // Query with unknown issue -> escalate
  const unkRes = processSupportQuery("Quantum teleportation failed in the chamber")
  assert.equal(unkRes.escalateToHuman, true)
}

testSecretRedaction()
testErrorTaxonomy()
testProcessSupportQuery()
