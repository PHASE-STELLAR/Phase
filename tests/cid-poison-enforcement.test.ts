/**
 * phase-232: CID poison and content-integrity enforcement tests.
 *
 * Tests the spike-035 attack surface: a poisoned cache entry served under
 * gateway failover can bypass verification.  Covers:
 *  - Corrupted payload is never served from cache (read-on-access verification)
 *  - Only the affected CID is invalidated, not the whole cache
 *  - Gateway allowlist: unknown origin fails closed before any bytes examined
 *  - Flag off: read verification skipped (phase-119 behaviour preserved)
 *
 * Run: npx tsx tests/cid-poison-enforcement.test.ts
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// ── Setup ─────────────────────────────────────────────────────────────────────

function enableFlag232() {
  process.env.FEATURE_PHASE_232 = "true"
  process.env.NEXT_PUBLIC_FEATURE_PHASE_232 = "true"
  process.env.FEATURE_PHASE_119 = "true"
  process.env.NEXT_PUBLIC_FEATURE_PHASE_119 = "true"
}

function disableFlag232() {
  delete process.env.FEATURE_PHASE_232
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_232
}

function disableAll() {
  disableFlag232()
  delete process.env.FEATURE_PHASE_119
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_119
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function cidV1ForPayload(payload: Uint8Array): string {
  const digest = new Uint8Array(createHash("sha256").update(payload).digest())
  const bytes = new Uint8Array(4 + digest.length)
  bytes[0] = 0x01
  bytes[1] = 0x55 // raw codec
  bytes[2] = 0x12 // sha2-256
  bytes[3] = 0x20 // length 32
  bytes.set(digest, 4)
  return `b${base32Encode(bytes)}`
}

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

const REAL_PAYLOAD = new TextEncoder().encode(JSON.stringify({ name: "Real World" }))
const POISONED_PAYLOAD = new TextEncoder().encode(JSON.stringify({ name: "EVIL", image: "https://evil.example/steal.png" }))

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testPoisonedCacheEntryThrowsOnRead() {
  const { setCachedCid, getCachedCid, clearCidMemoryCache, CidIntegrityError } =
    await import("@/lib/cid-cache")

  enableFlag232()
  clearCidMemoryCache()

  const cid = cidV1ForPayload(REAL_PAYLOAD)
  const realSha = sha256Hex(REAL_PAYLOAD)

  // Store the real bytes.
  await setCachedCid(cid, REAL_PAYLOAD, { expectedSha256: realSha })

  // Directly corrupt the in-memory entry by writing a poisoned buffer under the same key.
  // We do this by grabbing the internal map — in production the attack is a gateway
  // substituting different bytes for the same CID across a failover.
  // Here we simulate it by calling setCachedCid with the POISONED_PAYLOAD but the
  // REAL CID (bypassing the hash check that would normally reject this).
  // We skip expectedSha256 to get the bytes into the store under the wrong CID.
  // The phase-232 read check is what should catch this.
  const poisonedSha = sha256Hex(POISONED_PAYLOAD)
  // Store poisoned bytes keyed to the real CID (no integrity check on write without expectedSha256).
  await setCachedCid(cid, POISONED_PAYLOAD)

  // Now read: phase-232 should detect hash mismatch and throw.
  let threw = false
  try {
    await getCachedCid(cid)
  } catch (e) {
    threw = true
    assert.ok(e instanceof CidIntegrityError, "must throw CidIntegrityError")
    assert.ok(
      e.code === "TAMPERED" || e.code === "HASH_MISMATCH",
      `code must be TAMPERED or HASH_MISMATCH, got ${e.code}`,
    )
  }
  assert.ok(threw, "phase-232: getCachedCid must throw on a corrupted entry")
  clearCidMemoryCache()
}

async function testPoisonDetectionInvalidatesOnlyAffectedCid() {
  const { setCachedCid, getCachedCid, clearCidMemoryCache, getCidCacheStats, CidIntegrityError } =
    await import("@/lib/cid-cache")

  enableFlag232()
  clearCidMemoryCache()

  const otherPayload = new TextEncoder().encode(JSON.stringify({ name: "Safe World" }))
  const cidReal = cidV1ForPayload(REAL_PAYLOAD)
  const cidOther = cidV1ForPayload(otherPayload)

  // Store two clean entries.
  await setCachedCid(cidOther, otherPayload, { expectedSha256: sha256Hex(otherPayload) })
  // Store poisoned entry under cidReal.
  await setCachedCid(cidReal, POISONED_PAYLOAD)

  const statsBefore = getCidCacheStats()
  assert.ok(statsBefore.entries >= 2, "both entries should be in cache before poison check")

  // Trigger poison detection on cidReal.
  try { await getCachedCid(cidReal) } catch { /* expected */ }

  // The other CID must still be accessible.
  const other = await getCachedCid(cidOther)
  assert.ok(other !== null, "unaffected CID must remain in cache after poison invalidation")
  assert.deepEqual(other.bytes, Buffer.from(otherPayload))

  clearCidMemoryCache()
}

