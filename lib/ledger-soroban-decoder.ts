import {
  Address,
  FeeBumpTransaction,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk"
import { NETWORK_PASSPHRASE } from "@/lib/phase-protocol"
import { incSecurityCounter } from "@/lib/security-counters"

export interface DecodedSorobanInvocation {
  functionName: string
  contractId: string
  contractLabel: string
  sourceAccount: string
  fee: string
  args: unknown[]
  namedArgs: Record<string, unknown>
  verificationHash: string
  verificationCode: string
  isSelfTransferRisk: boolean
  preflightErrors: string[]
  rawOpType: string
}

export interface LedgerHardwareErrorInfo {
  code: string
  message: string
  requiresAppSetting?: boolean
  isTimeoutOrDisconnect?: boolean
  isUserRejected?: boolean
}

export function ledgerRollbackNote(): string {
  return "Rollback phase-169: unset NEXT_PUBLIC_FEATURE_PHASE_169 / FEATURE_PHASE_169 or set to 0/false and restart. Clear-signing preflight review is bypassed; transactions sign via hardware default blind flow."
}

// Deterministic synchronous SHA-256 implementation safe for both Node and browser bundles
function sha256Hex(input: string): string {
  if (typeof window === "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require("node:crypto")
      return crypto.createHash("sha256").update(input, "utf8").digest("hex")
    } catch {
      // fall through to pure JS
    }
  }

  // Pure JS SHA-256 for browser runtime
  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount))
  }

  const mathPow = Math.pow
  const maxWord = mathPow(2, 32)
  const words: number[] = []
  const ascii = unescape(encodeURIComponent(input))
  const asciiBitLength = ascii.length * 8

  const initialHash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]

  for (let i = 0; i < ascii.length; i++) {
    const j = i >> 2
    words[j] = (words[j] || 0) | (ascii.charCodeAt(i) << ((3 - (i % 4)) * 8))
  }

  const finalBlockByte = ascii.length % 4
  const finalWord = ascii.length >> 2
  words[finalWord] = (words[finalWord] || 0) | (0x80 << ((3 - finalBlockByte) * 8))

  const totalWords = (((ascii.length + 8) >> 6) + 1) * 16
  words[totalWords - 1] = asciiBitLength
  words[totalWords - 2] = Math.floor(asciiBitLength / maxWord)

  const w = new Array(64)
  const hash = initialHash.slice(0)

  for (let i = 0; i < totalWords; i += 16) {
    for (let j = 0; j < 16; j++) {
      w[j] = words[i + j] || 0
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3)
      const s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10)
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0
    }

    let a = hash[0]
    let b = hash[1]
    let c = hash[2]
    let d = hash[3]
    let e = hash[4]
    let f = hash[5]
    let g = hash[6]
    let h = hash[7]

    for (let j = 0; j < 64; j++) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + k[j] + w[j]) | 0
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) | 0

      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }

    hash[0] = (hash[0] + a) | 0
    hash[1] = (hash[1] + b) | 0
    hash[2] = (hash[2] + c) | 0
    hash[3] = (hash[3] + d) | 0
    hash[4] = (hash[4] + e) | 0
    hash[5] = (hash[5] + f) | 0
    hash[6] = (hash[6] + g) | 0
    hash[7] = (hash[7] + h) | 0
  }

  let result = ""
  for (let i = 0; i < 8; i++) {
    result += ("00000000" + (hash[i] >>> 0).toString(16)).slice(-8)
  }
  return result
}

function resolveContractLabel(contractId: string): string {
  if (!contractId) return "Unknown Target"
  const upper = contractId.toUpperCase()
  const envNft = (process.env.NEXT_PUBLIC_PHASER_TOKEN_ID ?? "").toUpperCase()
  if (upper === envNft && envNft.length > 0) return "PHASE NFT Protocol"
  if (upper.startsWith("CDLZ") || upper.startsWith("CA7N")) return "PHASE Contract"
  return "Smart Contract"
}

