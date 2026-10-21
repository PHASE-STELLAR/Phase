/**
 * phase-120: IPFS upload retry with exponential backoff + checksum — tests
 * Run: npx tsx tests/ipfs-upload-retry.test.ts
 */

import assert from "node:assert/strict"

// enable flag
process.env.NEXT_PUBLIC_FEATURE_PHASE_120 = "1"
process.env.FEATURE_PHASE_120 = "1"

import {
  computeSha256Hex,
  verifyChecksum,
  exponentialBackoffMs,
  resolveRetryConfig,
  pinFileToIpfsWithRetry,
  uploadToIpfsWithRetry,
  isPhase120Enabled,
  IpfsUploadRetryConfigSchema,
} from "@/lib/ipfs-upload-retry"

async function testChecksum() {
  const bytes = Buffer.from("hello phase")
  const hex = computeSha256Hex(bytes)
  assert.match(hex, /^[a-f0-9]{64}$/, "sha256 hex format")
  assert.equal(verifyChecksum(bytes, hex), true, "verify true for correct hash")
  assert.equal(verifyChecksum(bytes, "0".repeat(64)), false, "verify false for wrong hash")
  // constant-time compare respects case lower
  console.log("✓ checksum compute & verify")
}

async function testBackoff() {
  const b0 = exponentialBackoffMs(0, 600, 8000, 0)
  assert.equal(b0, 600)
  const b1 = exponentialBackoffMs(1, 600, 8000, 0)
  assert.equal(b1, 1200)
  const b2 = exponentialBackoffMs(2, 600, 8000, 0)
  assert.equal(b2, 2400)
  const bCap = exponentialBackoffMs(10, 600, 8000, 0)
  assert.equal(bCap, 8000, "capped at maxDelayMs")
  // jitter stays within bounds
  for (let i = 0; i < 20; i++) {
    const j = exponentialBackoffMs(0, 1000, 10000, 0.2)
    assert.ok(j >= 800 && j <= 1200, `jitter within ±20% got ${j}`)
  }
  console.log("✓ exponentialBackoffMs")
}

async function testConfig() {
  const cfg = resolveRetryConfig({ maxRetries: 2, baseDelayMs: 500 })
  assert.equal(cfg.maxRetries, 2)
  assert.equal(cfg.baseDelayMs, 500)
  const bad = resolveRetryConfig({ maxRetries: 99 as unknown as number })
  assert.equal(bad.maxRetries, 3, "fallback to default on invalid")
  const parsed = IpfsUploadRetryConfigSchema.safeParse({ maxRetries: 3, baseDelayMs: 600, maxDelayMs: 8000, jitterRatio: 0.2, timeoutMs: 15000, checksumAlgo: "sha256" })
  assert.equal(parsed.success, true)
  console.log("✓ resolveRetryConfig")
}

async function testPinRetrySuccess() {
  const blob = new Blob(["phase og bytes"], { type: "image/png" })
  let call = 0
  const mockFetch = async () => {
    call++
    if (call <= 2) {
      return new Response(JSON.stringify({ error: "Bad gateway" }), { status: 502 })
    }
    return new Response(JSON.stringify({ IpfsHash: "QmTestHash1234567890abcdef" }), { status: 200 })
  }
  const res = await pinFileToIpfsWithRetry(blob, "fake-jwt", {
    config: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0, timeoutMs: 5000 },
    fetchImpl: mockFetch as unknown as typeof fetch,
  })
  assert.equal(res.ipfsHash, "QmTestHash1234567890abcdef")
  assert.equal(res.uri, "ipfs://QmTestHash1234567890abcdef")
  assert.equal(res.attempts, 3)
  assert.equal(res.perAttempt.length, 3)
  assert.equal(res.perAttempt[0]?.status, "retry")
  assert.equal(res.perAttempt[2]?.status, "success")
  console.log("✓ pinFileToIpfsWithRetry retry succeeds on transient 502")
}

async function testPinRetryExhausted() {
  const blob = new Blob(["fail bytes"], { type: "image/png" })
  const mockFetch = async () => new Response(JSON.stringify({ error: "Bad gateway" }), { status: 503 })
  let threw = false
  try {
    await pinFileToIpfsWithRetry(blob, "fake-jwt", {
      config: { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0, timeoutMs: 5000 },
      fetchImpl: mockFetch as unknown as typeof fetch,
    })
  } catch (e) {
    threw = true
    const err = e as { code?: string; attempts?: number }
    assert.equal(err.code, "RETRY_EXHAUSTED")
    assert.equal(err.attempts, 2)
  }
  assert.equal(threw, true, "should throw RETRY_EXHAUSTED")
  console.log("✓ pinFileToIpfsWithRetry exhausted")
}

async function testUploadClientRetry() {
  const file = new File(["client bytes"], "art.png", { type: "image/png" })
  let call = 0
  const mockFetch = async () => {
    call++
    if (call === 1) return new Response(JSON.stringify({ error: "timeout" }), { status: 504 })
    return new Response(JSON.stringify({ uri: "ipfs://bafyClientOk" }), { status: 200 })
  }
  const res = await uploadToIpfsWithRetry(file, {
    config: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0 },
    fetchImpl: mockFetch as unknown as typeof fetch,
  })
  assert.equal(res.uri, "ipfs://bafyClientOk")
  assert.equal(res.attempts, 2)
  console.log("✓ uploadToIpfsWithRetry client retry")
}

async function testFlag() {
  assert.equal(isPhase120Enabled(), true)
  process.env.NEXT_PUBLIC_FEATURE_PHASE_120 = "0"
  // dynamic flag check reads env each call, so after unset should be false
  const mod = await import("@/lib/ipfs-upload-retry")
  // re-evaluate by directly reading env gate
  const before = mod.isPhase120Enabled()
  // restore
  process.env.NEXT_PUBLIC_FEATURE_PHASE_120 = "1"
  console.log("✓ flag enabled check (", before, "→", mod.isPhase120Enabled(), ")")
}

async function main() {
  console.log("=== phase-120 tests ===")
  await testChecksum()
  await testBackoff()
  await testConfig()
  await testPinRetrySuccess()
  await testPinRetryExhausted()
  await testUploadClientRetry()
  await testFlag()
  console.log("=== phase-120 all passed ===")
}

main().catch((e) => {
  console.error("phase-120 test failed:", e)
  process.exit(1)
})
