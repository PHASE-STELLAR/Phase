import { describe, it, expect, beforeEach } from "vitest"
import {
  XBULL_ID,
  xbullRollbackNote,
  isXBullModuleId,
  normalizeXBullSignResult,
  mapXBullError,
  recordXBullSignRequested,
  recordXBullSignSuccess,
  recordXBullTrustlineSigned,
  XBULL_FREIGHTER_DIFFERENCE_MATRIX,
} from "@/lib/xbull-adapter"
import { resetSecurityCounters, getSecurityCounter } from "@/lib/security-counters"

describe("spike 624: xBull wallet full support and Freighter-difference matrix (phase-168)", () => {
  beforeEach(() => {
    resetSecurityCounters()
  })

  it("exposes rollback notes mentioning phase-168", () => {
    expect(xbullRollbackNote()).toContain("phase-168")
  })

  it("identifies xBull module IDs correctly", () => {
    expect(isXBullModuleId(XBULL_ID)).toBe(true)
    expect(isXBullModuleId("xbull")).toBe(true)
    expect(isXBullModuleId("xBull Wallet")).toBe(true)
    expect(isXBullModuleId("freighter")).toBe(false)
    expect(isXBullModuleId("albedo")).toBe(false)
    expect(isXBullModuleId(undefined)).toBe(false)
  })

  it("contains difference matrix items with required dimensions", () => {
    expect(XBULL_FREIGHTER_DIFFERENCE_MATRIX.length).toBeGreaterThanOrEqual(4)
    const dimensions = XBULL_FREIGHTER_DIFFERENCE_MATRIX.map((d) => d.dimension)
    expect(dimensions).toContain("Sign Result Shape")
    expect(dimensions).toContain("Execution Model")
    expect(dimensions).toContain("Error Format")
    expect(dimensions).toContain("Trustline Flow")
  })

  it("normalizes xBull sign results in multiple formats", () => {
    // 1. Freighter-standard shape
    const res1 = normalizeXBullSignResult({ signedTxXdr: "AAAA_XDR_1" })
    expect(res1.signedTxXdr).toBe("AAAA_XDR_1")

    // 2. xBull xdr property
    const res2 = normalizeXBullSignResult({ xdr: "AAAA_XDR_2" })
    expect(res2.signedTxXdr).toBe("AAAA_XDR_2")

    // 3. xBull result property
    const res3 = normalizeXBullSignResult({ result: "AAAA_XDR_3" })
    expect(res3.signedTxXdr).toBe("AAAA_XDR_3")

    // 4. Raw string
    const res4 = normalizeXBullSignResult("AAAA_XDR_4")
    expect(res4.signedTxXdr).toBe("AAAA_XDR_4")

    // 5. Empty / undefined
    const res5 = normalizeXBullSignResult(null)
    expect(res5.signedTxXdr).toBe("")
    expect(res5.error).toBeDefined()
  })

  it("maps rejection errors and records security counters", () => {
    const err1 = mapXBullError("User rejected the transaction")
    expect(err1.code).toBe("USER_REJECTED")
    expect(err1.message).toContain("rejected")
    expect(getSecurityCounter("xbull_sign_rejected")).toBe(1)

    const err2 = mapXBullError(new Error("Denied by user"))
    expect(err2.code).toBe("USER_REJECTED")
    expect(getSecurityCounter("xbull_sign_rejected")).toBe(2)

    const err3 = mapXBullError({ message: "Network not matching" })
    expect(err3.code).toBe("NETWORK_MISMATCH")
    expect(getSecurityCounter("xbull_error_mapped")).toBe(1)

    const err4 = mapXBullError("Unknown internal failure")
    expect(err4.code).toBe("SIGN_FAILED")
    expect(getSecurityCounter("xbull_error_mapped")).toBe(2)
  })

  it("increments audit counters for sign requested, success, and trustline", () => {
    recordXBullSignRequested()
    expect(getSecurityCounter("xbull_sign_requested")).toBe(1)

    recordXBullSignSuccess()
    expect(getSecurityCounter("xbull_sign_success")).toBe(1)

    recordXBullTrustlineSigned()
    expect(getSecurityCounter("xbull_trustline_signed")).toBe(1)
  })
})