export function decodeSorobanTransaction(
  xdrString: string,
  networkPassphrase = NETWORK_PASSPHRASE,
): DecodedSorobanInvocation | null {
  if (!xdrString || typeof xdrString !== "string") return null

  try {
    const parsed = TransactionBuilder.fromXDR(xdrString.trim(), networkPassphrase)
    const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
    const sourceAccount = typeof tx.source === "string" ? tx.source.trim() : ""
    const fee = String(tx.fee || "0")

    for (const op of tx.operations) {
      if (op.type === "invokeHostFunction") {
        const hf = (op as unknown as { func: xdr.HostFunction }).func
        if (!hf || hf.switch().name !== "hostFunctionTypeInvokeContract") continue

        const ic = hf.invokeContract()
        let contractId = ""
        try {
          contractId = Address.fromScAddress(ic.contractAddress()).toString()
        } catch {
          contractId = "UNKNOWN_CONTRACT"
        }

        const fnNameRaw = ic.functionName()
        const functionName =
          typeof fnNameRaw === "string"
            ? fnNameRaw
            : typeof fnNameRaw === "object" && fnNameRaw !== null && "toString" in fnNameRaw
            ? fnNameRaw.toString()
            : String(fnNameRaw)

        const rawArgs = ic.args() || []
        const args: unknown[] = []
        for (const arg of rawArgs) {
          try {
            args.push(scValToNative(arg))
          } catch {
            args.push("[Complex ScVal]")
          }
        }

        const namedArgs: Record<string, unknown> = {}
        let isSelfTransferRisk = false
        const preflightErrors: string[] = []

        if (functionName === "settle") {
          namedArgs.payer = args[0] ? String(args[0]) : ""
          namedArgs.tokenContract = args[1] ? String(args[1]) : ""
          namedArgs.amount = args[2] != null ? String(args[2]) : "0"
          if (args[3]) namedArgs.invoice = String(args[3])
        } else if (functionName === "transfer") {
          namedArgs.from = args[0] ? String(args[0]) : ""
          namedArgs.to = args[1] ? String(args[1]) : ""
          namedArgs.tokenId = args[2] != null ? String(args[2]) : ""
          namedArgs.amount = args[3] != null ? String(args[3]) : ""

          // Gate #13 check: SelfTransfer
          if (
            namedArgs.from &&
            namedArgs.to &&
            String(namedArgs.from).trim().toUpperCase() === String(namedArgs.to).trim().toUpperCase()
          ) {
            isSelfTransferRisk = true
            preflightErrors.push("Gate #13 Pre-empted: Cannot transfer a PHASE NFT to yourself (SelfTransfer)")
          }
        } else if (functionName === "create_collection") {
          namedArgs.name = args[0] != null ? String(args[0]) : ""
          namedArgs.symbol = args[1] != null ? String(args[1]) : ""
          namedArgs.maxSupply = args[2] != null ? String(args[2]) : ""
          namedArgs.metadataUri = args[3] != null ? String(args[3]) : ""
          namedArgs.admin = args[4] != null ? String(args[4]) : sourceAccount
        } else if (functionName === "initiate_phase") {
          namedArgs.caller = args[0] != null ? String(args[0]) : sourceAccount
          namedArgs.phaseLevel = args[1] != null ? String(args[1]) : ""
          namedArgs.amount = args[2] != null ? String(args[2]) : ""
        } else {
          // Generic args
          args.forEach((val, idx) => {
            namedArgs[`arg_${idx}`] = val
          })
        }

        // Canonical verification hash matching on-device Ledger review pre-image
        const canonicalPreimage = JSON.stringify({
          contract: contractId,
          fn: functionName,
          source: sourceAccount,
          fee,
          args: namedArgs,
          network: networkPassphrase,
        })
        const verificationHash = sha256Hex(canonicalPreimage)
        const verificationCode = `VREF-${verificationHash.slice(0, 4).toUpperCase()}-${verificationHash.slice(-4).toUpperCase()}`

        return {
          functionName,
          contractId,
          contractLabel: resolveContractLabel(contractId),
          sourceAccount,
          fee,
          args,
          namedArgs,
          verificationHash,
          verificationCode,
          isSelfTransferRisk,
          preflightErrors,
          rawOpType: "invokeHostFunction",
        }
      }

      // Classic operations fallback
      if (op.type === "changeTrust") {
        const ct = op as unknown as { line: { code: string; issuer: string }; limit?: string }
        const assetCode = ct.line?.code || "PHASELQ"
        const issuer = ct.line?.issuer || ""
        const canonicalPreimage = `changeTrust:${assetCode}:${issuer}:${sourceAccount}:${fee}`
        const verificationHash = sha256Hex(canonicalPreimage)
        return {
          functionName: "changeTrust",
          contractId: issuer,
          contractLabel: `Classic Asset Trustline (${assetCode})`,
          sourceAccount,
          fee,
          args: [assetCode, issuer, ct.limit || "max"],
          namedArgs: { assetCode, issuer, limit: ct.limit || "max" },
          verificationHash,
          verificationCode: `VREF-${verificationHash.slice(0, 4).toUpperCase()}-${verificationHash.slice(-4).toUpperCase()}`,
          isSelfTransferRisk: false,
          preflightErrors: [],
          rawOpType: "changeTrust",
        }
      }
    }

    return null
  } catch {
    return null
  }
}

