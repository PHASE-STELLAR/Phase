import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { Keypair } from "@stellar/stellar-sdk"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetDbForTests } from "@/lib/sqlite-db"
import {
  getSecurityCounter,
  resetSecurityCounters,
} from "@/lib/security-counters"
import {
  consumeCustodianReleaseNonce,
  custodianReleaseDigestBytes,
  emitCustodianReleaseAuditEvent,
  finalizeCustodianTokenRelease,
  isTokenCustodianReleased,
  reserveCustodianTokenRelease,
  verifyCustodianReleaseAuthorization,
  type CustodianReleaseClaims,
} from "@/lib/custodian-release"
import { POST as custodianReleaseRoute } from "@/app/api/phase-nft/custodian-release/route"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-custodian-"))
  vi.stubEnv("PHASE_SERVER_DATA_DIR", dir)
  vi.stubEnv("STELLAR_NETWORK", "testnet")
  vi.stubEnv("FEATURE_PHASE_251", "0")
  vi.stubEnv("NEXT_PUBLIC_FEATURE_PHASE_251", "0")
  resetDbForTests()
  resetSecurityCounters()
})

afterEach(() => {
  resetDbForTests()
  resetSecurityCounters()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function postRelease(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://phase.example/api/phase-nft/custodian-release", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("phase-251 custodian release flow (#702)", () => {
  const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
  const networkPassphrase = "Test SDF Network ; September 2015"

  it("returns 404 when phase-251 flag is off", async () => {
    const res = await custodianReleaseRoute(postRelease({ tokenId: 1, recipientWallet: Keypair.random().publicKey() }))
    expect(res.status).toBe(404)
  })

  it("rejects forged, mismatched, and expired authorizations and emits closed-label audit event", async () => {
    vi.stubEnv("FEATURE_PHASE_251", "1")
    const recipientKp = Keypair.random()
    const attackerKp = Keypair.random()
    const recipient = recipientKp.publicKey()
    const exp = Math.floor(Date.now() / 1000) + 300

    const validClaims: CustodianReleaseClaims = {
      tokenId: 42,
      recipient,
      nonce: "nonce_custodian_0001",
      exp,
    }

    // Abuse case 1: forged signature signed by attacker keypair
    const digest = custodianReleaseDigestBytes(validClaims, contractId, networkPassphrase)
    const forgedSig = attackerKp.sign(digest).toString("base64")
    const forgedCheck = verifyCustodianReleaseAuthorization({
      claims: validClaims,
      signatureBase64: forgedSig,
      tokenId: 42,
      recipient,
      contractId,
      networkPassphrase,
    })
    expect(forgedCheck.ok).toBe(false)
    if (!forgedCheck.ok) {
      expect(forgedCheck.code).toBe("FORGED_AUTHORIZATION")
    }

    // Route rejects forged authorization with 401 and increments audit counter
    const res = await custodianReleaseRoute(
      postRelease({
        tokenId: 42,
        recipientWallet: recipient,
        releaseClaims: validClaims,
        releaseSignature: forgedSig,
      }),
    )
    expect(res.status).toBe(401)
    expect(getSecurityCounter("custodian_release_forged")).toBe(1)

    // Abuse case 2: valid signature for tokenId 42 replayed against tokenId 99
    const validSig = recipientKp.sign(digest).toString("base64")
    const mismatchCheck = verifyCustodianReleaseAuthorization({
      claims: validClaims,
      signatureBase64: validSig,
      tokenId: 99,
      recipient,
      contractId,
      networkPassphrase,
    })
    expect(mismatchCheck.ok).toBe(false)
    if (!mismatchCheck.ok) {
      expect(mismatchCheck.code).toBe("CLAIMS_MISMATCH")
    }

    // Abuse case 3: expired authorization
    const expiredClaims: CustodianReleaseClaims = {
      ...validClaims,
      exp: Math.floor(Date.now() / 1000) - 120,
    }
    const expiredSig = recipientKp
      .sign(custodianReleaseDigestBytes(expiredClaims, contractId, networkPassphrase))
      .toString("base64")
    const expiredCheck = verifyCustodianReleaseAuthorization({
      claims: expiredClaims,
      signatureBase64: expiredSig,
      tokenId: 42,
      recipient,
      contractId,
      networkPassphrase,
    })
    expect(expiredCheck.ok).toBe(false)
    if (!expiredCheck.ok) {
      expect(expiredCheck.code).toBe("EXPIRED_AUTHORIZATION")
    }
  })

  it("consumes nonce atomically in SQLite, refuses replayed nonces, and prevents re-releasing tokens", () => {
    const recipient = Keypair.random().publicKey()
    const exp = Math.floor(Date.now() / 1000) + 300

    expect(consumeCustodianReleaseNonce("nonce_unique_1234", 7, recipient, exp)).toBe(true)
    expect(consumeCustodianReleaseNonce("nonce_unique_1234", 7, recipient, exp)).toBe(false)

    expect(isTokenCustodianReleased(7)).toBe(false)
    expect(reserveCustodianTokenRelease(7, recipient, "nonce_unique_1234")).toBe(true)
    finalizeCustodianTokenRelease(7, "a".repeat(64))
    expect(isTokenCustodianReleased(7)).toBe(true)
    expect(reserveCustodianTokenRelease(7, recipient, "nonce_fresh_5678")).toBe(false)

    emitCustodianReleaseAuditEvent("released")
    emitCustodianReleaseAuditEvent("nonce_replay")
    emitCustodianReleaseAuditEvent("already_released")
    expect(getSecurityCounter("custodian_release_success")).toBe(1)
    expect(getSecurityCounter("custodian_release_replay")).toBe(1)
    expect(getSecurityCounter("custodian_release_already_released")).toBe(1)
  })
})
