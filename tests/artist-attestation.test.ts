/**
 * phase-94: verified-artist badge issuance via signed attestation — tests
 * Run: npx tsx tests/artist-attestation.test.ts
 */
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { Keypair } from "@stellar/stellar-sdk"

process.env.NEXT_PUBLIC_FEATURE_PHASE_94 = "1"
process.env.FEATURE_PHASE_94 = "1"
process.env.PHASE_SERVER_DATA_DIR = path.join(os.tmpdir(), `phase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)

import {
  ArtistAttestationError,
  canonicalAttestationMessage,
  getVerifiedArtistBadge,
  isPhase94Enabled,
  issueVerifiedArtistBadge,
  isVerifiedArtist,
  revokeVerifiedArtistBadge,
  verifyAttestationSignature,
} from "@/lib/artist-attestation"

function sign(kp: Keypair, message: string): string {
  return kp.sign(Buffer.from(message, "utf8")).toString("base64")
}

async function testFlagEnabled() {
  assert.equal(isPhase94Enabled(), true)
  console.log("✓ flag enabled via env")
}

async function testIssueAndVerify() {
  const kp = Keypair.random()
  const wallet = kp.publicKey()
  const displayName = "Ada Lovelace"
  const issuedAt = Date.now()
  const nonce = "nonce-" + Math.random().toString(36).slice(2, 12)
  const message = canonicalAttestationMessage({ wallet, displayName, issuedAt, nonce })
  const signature = sign(kp, message)

  assert.equal(verifyAttestationSignature(wallet, message, signature), true)

  const badge = await issueVerifiedArtistBadge({ wallet, displayName, issuedAt, nonce, signature })
  assert.equal(badge.wallet, wallet)
  assert.equal(badge.claim, "verified-artist")

  assert.equal(await isVerifiedArtist(wallet), true)
  const fetched = await getVerifiedArtistBadge(wallet)
  assert.equal(fetched?.wallet, wallet)
  console.log("✓ issue badge with valid signature and read it back")
}

async function testForgedSignatureRejected() {
  const owner = Keypair.random()
  const attacker = Keypair.random()
  const wallet = owner.publicKey() // impersonation attempt: claim owner's wallet
  const displayName = "Fake Artist"
  const issuedAt = Date.now()
  const nonce = "nonce-" + Math.random().toString(36).slice(2, 12)
  const message = canonicalAttestationMessage({ wallet, displayName, issuedAt, nonce })
  // Attacker signs with their OWN key, not the claimed wallet's key.
  const forgedSignature = sign(attacker, message)

  assert.equal(verifyAttestationSignature(wallet, message, forgedSignature), false)

  let threw = false
  try {
    await issueVerifiedArtistBadge({ wallet, displayName, issuedAt, nonce, signature: forgedSignature })
  } catch (e) {
    threw = e instanceof ArtistAttestationError && e.code === "SIGNATURE_INVALID"
  }
  assert.equal(threw, true)
  assert.equal(await isVerifiedArtist(wallet), false)
  console.log("✓ forged signature (fake artist impersonation) rejected")
}

async function testDuplicateIssuanceRejected() {
  const kp = Keypair.random()
  const wallet = kp.publicKey()
  const displayName = "Repeat Artist"
  const issuedAt = Date.now()
  const nonce = "nonce-" + Math.random().toString(36).slice(2, 12)
  const message = canonicalAttestationMessage({ wallet, displayName, issuedAt, nonce })
  const signature = sign(kp, message)

  await issueVerifiedArtistBadge({ wallet, displayName, issuedAt, nonce, signature })

  let threw = false
  try {
    await issueVerifiedArtistBadge({ wallet, displayName, issuedAt, nonce, signature })
  } catch (e) {
    threw = e instanceof ArtistAttestationError && e.code === "ALREADY_ISSUED"
  }
  assert.equal(threw, true)
  console.log("✓ duplicate issuance with same nonce blocked")
}

async function testRevoke() {
  const kp = Keypair.random()
  const wallet = kp.publicKey()
  const displayName = "Revoked Artist"
  const issuedAt = Date.now()
  const nonce = "nonce-" + Math.random().toString(36).slice(2, 12)
  const message = canonicalAttestationMessage({ wallet, displayName, issuedAt, nonce })
  const signature = sign(kp, message)

  await issueVerifiedArtistBadge({ wallet, displayName, issuedAt, nonce, signature })
  assert.equal(await isVerifiedArtist(wallet), true)

  await revokeVerifiedArtistBadge(wallet)
  assert.equal(await isVerifiedArtist(wallet), false)
  console.log("✓ revoke removes badge")
}

async function testFlagDisabledBlocksIssuance() {
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_94
  delete process.env.FEATURE_PHASE_94
  const kp = Keypair.random()
  const wallet = kp.publicKey()
  const displayName = "Blocked Artist"
  const issuedAt = Date.now()
  const nonce = "nonce-" + Math.random().toString(36).slice(2, 12)
  const message = canonicalAttestationMessage({ wallet, displayName, issuedAt, nonce })
  const signature = sign(kp, message)

  let threw = false
  try {
    await issueVerifiedArtistBadge({ wallet, displayName, issuedAt, nonce, signature })
  } catch (e) {
    threw = e instanceof ArtistAttestationError && e.code === "FLAG_DISABLED"
  }
  assert.equal(threw, true)
  process.env.NEXT_PUBLIC_FEATURE_PHASE_94 = "1"
  process.env.FEATURE_PHASE_94 = "1"
  console.log("✓ issuance blocked when phase-94 flag disabled")
}

async function run() {
  await testFlagEnabled()
  await testIssueAndVerify()
  await testForgedSignatureRejected()
  await testDuplicateIssuanceRejected()
  await testRevoke()
  await testFlagDisabledBlocksIssuance()
  console.log("\nAll artist-attestation (phase-94) tests passed.")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