export function validateLedgerPreflight(
  decoded: DecodedSorobanInvocation,
  activeAccount?: string,
): { valid: boolean; errors: string[] } {
  const errors = [...decoded.preflightErrors]

  if (decoded.isSelfTransferRisk) {
    incSecurityCounter("ledger_gate13_preempted")
    return { valid: false, errors }
  }

  if (activeAccount && decoded.sourceAccount) {
    if (activeAccount.trim().toUpperCase() !== decoded.sourceAccount.trim().toUpperCase()) {
      errors.push(`Account mismatch: signed with ${decoded.sourceAccount.slice(0, 6)}… but connected as ${activeAccount.slice(0, 6)}…`)
    }
  }

  if (errors.length > 0) {
    incSecurityCounter("ledger_gate13_preempted")
    return { valid: false, errors }
  }

  return { valid: true, errors: [] }
}

export function mapLedgerHardwareError(error: unknown): LedgerHardwareErrorInfo {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
  const lower = msg.toLowerCase()

  // Blind-signing disabled error on Ledger Stellar app
  if (
    lower.includes("0x6b0c") ||
    lower.includes("0x6a15") ||
    lower.includes("blind signing") ||
    lower.includes("clear signing") ||
    lower.includes("blind-signing")
  ) {
    incSecurityCounter("ledger_blind_signing_blocked")
    return {
      code: "LEDGER_BLIND_SIGNING_DISABLED",
      message: "Blind signing is disabled on your Ledger device. In the Stellar app on Ledger, navigate to Settings → Blind signing, and set to Enabled (or Clear signing).",
      requiresAppSetting: true,
    }
  }

  // User rejection on device
  if (
    lower.includes("0x6985") ||
    lower.includes("user rejected") ||
    lower.includes("denied") ||
    lower.includes("cancelled") ||
    lower.includes("canceled")
  ) {
    incSecurityCounter("ledger_clear_signing_rejected")
    return {
      code: "LEDGER_USER_REJECTED",
      message: "Transaction signing rejected on Ledger device.",
      isUserRejected: true,
    }
  }

  // Device disconnected, closed app or timed out
  if (
    lower.includes("0x6e00") ||
    lower.includes("timeout") ||
    lower.includes("disconnected") ||
    lower.includes("transport") ||
    lower.includes("no device") ||
    lower.includes("locked")
  ) {
    return {
      code: "LEDGER_DEVICE_DISCONNECTED",
      message: "Ledger device disconnected or locked. Please unlock your device, open the Stellar app, and retry.",
      isTimeoutOrDisconnect: true,
    }
  }

  return {
    code: "LEDGER_SIGN_ERROR",
    message: msg || "Unknown Ledger hardware error.",
  }
}

export function recordLedgerClearSigningReviewed(): void {
  incSecurityCounter("ledger_clear_signing_reviewed")
}

export function recordLedgerClearSigningApproved(): void {
  incSecurityCounter("ledger_clear_signing_approved")
}

export function recordLedgerClearSigningRejected(): void {
  incSecurityCounter("ledger_clear_signing_rejected")
}

export function recordLedgerBlindSigningBlocked(): void {
  incSecurityCounter("ledger_blind_signing_blocked")
}

export function recordLedgerGate13Preempted(): void {
  incSecurityCounter("ledger_gate13_preempted")
}
