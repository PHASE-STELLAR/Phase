/**
 * Gated-preview viewer authorization (issue #227) — tests
 * Run: npx tsx tests/viewer-authorization.test.ts
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"

import {
  VIEWER_SIGNATURE_TTL_SECONDS,
  buildViewerSignatureMessage,
  consumeJti,
  releaseJti,
  verifyViewerSignature,
} from "@/lib/viewer-authorization"
import {
  incSecurityCounter,
  getSecurityCounter,
  recordPreviewVerifyFailure,
  resetSecurityCounters,
  snapshotSecurityCounters,
} from "@/lib/security-counters"

const WALLET = "GBRPYHIL2CI3WHZKYYXY5UYSZES3IQNB54GQMVWHTFXNAXN3C5GKQCVX"
const NET = "Test SDF Network ; September 2015"
const CONTRACT = "CB3JUB4X5JJ2WDKRTQ5JZ2XHXZQSDY2MCT5JUUJ2QHZ2Z6F2S2VZQ2QZQ2"

// Minimal Ed25519 signer so the tests need no wallet and no network: we sign
// the exact bytes the module derives, which is the property under test.
async function signBytes(seedHex: string, bytes: Uint8Array): Promise<string> {
  const { Keypair } = await import("@stellar/stellar-sdk")
  const kp = Keypair.fromRawEd25519Seed(Buffer.from(seedHex, "hex"))
  return Buffer.from(kp.sign(bytes)).toString("base64")
}

const SEED = "a".repeat(64)

/**
 * Build claims, then sign exactly the bytes the module will derive for those
 * claims. `networkPassphrase` lets a test sign for a different network than the
 * one the server runs, which is the cross-network replay case.
 */
async function mintClaims(
  overrides: Record<string, unknown> = {},
  { signNetwork = NET }: { signNetwork?: string } = {},
) {
  const exp = Math.floor(Date.now() / 1000) + VIEWER_SIGNATURE_TTL_SECONDS
  const claims = {
    viewer: WALLET,
    tokenId: 1,
    exp,
    jti: randomBytes(12).toString("hex"),
    contractId: CONTRACT,
    networkPassphrase: NET,
  }
  const { viewerSignatureBytes } = await import("@/lib/viewer-authorization")

  // The module always derives bytes with the *server's* passphrase, so for the
  // cross-network case we sign the digest of a foreign-network message and
  // expect the server to reject it.
  const signClaims = { ...claims, ...overrides, networkPassphrase: signNetwork }
  const bytes =
    signNetwork === NET
      ? await viewerSignatureBytes(signClaims as any)
      : new TextEncoder().encode(
          `${buildViewerSignatureMessage(signClaims as any).split("|").slice(1).join("|")}`,
        )
  const signatureBase64 = await signBytes(SEED, bytes)

  // The claims actually presented are the ones the *server* will re-derive from.
  return { claims: signClaims, signatureBase64 }
}

async function testAcceptsFreshValidSignature() {
  const { claims, signatureBase64 } = await mintClaims()
  const result = await verifyViewerSignature({ claims, signatureBase64, contractId: CONTRACT, tokenId: 1 })
  assert.equal(result.ok, true, "a fresh, bound signature must verify")
}

