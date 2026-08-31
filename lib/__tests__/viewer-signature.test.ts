import assert from "node:assert/strict"
import { test } from "node:test"
import { Keypair } from "@stellar/stellar-sdk"
import {
  SIGNATURE_PREFIX,
  canonicalSignalPayload,
  signalProofMessage,
  verifySignalSignature,
} from "@/lib/viewer-signature"

/**
 * Simulates the client signing step (SEP-53 framing) without a real wallet.
 * A SEP-53 signature is `ed25519_sign(sha256(prefix + message))`, which is
 * exactly what `Keypair.sign(prefix + message)` produces in @stellar/stellar-sdk.
 */
async function signPayload(payload: {
  title: string
  body: string
  timestamp: number
}, keypair: Keypair): Promise<string> {
  const message = await signalProofMessage(payload)
  const data = SIGNATURE_PREFIX + message
  return Buffer.from(keypair.sign(data)).toString("base64")
}

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
