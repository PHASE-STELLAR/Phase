/**
 * Artist badge issuance hardening (Issue #225).
 *
 * The off-chain badge store is a cache; the trust anchor is the
 * `artist_attestations` entry in the phase-protocol contract, only writable
 * through `attest_artist` (require_auth(admin)). Issuance is therefore gated
 * on the operator key and refused when the chain does not attest the artist.
 *
 * Run with: npm test
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, beforeEach, describe, it } from "node:test"
import { Keypair } from "@stellar/stellar-sdk"
import {
  ArtistAttestationError,
  __resetArtistAttestationCacheForTests,
  canonicalAttestationMessage,
  checkOnChainArtistAttestation,
  issueVerifiedArtistBadge,
  verifyAttestationSignature,
} from "@/lib/artist-attestation"

let dataDir = ""

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "phase-artist-badge-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_94 = "1"
})

after(async () => {
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_94
  await rm(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  __resetArtistAttestationCacheForTests()
})

function signAttestation(kp: Keypair, displayName: string, issuedAt: number, nonce: string) {
  const message = canonicalAttestationMessage({
    wallet: kp.publicKey(),
    displayName,
    issuedAt,
    nonce,
  })
  return Buffer.from(kp.sign(Buffer.from(message, "utf8"))).toString("base64")
}

describe("artist badge on-chain attestation gate (Issue #225)", () => {
  it("rejects a badge whose signature is not from the claimed wallet", async () => {
    const victim = Keypair.random()
    const attacker = Keypair.random()
    const issuedAt = Date.now()
    const nonce = "nonce-spoof-0001"
    // Signature produced by the attacker, but claiming the victim's address.
    const forged = signAttestation(attacker, "Mallory", issuedAt, nonce)

    await assert.rejects(
      issueVerifiedArtistBadge({
        wallet: victim.publicKey(),
        displayName: "Mallory",
        issuedAt,
        nonce,
        signature: forged,
      }),
      (err: unknown) => err instanceof ArtistAttestationError && err.code === "SIGNATURE_INVALID",
    )
  })

  it("rejects a tampered display name after signing", async () => {
    const kp = Keypair.random()
    const issuedAt = Date.now()
    const nonce = "nonce-tamper-001"
    const signature = signAttestation(kp, "Honest Name", issuedAt, nonce)

    await assert.rejects(
      issueVerifiedArtistBadge({
        wallet: kp.publicKey(),
        displayName: "Impostor Name",
        issuedAt,
        nonce,
        signature,
      }),
      (err: unknown) => err instanceof ArtistAttestationError && err.code === "SIGNATURE_INVALID",
    )
  })

  it("issues a badge for a correctly signed attestation", async () => {
    const kp = Keypair.random()
    const issuedAt = Date.now()
    const nonce = "nonce-happy-00001"
    const signature = signAttestation(kp, "Real Artist", issuedAt, nonce)

    const badge = await issueVerifiedArtistBadge({
      wallet: kp.publicKey(),
      displayName: "Real Artist",
      issuedAt,
      nonce,
      signature,
    })

    assert.equal(badge.wallet, kp.publicKey())
    assert.equal(badge.claim, "verified-artist")
  })

  it("verifies signatures only for the exact canonical message", () => {
    const kp = Keypair.random()
    const issuedAt = Date.now()
    const nonce = "nonce-canon-0001"
    const message = canonicalAttestationMessage({
      wallet: kp.publicKey(),
      displayName: "Name",
      issuedAt,
      nonce,
    })
    const signature = Buffer.from(kp.sign(Buffer.from(message, "utf8"))).toString("base64")

    assert.equal(verifyAttestationSignature(kp.publicKey(), message, signature), true)
    assert.equal(verifyAttestationSignature(kp.publicKey(), message + "x", signature), false)
    assert.equal(verifyAttestationSignature(Keypair.random().publicKey(), message, signature), false)
  })

  it("treats a malformed wallet as not attested without hitting the chain", async () => {
    assert.equal(await checkOnChainArtistAttestation("not-a-wallet"), "not_attested")
    assert.equal(await checkOnChainArtistAttestation("G" + "A".repeat(10)), "not_attested")
  })

  it("never reports verified when the chain is unreachable", async () => {
    // No RPC reachable in the test env: the check must degrade to
    // "unavailable" (or "not_attested"), never a forged "verified".
    const result = await checkOnChainArtistAttestation(Keypair.random().publicKey())
    assert.notEqual(result, "verified")
  })
})
