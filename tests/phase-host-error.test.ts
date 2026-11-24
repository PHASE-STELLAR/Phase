/**
 * phase-host-error unit tests
 * Tests error code parsing, secret redaction, and humanized error messages.
 */
import * as assert from "node:assert/strict"
import {
  parsePhaseContractErrorCode,
  humanizePhaseHostErrorMessage,
  redactHostErrorMessage,
} from "@/lib/phase-host-error"

const MOCK_ERROR_LINES = [
  "", // index 0 unused
  "Contract not initialized",
  "Unauthorized",
  "Invalid payment",
  "Token transfer failed",
  "NFT already minted",
  "Invalid signature",
  "Insufficient balance",
  "Token not found",
  "Invalid fee rate",
  "Oracle verification failed",
  "Quota exceeded",
  "Settlement timeout",
  "Biometric trust gate closed",
] as const

const UNKNOWN_TEMPLATE = "Unknown contract error: {code}"

function runTests() {
  console.log("Running phase-host-error tests...")

  // 1. parsePhaseContractErrorCode parsing formats
  assert.equal(parsePhaseContractErrorCode("HostError: Error(Contract, #13)"), 13)
  assert.equal(parsePhaseContractErrorCode("Simulation failed: Contract, #5 occurred"), 5)
  assert.equal(parsePhaseContractErrorCode("Error ( Contract , #1 )"), 1)
  assert.equal(parsePhaseContractErrorCode("Generic network timeout error"), null)

  // 2. parsePhaseContractErrorCode defensive type-handling
  assert.equal(parsePhaseContractErrorCode(new Error("HostError: Error(Contract, #7)")), 7)
  assert.equal(parsePhaseContractErrorCode(null), null)
  assert.equal(parsePhaseContractErrorCode(undefined), null)
  assert.equal(parsePhaseContractErrorCode(12345), null)

  // 3. redactHostErrorMessage secret protection
  const rawWithSecret = "Transaction failed with DISTRIBUTOR_SECRET=secret123 and Error(Contract, #2)"
  const sanitized = redactHostErrorMessage(rawWithSecret)
  assert.equal(sanitized.includes("secret123"), false)
  assert.equal(sanitized.includes("[REDACTED]"), true)

  const rawWithStellarKey = "Error on signer SBV2ABC123456789012345678901234567890123456789012345678A details"
  const sanitizedKey = redactHostErrorMessage(rawWithStellarKey)
  assert.equal(sanitizedKey.includes("SBV2ABC123456789012345678901234567890123456789012345678A"), false)
  assert.equal(sanitizedKey.includes("[REDACTED_SECRET_KEY]"), true)

  // 4. humanizePhaseHostErrorMessage
  assert.equal(
    humanizePhaseHostErrorMessage("HostError: Error(Contract, #13)", MOCK_ERROR_LINES, UNKNOWN_TEMPLATE),
    "Biometric trust gate closed",
  )
  assert.equal(
    humanizePhaseHostErrorMessage(new Error("HostError: Error(Contract, #2)"), MOCK_ERROR_LINES, UNKNOWN_TEMPLATE),
    "Unauthorized",
  )
  assert.equal(
    humanizePhaseHostErrorMessage("HostError: Error(Contract, #99)", MOCK_ERROR_LINES, UNKNOWN_TEMPLATE),
    "Unknown contract error: 99",
  )
  assert.equal(
    humanizePhaseHostErrorMessage("Regular unrelated error", MOCK_ERROR_LINES, UNKNOWN_TEMPLATE),
    null,
  )

  console.log("✅ All phase-host-error tests passed.")
}

runTests()
