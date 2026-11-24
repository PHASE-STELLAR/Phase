import { describe, it, beforeEach } from "vitest"
import * as assert from "node:assert/strict"
import {
  PHASE_ERROR_CODES,
  PHASE_ERROR_TAXONOMY,
  describePhaseErrorCode,
  isPhaseErrorTaxonomyEnabled,
  mapPhaseContractError,
  phaseErrorTaxonomyRollbackNote,
} from "@/lib/phase-error-taxonomy"

function enable(on: boolean) {
  if (on) {
    process.env.NEXT_PUBLIC_FEATURE_PHASE_161 = "1"
    process.env.FEATURE_PHASE_161 = "1"
  } else {
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_161
    delete process.env.FEATURE_PHASE_161
  }
}

describe("phase-161 phase error taxonomy", () => {
  beforeEach(() => enable(true))

  it("mirrors the contract discriminants 1..39", () => {
    assert.equal(PHASE_ERROR_CODES.length, 39)
    assert.equal(PHASE_ERROR_TAXONOMY[13].discriminant, "SelfTransfer")
    assert.equal(PHASE_ERROR_TAXONOMY[39].discriminant, "InvalidSchedule")
  })

  it("derives a stable snake_case user message key", () => {
    assert.equal(PHASE_ERROR_TAXONOMY[11].userMessageKey, "phase.error.nft_not_found")
    assert.equal(PHASE_ERROR_TAXONOMY[4].userMessageKey, "phase.error.unauthorized_token")
  })

  it("marks only transient failures retryable", () => {
    assert.equal(PHASE_ERROR_TAXONOMY[3].retryable, true)
    assert.equal(PHASE_ERROR_TAXONOMY[5].retryable, true)
    assert.equal(PHASE_ERROR_TAXONOMY[12].retryable, false)
  })

  it("describes a known code and returns null otherwise", () => {
    assert.equal(describePhaseErrorCode(2)!.discriminant, "InsufficientBalance")
    assert.equal(describePhaseErrorCode(999), null)
  })

  it("maps a raw host error carrying a contract code", () => {
    const descriptor = mapPhaseContractError(new Error("host invocation failed: Error(Contract, #11)"))
    assert.ok(descriptor)
    assert.equal(descriptor!.discriminant, "NftNotFound")
  })

  it("returns null for an unrecognized error shape", () => {
    assert.equal(mapPhaseContractError(new Error("network timeout")), null)
    assert.equal(mapPhaseContractError(null), null)
  })

  it("reflects the phase-161 flag and exposes a rollback note", () => {
    assert.equal(isPhaseErrorTaxonomyEnabled(), true)
    enable(false)
    assert.equal(isPhaseErrorTaxonomyEnabled(), false)
    assert.match(phaseErrorTaxonomyRollbackNote(), /phase-161/)
  })
})