async function testGatewayAllowlistBlocksUnknownOrigin() {
  const { assertGatewayAllowed, GatewayNotAllowedError } = await import("@/lib/cid-cache")

  enableFlag232()

  const knownGateways = [
    "https://w3s.link/ipfs/bafy",
    "https://dweb.link/ipfs/bafy",
    "https://ipfs.io/ipfs/bafy",
    "https://cloudflare-ipfs.com/ipfs/bafy",
  ]

  for (const gw of knownGateways) {
    assert.doesNotThrow(
      () => assertGatewayAllowed(gw),
      `known gateway must pass: ${gw}`,
    )
  }

  const unknownGateways = [
    "https://evil.example/ipfs/bafy",
    "https://rogue-gateway.net/ipfs/bafy",
    "http://localhost:8080/ipfs/bafy",
  ]

  for (const gw of unknownGateways) {
    assert.throws(
      () => assertGatewayAllowed(gw),
      (err: unknown) => err instanceof GatewayNotAllowedError,
      `unknown gateway must throw: ${gw}`,
    )
  }
}

async function testGatewayAllowlistSkippedWhenFlagOff() {
  const { assertGatewayAllowed } = await import("@/lib/cid-cache")

  disableFlag232()

  // Even an evil gateway should not throw when phase-232 is off.
  assert.doesNotThrow(
    () => assertGatewayAllowed("https://evil.example/ipfs/bafy"),
    "gateway check must be skipped when phase-232 is off",
  )
}

async function testReadVerificationSkippedWhenFlagOff() {
  const { setCachedCid, getCachedCid, clearCidMemoryCache } = await import("@/lib/cid-cache")

  disableFlag232()
  process.env.FEATURE_PHASE_119 = "true"
  process.env.NEXT_PUBLIC_FEATURE_PHASE_119 = "true"
  clearCidMemoryCache()

  const cid = cidV1ForPayload(REAL_PAYLOAD)
  // Store poisoned bytes without phase-232 on — the old path does not re-verify on read
  // unless verifyIntegrity=true and expectedSha256 is supplied.
  await setCachedCid(cid, POISONED_PAYLOAD)

  // With phase-232 off, getCachedCid does not throw on a hash mismatch.
  let threw = false
  try {
    await getCachedCid(cid)
  } catch {
    threw = true
  }
  assert.ok(!threw, "phase-232 off: getCachedCid must not throw on mismatch (phase-119 behaviour)")
  clearCidMemoryCache()
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "phase-232-test-"))
  process.env.PHASE_SERVER_DATA_DIR = tmpDir

  try {
    await testPoisonedCacheEntryThrowsOnRead()
    console.log("✓ poisoned cache entry throws CidIntegrityError on read (phase-232 on)")

    await testPoisonDetectionInvalidatesOnlyAffectedCid()
    console.log("✓ poison detection invalidates only the affected CID")

    await testGatewayAllowlistBlocksUnknownOrigin()
    console.log("✓ gateway allowlist blocks unknown origins (phase-232 on)")

    await testGatewayAllowlistSkippedWhenFlagOff()
    console.log("✓ gateway allowlist check skipped when phase-232 is off")

    await testReadVerificationSkippedWhenFlagOff()
    console.log("✓ read verification skipped when phase-232 is off (phase-119 behaviour)")

    console.log("\nAll phase-232 CID poison enforcement tests passed.")
  } finally {
    disableAll()
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
