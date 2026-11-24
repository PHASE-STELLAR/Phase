/**
 * phase-119: CID content-addressing cache with integrity checks — tests
 * Run: npx tsx tests/cid-cache.test.ts
 */
import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_119 = "1"
process.env.FEATURE_PHASE_119 = "1"

import {
  validateCid,
  sha256Hex,
  verifyBytesIntegrity,
  setCachedCid,
  getCachedCid,
  clearCidMemoryCache,
  CidSchema,
  CidIntegrityError,
  isPhase119Enabled,
} from "@/lib/cid-cache"

async function testCidValidation() {
  assert.equal(validateCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), true)
  assert.equal(validateCid("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"), true)
  assert.equal(validateCid("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"), true)
  assert.equal(validateCid("invalidCid"), false)
  assert.equal(validateCid(""), false)
  console.log("✓ CID validation")
}

async function testSha256() {
  const hex = sha256Hex(Buffer.from("phase"))
  assert.match(hex, /^[a-f0-9]{64}$/)
  assert.equal(verifyBytesIntegrity(Buffer.from("phase"), hex), true)
  assert.equal(verifyBytesIntegrity(Buffer.from("phase"), "0".repeat(64)), false)
  console.log("✓ sha256 & verify")
}

async function testCacheRoundTrip() {
  clearCidMemoryCache()
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
  const bytes = Buffer.from("hello cid cache")
  const entry = await setCachedCid(cid, bytes, { contentType: "text/plain" })
  assert.equal(entry.cid, cid)
  assert.equal(entry.byteLength, bytes.length)
  assert.match(entry.sha256, /^[a-f0-9]{64}$/)

  const fetched = await getCachedCid(cid)
  assert.ok(fetched, "should hit cache")
  assert.equal(fetched!.bytes.toString(), bytes.toString())
  assert.equal(fetched!.entry.sha256, entry.sha256)
  console.log("✓ cache set/get round-trip")
}

async function testIntegrityTamper() {
  clearCidMemoryCache()
  const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
  const bytes = Buffer.from("good bytes")
  await setCachedCid(cid, bytes)

  // tampered expected hash should fail verification when we ask for expectedSha256
  let threw = false
  try {
    await getCachedCid(cid, { expectedSha256: "0".repeat(64) })
  } catch (e) {
    threw = e instanceof CidIntegrityError && (e.code === "TAMPERED" || e.code === "HASH_MISMATCH")
  }
  assert.equal(threw, true, "tamper should throw integrity error")
  console.log("✓ integrity tamper detection")
}

async function testExpectedShaOnSet() {
  clearCidMemoryCache()
  const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
  const bytes = Buffer.from("with expected")
  const sha = sha256Hex(bytes)
  // correct expected should succeed
  const entry = await setCachedCid(cid, bytes, { expectedSha256: sha })
  assert.equal(entry.sha256, sha)
  // wrong expected should throw
  let threw = false
  try {
    await setCachedCid(cid, Buffer.from("other"), { expectedSha256: sha })
  } catch (e) {
    threw = e instanceof CidIntegrityError
  }
  assert.equal(threw, true)
  console.log("✓ expectedSha on set")
}

async function testInvalidCidThrows() {
  let threw = false
  try {
    await setCachedCid("bad", Buffer.from("x"))
  } catch (e) {
    threw = e instanceof CidIntegrityError && e.code === "CID_INVALID"
  }
  assert.equal(threw, true)
  console.log("✓ invalid CID throws")
}

async function testFlag() {
  assert.equal(isPhase119Enabled(), true)
  console.log("✓ flag enabled")
}

async function main() {
  console.log("=== phase-119 tests ===")
  await testCidValidation()
  await testSha256()
  await testCacheRoundTrip()
  await testIntegrityTamper()
  await testExpectedShaOnSet()
  await testInvalidCidThrows()
  await testFlag()
  console.log("=== phase-119 all passed ===")
}

main().catch((e) => {
  console.error("phase-119 test failed:", e)
  process.exit(1)
})
