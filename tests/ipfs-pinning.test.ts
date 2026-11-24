/**
 * phase-117: multi-gateway IPFS pinning with redundancy — tests
 * Run: npx tsx tests/ipfs-pinning.test.ts
 */
import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_117 = "1"
process.env.FEATURE_PHASE_117 = "1"

import { pinWithRedundancy, pinChecksum, verifyPinChecksum, resolveMultiPinConfig, isPhase117Enabled } from "@/lib/ipfs-pinning"

async function testChecksum() {
  const hex = pinChecksum(Buffer.from("pin test"))
  assert.match(hex, /^[a-f0-9]{64}$/)
  assert.equal(verifyPinChecksum(Buffer.from("pin test"), hex), true)
  assert.equal(verifyPinChecksum(Buffer.from("pin test"), "0".repeat(64)), false)
  console.log("✓ pin checksum")
}

async function testConfig() {
  const cfg = resolveMultiPinConfig({ quorum: 2 })
  assert.equal(cfg.quorum, 2)
  const clamped = resolveMultiPinConfig({ gateways: [{ name: "pinata", pinUrl: "https://api.pinata.cloud/pinning/pinFileToIPFS", gatewayUrl: "https://gateway.pinata.cloud/ipfs", priority: 1, timeoutMs: 12000 }], quorum: 2 } as any)
  // quorum clamped to length
  assert.equal(clamped.quorum, 1)
  console.log("✓ config quorum clamping")
}

async function testPinSuccessWithVerify() {
  const blob = new Blob(["avatar bytes"], { type: "image/png" })
  const checksum = pinChecksum(Buffer.from("avatar bytes"))
  let pinCalled = false
  let fetchCalled = 0
  const mockFetch = async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes("pinata.cloud")) {
      pinCalled = true
      return new Response(JSON.stringify({ IpfsHash: "bafyTestPinSuccess" }), { status: 200 })
    }
    // verify fetch for gateways
    fetchCalled++
    // return same bytes for verification
    return new Response(Buffer.from("avatar bytes"), { status: 200, headers: { "content-type": "image/png" } })
  }
  const res = await pinWithRedundancy(blob, "fake-jwt", {
    config: { quorum: 1, verifyFetch: true },
    fetchImpl: mockFetch as unknown as typeof fetch,
  })
  assert.equal(pinCalled, true)
  assert.equal(res.ok, true)
  assert.equal(res.cid, "bafyTestPinSuccess")
  assert.equal(res.verified, true)
  assert.ok(res.achieved >= 1)
  assert.equal(res.checksum, checksum)
  console.log("✓ pinWithRedundancy success + verify (quorum 1)")
}

async function testPinQuorumFailure() {
  const blob = new Blob(["avatar2"], { type: "image/png" })
  const mockFetch = async (url: string | URL) => {
    const u = String(url)
    if (u.includes("pinata.cloud")) {
      return new Response(JSON.stringify({ IpfsHash: "bafyQuorumFail" }), { status: 200 })
    }
    // verification gateways fail
    return new Response("not found", { status: 404 })
  }
  const res = await pinWithRedundancy(blob, "fake-jwt", {
    config: { quorum: 2, verifyFetch: true, gateways: [
      { name: "pinata", pinUrl: "https://api.pinata.cloud/pinning/pinFileToIPFS", gatewayUrl: "https://gateway.pinata.cloud/ipfs", priority: 1, timeoutMs: 12000 },
      { name: "w3s", pinUrl: "https://api.web3.storage/upload", gatewayUrl: "https://w3s.link/ipfs", priority: 2, timeoutMs: 12000 },
      { name: "dweb", pinUrl: "https://dweb.link/api/v0/add", gatewayUrl: "https://dweb.link/ipfs", priority: 3, timeoutMs: 12000 },
    ] } as any,
    fetchImpl: mockFetch as unknown as typeof fetch,
  })
  // Pin succeeded but verify failed, so achieved = 1, quorum 2 not met
  assert.equal(res.ok, false)
  assert.equal(res.achieved, 1)
  console.log("✓ quorum failure when verify gateways down")
}

async function testPinFallbackWhenFlagOff() {
  process.env.NEXT_PUBLIC_FEATURE_PHASE_117 = "0"
  process.env.FEATURE_PHASE_117 = "0"
  const mod = await import("@/lib/ipfs-pinning")
  // flag now false, pin should fallback to single gateway
  const blob = new Blob(["fallback"], { type: "image/png" })
  const mockFetch = async () => new Response(JSON.stringify({ IpfsHash: "bafyFallback" }), { status: 200 })
  const res = await mod.pinWithRedundancy(blob, "fake-jwt", { fetchImpl: mockFetch as unknown as typeof fetch })
  assert.equal(res.ok, true)
  assert.equal(res.cid, "bafyFallback")
  assert.equal(res.achieved, 1)
  // restore
  process.env.NEXT_PUBLIC_FEATURE_PHASE_117 = "1"
  process.env.FEATURE_PHASE_117 = "1"
  console.log("✓ flag-off fallback single pin")
}

async function testFlag() {
  assert.equal(isPhase117Enabled(), true)
  console.log("✓ flag enabled")
}

async function main() {
  console.log("=== phase-117 tests ===")
  await testChecksum()
  await testConfig()
  await testPinSuccessWithVerify()
  await testPinQuorumFailure()
  await testPinFallbackWhenFlagOff()
  await testFlag()
  console.log("=== phase-117 all passed ===")
}

main().catch((e) => {
  console.error("phase-117 test failed:", e)
  process.exit(1)
})
