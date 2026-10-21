import { describe, it, expect, beforeEach } from "vitest"
import {
  ledgerRollbackNote,
  decodeSorobanTransaction,
  validateLedgerPreflight,
  mapLedgerHardwareError,
  recordLedgerClearSigningReviewed,
  recordLedgerClearSigningApproved,
  recordLedgerClearSigningRejected,
  recordLedgerBlindSigningBlocked,
  recordLedgerGate13Preempted,
  type DecodedSorobanInvocation,
} from "@/lib/ledger-soroban-decoder"
import { resetSecurityCounters, getSecurityCounter } from "@/lib/security-counters"

describe("spike 625: Ledger blind-signing to clear-signing review (phase-169)", () => {
  beforeEach(() => {
    resetSecurityCounters()
  })

  it("exposes rollback notes mentioning phase-169", () => {
    expect(ledgerRollbackNote()).toContain("phase-169")
  })

  it("safely handles null and malformed XDR strings", () => {
    expect(decodeSorobanTransaction("")).toBeNull()
    expect(decodeSorobanTransaction("invalid-base64-not-xdr")).toBeNull()
  })

  it("detects Gate #13 self-transfer risk and preempts signing", () => {
    const mockSelfTransfer: DecodedSorobanInvocation = {
      functionName: "transfer",
      contractId: "CA7NTESTCONTRACTID12345",
      contractLabel: "PHASE NFT Protocol",
      sourceAccount: "GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR",
      fee: "100",
      args: ["GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR", "GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR", 1, 1],
      namedArgs: {
        from: "GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR",
        to: "GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR",
        tokenId: "1",
        amount: "1",
      },
      verificationHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      verificationCode: "VREF-ABCD-7890",
      isSelfTransferRisk: true,
      preflightErrors: ["Gate #13 Pre-empted: Cannot transfer a PHASE NFT to yourself (SelfTransfer)"],
      rawOpType: "invokeHostFunction",
    }

    const preflight = validateLedgerPreflight(mockSelfTransfer, "GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR")
    expect(preflight.valid).toBe(false)
    expect(preflight.errors.length).toBeGreaterThan(0)
    expect(preflight.errors[0]).toContain("Gate #13 Pre-empted")
    expect(getSecurityCounter("ledger_gate13_preempted")).toBe(1)
  })

  it("validates successful preflight when parameters are clean", () => {
    const cleanInvocation: DecodedSorobanInvocation = {
      functionName: "settle",
      contractId: "CA7NTESTCONTRACTID12345",
      contractLabel: "PHASE NFT Protocol",
      sourceAccount: "GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR",
      fee: "100",
      args: ["GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR", "CDLZTOKEN123", "5000000"],
      namedArgs: {
        payer: "GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR",
        tokenContract: "CDLZTOKEN123",
        amount: "5000000",
      },
      verificationHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      verificationCode: "VREF-1234-CDEF",
      isSelfTransferRisk: false,
      preflightErrors: [],
      rawOpType: "invokeHostFunction",
    }

    const preflight = validateLedgerPreflight(cleanInvocation, "GAAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRR")
    expect(preflight.valid).toBe(true)
    expect(preflight.errors.length).toBe(0)
  })

  it("maps Ledger hardware error codes accurately", () => {
    // 1. Blind signing disabled
    const blindErr = mapLedgerHardwareError("Ledger error 0x6b0c: blind signing not enabled")
    expect(blindErr.code).toBe("LEDGER_BLIND_SIGNING_DISABLED")
    expect(blindErr.requiresAppSetting).toBe(true)
    expect(blindErr.message).toContain("Blind signing is disabled")
    expect(getSecurityCounter("ledger_blind_signing_blocked")).toBe(1)

    // 2. User rejected
    const rejectErr = mapLedgerHardwareError("Condition 0x6985: user denied transaction")
    expect(rejectErr.code).toBe("LEDGER_USER_REJECTED")
    expect(rejectErr.isUserRejected).toBe(true)
    expect(getSecurityCounter("ledger_clear_signing_rejected")).toBe(1)

    // 3. Disconnected / timeout
    const disconnectErr = mapLedgerHardwareError("USB transport error 0x6e00 timeout")
    expect(disconnectErr.code).toBe("LEDGER_DEVICE_DISCONNECTED")
    expect(disconnectErr.isTimeoutOrDisconnect).toBe(true)
  })

  it("increments audit telemetry counters correctly", () => {
    recordLedgerClearSigningReviewed()
    expect(getSecurityCounter("ledger_clear_signing_reviewed")).toBe(1)

    recordLedgerClearSigningApproved()
    expect(getSecurityCounter("ledger_clear_signing_approved")).toBe(1)

    recordLedgerClearSigningRejected()
    expect(getSecurityCounter("ledger_clear_signing_rejected")).toBe(1)

    recordLedgerBlindSigningBlocked()
    expect(getSecurityCounter("ledger_blind_signing_blocked")).toBe(1)

    recordLedgerGate13Preempted()
    expect(getSecurityCounter("ledger_gate13_preempted")).toBe(1)
  })
})
