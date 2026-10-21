/**
 * CID verification + metadata_uri allowlist (issue #229) — tests
 * Run: npx tsx tests/cid-verification.test.ts
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  base32Decode,
  cacheControlForCid,
  parseMetadataUri,
  verifyCID,
} from "@/lib/cid-verification"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 0x1f]
  return out
}

/** Build a real CIDv1 (raw codec 0x55, sha2-256 0x12) over `payload`. */
function cidV1ForPayload(payload: Uint8Array): string {
  const digest = new Uint8Array(createHash("sha256").update(payload).digest())
  const bytes = new Uint8Array(4 + digest.length)
  bytes[0] = 0x01 // version 1
  bytes[1] = 0x55 // raw codec
  bytes[2] = 0x12 // sha2-256
  bytes[3] = 0x20 // length 32
  bytes.set(digest, 4)
  return `b${base32Encode(bytes)}`
}

const PAYLOAD = new TextEncoder().encode(JSON.stringify({ name: "Real World" }))
const ATTACKER_PAYLOAD = new TextEncoder().encode(
  JSON.stringify({ name: "Fake World", image: "https://evil.example/steal.png" }),
)

function testVerifyAcceptsMatchingPayload() {
  const cid = cidV1ForPayload(PAYLOAD)
  const result = verifyCID(cid, PAYLOAD)
  assert.equal(result.ok, true, "a payload matching its CID must verify")
  assert.equal(result.ok && result.algorithm, "sha2-256")
}

function testVerifyRejectsAttackerPayloadUnderRealCid() {
  // The attack in #229: keep a legitimate-looking CID, swap the bytes.
  const cid = cidV1ForPayload(PAYLOAD)
  const result = verifyCID(cid, ATTACKER_PAYLOAD)
  assert.equal(result.ok, false, "attacker bytes under a valid CID must fail")
  assert.equal(result.ok === false && result.code, "CID_MISMATCH")
}

function testVerifyRejectsMalformedCid() {
  const result = verifyCID("not-a-cid", PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, "CID_INVALID")
}

function testVerifyRejectsBlake2bAsUnverifiable() {
  // bafb… is blake2b-256: node:crypto cannot recompute it, so it must be
  // reported unverified rather than silently passed.
  const result = verifyCID("bafb" + "a".repeat(58), PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, "CID_UNVERIFIABLE")
}

function testVerifyCidV0() {
  // A real Qm… CIDv0 for sha2-256 of PAYLOAD.
  const digest = new Uint8Array(createHash("sha256").update(PAYLOAD).digest())
  const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  const full = new Uint8Array(2 + digest.length)
  full[0] = 0x12
  full[1] = 0x20
  full.set(digest, 2)
  let value = 0n
  for (const byte of full) value = value * 256n + BigInt(byte)
  let encoded = ""
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded
    value /= 58n
  }
  const cidv0 = "Qm" + encoded
  const ok = verifyCID(cidv0, PAYLOAD)
  assert.equal(ok.ok, true, "CIDv0 whose digest matches must verify")
  const bad = verifyCID(cidv0, ATTACKER_PAYLOAD)
  assert.equal(bad.ok === false && bad.code, "CID_MISMATCH")
}

function testBase32RoundTrip() {
  const bytes = new Uint8Array([0x01, 0x55, 0x12, 0x20, 0xff, 0x00, 0x7f])
  const encoded = base32Encode(bytes)
  const decoded = base32Decode(encoded)
  assert.deepEqual(Array.from(decoded.slice(0, bytes.length)), Array.from(bytes))
}

function testCacheControlSplit() {
  resetSecurityCounters()
  const verified = verifyCID(cidV1ForPayload(PAYLOAD), PAYLOAD)
  assert.match(cacheControlForCid(verified, false), /^public,/)
  assert.match(cacheControlForCid(verified, true), /^private,/)

  const mismatched = verifyCID(cidV1ForPayload(PAYLOAD), ATTACKER_PAYLOAD)
  const header = cacheControlForCid(mismatched, false)
  assert.match(header, /^private, no-store/, "an unverified CID must not enter a shared cache")
  assert.match(header, /Vary: Authorization/)
}

function testMetadataUriAllowlist() {
  const cid = cidV1ForPayload(PAYLOAD)
  const ok = parseMetadataUri(`ipfs://${cid}`)
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.cid, cid)

  const withPath = parseMetadataUri(`ipfs://${cid}/metadata.json`)
  assert.equal(withPath.ok, true)
  assert.equal(withPath.ok && withPath.path, "metadata.json")
}

function testMetadataUriRejectsNonIpfsScheme() {
  // The issue's exploit: an arbitrary https origin named as metadata_uri.
  const result = parseMetadataUri("https://evil.example/metadata.json")
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, "METADATA_URI_SCHEME")
}

function testMetadataUriRejectsMalformed() {
  for (const bad of ["", "ipfs://", "not-a-uri", "ipfs://short", "ftp://x/y"]) {
    const result = parseMetadataUri(bad)
    assert.equal(result.ok, false, `"${bad}" must be rejected`)
  }
}

function testCountersIncrement() {
  resetSecurityCounters()
  verifyCID(cidV1ForPayload(PAYLOAD), ATTACKER_PAYLOAD)
  assert.ok(getSecurityCounter("cid_mismatch") > 0, "a mismatch must be counted")
  parseMetadataUri("https://evil.example/x")
  assert.ok(getSecurityCounter("metadata_uri_rejected") > 0, "a rejected uri must be counted")
  verifyCID(cidV1ForPayload(PAYLOAD), PAYLOAD)
  assert.ok(getSecurityCounter("cid_verified") > 0, "a verified cid must be counted")
}

async function main() {
  testVerifyAcceptsMatchingPayload(); console.log("✓ accepts a payload matching its CID")
  testVerifyRejectsAttackerPayloadUnderRealCid(); console.log("✓ rejects attacker bytes under a valid CID")
  testVerifyRejectsMalformedCid(); console.log("✓ rejects a malformed CID")
  testVerifyRejectsBlake2bAsUnverifiable(); console.log("✓ reports blake2b CID as unverifiable")
  testVerifyCidV0(); console.log("✓ verifies CIDv0 both ways")
  testBase32RoundTrip(); console.log("✓ base32 round-trips")
  testCacheControlSplit(); console.log("✓ public only for verified non-gated CID")
  testMetadataUriAllowlist(); console.log("✓ accepts ipfs:// metadata_uri")
  testMetadataUriRejectsNonIpfsScheme(); console.log("✓ rejects https metadata_uri")
  testMetadataUriRejectsMalformed(); console.log("✓ rejects malformed metadata_uri")
  testCountersIncrement(); console.log("✓ counters record mismatches, rejections, verifications")
  console.log("\nAll CID verification tests passed.")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
