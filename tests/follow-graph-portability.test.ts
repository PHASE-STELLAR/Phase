/**
 * phase-95: follow-graph export and import portability — tests
 * Run: npx tsx tests/follow-graph-portability.test.ts
 */
import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_95 = "1"
process.env.FEATURE_PHASE_95 = "1"

import {
  FollowGraphPortabilityError,
  buildFollowGraphExport,
  computeFollowGraphChecksum,
  parseFollowGraphImport,
  auditFollowGraphPortabilityWiring,
} from "@/lib/env-validation"

const WALLET_A = "GA" + "A".repeat(54)
const WALLET_B = "GB" + "B".repeat(53) + "A"
const WALLET_C = "GC" + "C".repeat(53) + "A"

async function testExportRoundTrip() {
  const bundle = buildFollowGraphExport(WALLET_A, [WALLET_B, WALLET_C], [WALLET_B])
  assert.equal(bundle.format, "phase-follow-graph")
  assert.equal(bundle.wallet, WALLET_A)
  assert.equal(bundle.following.length, 2)

  const imported = parseFollowGraphImport(bundle, { expectedWallet: WALLET_A })
  assert.deepEqual(imported.following.sort(), [WALLET_B, WALLET_C].sort())
  assert.deepEqual(imported.followers, [WALLET_B])
  console.log("✓ export/import round trip")
}

async function testChecksumTamperDetected() {
  const bundle = buildFollowGraphExport(WALLET_A, [WALLET_B], [])
  const tampered = { ...bundle, following: [WALLET_B, WALLET_C] } // mutate payload, keep stale checksum
  let threw = false
  try {
    parseFollowGraphImport(tampered)
  } catch (e) {
    threw = e instanceof FollowGraphPortabilityError && e.code === "CHECKSUM_MISMATCH"
  }
  assert.equal(threw, true)
  console.log("✓ tampered bundle checksum mismatch detected")
}

async function testWalletMismatchDetected() {
  const bundle = buildFollowGraphExport(WALLET_A, [WALLET_B], [])
  let threw = false
  try {
    parseFollowGraphImport(bundle, { expectedWallet: WALLET_C })
  } catch (e) {
    threw = e instanceof FollowGraphPortabilityError && e.code === "WALLET_MISMATCH"
  }
  assert.equal(threw, true)
  console.log("✓ wallet mismatch on import detected")
}

async function testDeterministicChecksum() {
  const c1 = computeFollowGraphChecksum(WALLET_A, [WALLET_B, WALLET_C], [])
  const c2 = computeFollowGraphChecksum(WALLET_A, [WALLET_C, WALLET_B], []) // order-independent
  assert.equal(c1, c2)
  console.log("✓ checksum is order-independent and deterministic")
}

async function testFlagDisabledBlocks() {
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_95
  delete process.env.FEATURE_PHASE_95
  let threw = false
  try {
    buildFollowGraphExport(WALLET_A, [], [])
  } catch (e) {
    threw = e instanceof FollowGraphPortabilityError && e.code === "FLAG_DISABLED"
  }
  assert.equal(threw, true)
  process.env.NEXT_PUBLIC_FEATURE_PHASE_95 = "1"
  process.env.FEATURE_PHASE_95 = "1"
  console.log("✓ export blocked when phase-95 flag disabled")
}

async function testAuditWiring() {
  const audit = auditFollowGraphPortabilityWiring()
  assert.equal(audit.ok, true)
  console.log("✓ diagnose-env wiring audit passes")
}

async function run() {
  await testExportRoundTrip()
  await testChecksumTamperDetected()
  await testWalletMismatchDetected()
  await testDeterministicChecksum()
  await testFlagDisabledBlocks()
  await testAuditWiring()
  console.log("\nAll follow-graph-portability (phase-95) tests passed.")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