async function testRejectsExpiredSignature() {
  const expired = Math.floor(Date.now() / 1000) - VIEWER_SIGNATURE_TTL_SECONDS - 60
  const { claims, signatureBase64 } = await mintClaims({ exp: expired })
  const result = await verifyViewerSignature({ claims, signatureBase64, contractId: CONTRACT, tokenId: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, "expired")
  recordPreviewVerifyFailure("expired")
  assert.ok(getSecurityCounter("preview_verify_expired") > 0)
}

async function testRejectsTokenIdMismatch() {
  // Signature minted for token 1, presented for token 2.
  const { claims, signatureBase64 } = await mintClaims({ tokenId: 1 })
  const result = await verifyViewerSignature({ claims, signatureBase64, contractId: CONTRACT, tokenId: 2 })
  assert.equal(result.ok, false, "a signature for token 1 must not open token 2")
  assert.equal(result.ok === false && result.code, "malformed")
}

async function testRejectsJtiReplay() {
  const { claims, signatureBase64 } = await mintClaims()
  const first = await verifyViewerSignature({ claims, signatureBase64, contractId: CONTRACT, tokenId: 1 })
  assert.equal(first.ok, true)

  const second = await verifyViewerSignature({ claims, signatureBase64, contractId: CONTRACT, tokenId: 1 })
  assert.equal(second.ok, false, "the same signature must not verify twice")
  assert.equal(second.ok === false && second.code, "replay")
  recordPreviewVerifyFailure("replay")
  assert.ok(getSecurityCounter("preview_jti_replay") > 0)
}

async function testRejectsCrossNetworkSignature() {
  // Signed for a foreign network, presented to a testnet server. The digest the
  // server derives differs, so verification must fail.
  const { claims, signatureBase64 } = await mintClaims({}, { signNetwork: "Public Global Stellar Network ; September 2015" })
  const result = await verifyViewerSignature({
    claims,
    signatureBase64,
    contractId: CONTRACT,
    tokenId: 1,
    networkPassphrase: NET,
  })
  assert.equal(result.ok, false, "a signature must not verify across networks")
  assert.equal(result.ok === false && result.code, "bad_signature")
}

async function testRejectsBadSignature() {
  const { claims } = await mintClaims()
  const result = await verifyViewerSignature({
    claims,
    signatureBase64: Buffer.from("not-a-signature").toString("base64"),
    contractId: CONTRACT,
    tokenId: 1,
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, "bad_signature")
}

async function testRejectsMissingClaims() {
  const result = await verifyViewerSignature({
    claims: undefined,
    signatureBase64: "x",
    contractId: CONTRACT,
    tokenId: 1,
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, "missing_claims")
}

async function testFailedSignatureDoesNotBurnJti() {
  // A signature that fails verification must leave its jti unused, so a later
  // correct presentation of the same claims is not treated as a replay.
  const { claims, signatureBase64 } = await mintClaims()
  const bad = await verifyViewerSignature({ claims, signatureBase64: "bm90LWEtc2ln", contractId: CONTRACT, tokenId: 1 })
  assert.equal(bad.ok, false)

  const good = await verifyViewerSignature({ claims, signatureBase64, contractId: CONTRACT, tokenId: 1 })
  assert.equal(good.ok, true, "a burned jti on a failed verification would lock out a valid signature")
}

async function testJtiConsumeIsAtomicUnderConcurrency() {
  const jti = randomBytes(12).toString("hex")
  const exp = Math.floor(Date.now() / 1000) + 300
  const results = await Promise.all(
    Array.from({ length: 25 }, () => consumeJti(jti, WALLET, 1, exp)),
  )
  const successes = results.filter(Boolean).length
  assert.equal(successes, 1, `exactly one consume must win, got ${successes}`)
}

async function testReleaseJtiAllowsReuse() {
  const jti = randomBytes(12).toString("hex")
  const exp = Math.floor(Date.now() / 1000) + 300
  assert.equal(consumeJti(jti, WALLET, 1, exp), true)
  releaseJti(jti)
  assert.equal(consumeJti(jti, WALLET, 1, exp), true)
}

async function testSecurityCounters() {
  resetSecurityCounters()
  incSecurityCounter("gated_cdn_leak_blocked", 3)
  assert.equal(getSecurityCounter("gated_cdn_leak_blocked"), 3)
  const snap = snapshotSecurityCounters()
  assert.equal(snap.gated_cdn_leak_blocked, 3)
  resetSecurityCounters()
  assert.equal(getSecurityCounter("gated_cdn_leak_blocked"), 0)
}

async function main() {
  await testAcceptsFreshValidSignature(); console.log("✓ accepts a fresh, bound signature")
  await testRejectsExpiredSignature(); console.log("✓ rejects an expired signature")
  await testRejectsTokenIdMismatch(); console.log("✓ rejects a signature bound to another token")
  await testRejectsJtiReplay(); console.log("✓ rejects jti replay")
  await testRejectsCrossNetworkSignature(); console.log("✓ rejects cross-network signature")
  await testRejectsBadSignature(); console.log("✓ rejects a bad signature")
  await testRejectsMissingClaims(); console.log("✓ rejects missing claims")
  await testFailedSignatureDoesNotBurnJti(); console.log("✓ failed verification does not burn jti")
  await testJtiConsumeIsAtomicUnderConcurrency(); console.log("✓ jti consume is atomic (1 of 25)")
  await testReleaseJtiAllowsReuse(); console.log("✓ released jti can be consumed again")
  await testSecurityCounters(); console.log("✓ security counters record and reset")
  console.log("\nAll gated-preview authorization tests passed.")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
