// @ts-nocheck
import assert from "node:assert/strict"
import { test } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import {
  canonicalSignalPayload,
  sep53SignedBytes,
  signalProofMessage,
  verifySep53Signature,
  verifySignalSignature,
} from "@/lib/viewer-signature"

/**
 * Simulates a wallet's SEP-53 signMessage without a real wallet:
 * ed25519_sign(sha256(prefix + message)). Keypair.sign does NOT hash, so it
 * has to be given the digest; signing the raw prefixed bytes was the old bug.
 */
async function signPayload(payload: {
  title: string
  body: string
  timestamp: number
}, keypair: Keypair): Promise<string> {
  const message = await signalProofMessage(payload)
  return Buffer.from(keypair.sign(Buffer.from(await sep53SignedBytes(message)))).toString("base64")
}

// Official vectors from stellar-protocol ecosystem/sep-0053.md (published test key, no funds).
const SEP53_ADDRESS = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L"

test("verifySep53Signature accepts the SEP-53 spec test vectors", async () => {
  assert.equal(
    await verifySep53Signature(
      SEP53_ADDRESS,
      "Hello, World!",
      "fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==",
    ),
    true,
  )
  assert.equal(
    await verifySep53Signature(
      SEP53_ADDRESS,
      "こんにちは、世界！",
      "CDU265Xs8y3OWbB/56H9jPgUss5G9A0qFuTqH2zs2YDgTm+++dIfmAEceFqB7bhfN3am59lCtDXrCtwH2k1GBA==",
    ),
    true,
  )
})

test("verifySep53Signature rejects a signature over the raw prefixed bytes", async () => {
  const kp = Keypair.random()
  const raw = Buffer.from("Stellar Signed Message:\nhello", "utf8")
  const signature = Buffer.from(kp.sign(raw)).toString("base64")
  assert.equal(await verifySep53Signature(kp.publicKey(), "hello", signature), false)
})

test("verifySignalSignature accepts a genuine wallet signature", async () => {
  const kp = Keypair.random()
  const payload = { title: "Hello", body: "World", timestamp: 1234567890 }
  const signature = await signPayload(payload, kp)
  const ok = await verifySignalSignature(kp.publicKey(), payload, signature)
  assert.equal(ok, true)
})

test("verifySignalSignature rejects a forged signature from another wallet", async () => {
  const author = Keypair.random()
  const forger = Keypair.random()
  const payload = { title: "Hello", body: "World", timestamp: 1234567890 }
  // Signed with the forger's key, but claimed to be authored by `author`.
  const signature = await signPayload(payload, forger)
  const ok = await verifySignalSignature(author.publicKey(), payload, signature)
  assert.equal(ok, false)
})

test("verifySignalSignature rejects tampered content", async () => {
  const kp = Keypair.random()
  const payload = { title: "Hello", body: "World", timestamp: 1234567890 }
  const signature = await signPayload(payload, kp)
  // Body changed after signing — signature must no longer verify.
  const tampered = await verifySignalSignature(kp.publicKey(), { ...payload, body: "Tampered" }, signature)
  assert.equal(tampered, false)
})

test("verifySignalSignature rejects legacy mock signatures (wallet address as signature)", async () => {
  const kp = Keypair.random()
  const payload = { title: "Hello", body: "World", timestamp: 1234567890 }
  // Legacy posts stored `signature` = the address itself.
  const ok = await verifySignalSignature(kp.publicKey(), payload, kp.publicKey())
  assert.equal(ok, false)
})

test("verifySignalSignature returns false for garbage input", async () => {
  const kp = Keypair.random()
  const payload = { title: "Hello", body: "World", timestamp: 1234567890 }
  const ok = await verifySignalSignature(kp.publicKey(), payload, "!!not-base64-signature!!")
  assert.equal(ok, false)
})

test("canonicalSignalPayload is deterministic and stable", () => {
  const a = canonicalSignalPayload({ title: "T", body: "B", timestamp: 42 })
  const b = canonicalSignalPayload({ title: "T", body: "B", timestamp: 42 })
  assert.equal(a, b)
  assert.ok(a.includes("42"))
})

