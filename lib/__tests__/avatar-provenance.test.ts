/**
 * Avatar provenance hardening (Issue #226).
 *
 * Avatars are identity for world creators and signal authors, so two things
 * must hold before an avatar is stored:
 *   1. the requester proved ownership of the wallet being updated (SEP-53
 *      signature over { wallet, imageUrl }) — otherwise anyone can overwrite a
 *      victim's avatar with phishing content;
 *   2. the pinned bytes are bound to the CID they are served under
 *      (cid-cache verifyCID) — a client-supplied CID proves nothing.
 *
 * Run with: npm test
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Keypair } from "@stellar/stellar-sdk"
import { CidIntegrityError, sha256Hex, verifyCID, verifyBytesIntegrity } from "@/lib/cid-cache"

const SIGNATURE_PREFIX = "Stellar Signed Message:\n"

async function avatarMessage(wallet: string, imageUrl: string): Promise<string> {
  return `phase-avatar:v1:${await sha256Hex(JSON.stringify({ wallet, imageUrl }))}`
}

async function verifyOwnership(wallet: string, imageUrl: string, signatureBase64: string) {
  try {
    const message = await avatarMessage(wallet, imageUrl)
    const data = new TextEncoder().encode(SIGNATURE_PREFIX + message)
    return Keypair.fromPublicKey(wallet).verify(data, Buffer.from(signatureBase64, "base64"))
  } catch {
    return false
  }
}

const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"

describe("avatar wallet-ownership proof (Issue #226)", () => {
  it("accepts a signature over the exact wallet + imageUrl", async () => {
    const kp = Keypair.random()
    const url = "https://cdn.example/avatar.png"
    const signature = Buffer.from(
      kp.sign(Buffer.from(SIGNATURE_PREFIX + (await avatarMessage(kp.publicKey(), url)), "utf8")),
    ).toString("base64")

    assert.equal(await verifyOwnership(kp.publicKey(), url, signature), true)
  })

  it("rejects a signature replayed against a different image", async () => {
    const kp = Keypair.random()
    const honestUrl = "https://cdn.example/honest.png"
    const attackerUrl = "https://evil.example/phish.png"
    const signature = Buffer.from(
      kp.sign(Buffer.from(SIGNATURE_PREFIX + (await avatarMessage(kp.publicKey(), honestUrl)), "utf8")),
    ).toString("base64")

    assert.equal(await verifyOwnership(kp.publicKey(), attackerUrl, signature), false)
  })

  it("rejects a signature from a different key claiming the victim wallet", async () => {
    const victim = Keypair.random()
    const attacker = Keypair.random()
    const url = "https://evil.example/phish.png"
    const signature = Buffer.from(
      attacker.sign(
        Buffer.from(SIGNATURE_PREFIX + (await avatarMessage(victim.publicKey(), url)), "utf8"),
      ),
    ).toString("base64")

    assert.equal(await verifyOwnership(victim.publicKey(), url, signature), false)
  })

  it("rejects a garbage signature", async () => {
    const kp = Keypair.random()
    assert.equal(await verifyOwnership(kp.publicKey(), "https://x/y.png", "not-base64"), false)
  })
})

describe("avatar CID provenance (Issue #226)", () => {
  it("rejects a malformed CID", () => {
    assert.throws(
      () => verifyCID(new Uint8Array([1, 2, 3]), "not-a-cid"),
      (err: unknown) => err instanceof CidIntegrityError && err.code === "CID_INVALID",
    )
  })

  it("accepts a well-formed CID whose digest matches the bytes", () => {
    const bytes = new Uint8Array(Buffer.from("avatar-bytes"))
    const digest = sha256Hex(bytes)
    assert.doesNotThrow(() => verifyCID(bytes, CID, digest))
  })

  it("rejects a well-formed CID whose digest does not match (poisoned content)", () => {
    const bytes = new Uint8Array(Buffer.from("attacker-content"))
    const digest = sha256Hex(new Uint8Array(Buffer.from("honest-content")))
    assert.throws(
      () => verifyCID(bytes, CID, digest),
      (err: unknown) => err instanceof CidIntegrityError && err.code === "HASH_MISMATCH",
    )
  })

  it("rejects an empty body for a content-addressed CID", () => {
    assert.throws(
      () => verifyCID(new Uint8Array(0), CID),
      (err: unknown) => err instanceof CidIntegrityError && err.code === "TAMPERED",
    )
  })

  it("keeps the constant-time byte comparison honest", () => {
    const bytes = new Uint8Array(Buffer.from("avatar-bytes"))
    const digest = sha256Hex(bytes)
    assert.equal(verifyBytesIntegrity(bytes, digest), true)
    assert.equal(verifyBytesIntegrity(bytes, digest.replace(/.$/, digest.endsWith("0") ? "1" : "0")), false)
  })
})
