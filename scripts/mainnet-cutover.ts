#!/usr/bin/env node
/**
 * Mainnet Cutover Runbook & Verification Tooling
 * Issue #689 (phase-238)
 *
 * Requirements:
 * - Verify issuer public key (G...)
 * - Verify Soroban contract IDs (C...)
 * - Verify network passphrase matches canonical mainnet
 * - Require dual authorization: PHASE_MAINNET_CUTOVER_ACK=1 and PHASE_MAINNET_CONFIRMATION_TOKEN
 * - Support dry run mode asserting zero writes
 *
 * Usage:
 *   npx tsx scripts/mainnet-cutover.ts [--dry-run]
 */

import * as stellarNetworkModule from "../lib/stellar-network"
const stellarNetwork = (stellarNetworkModule as any).default ?? stellarNetworkModule
const {
  verifyMainnetCutoverReadiness,
  resolveStellarNetwork,
  isPhase238Enabled,
} = stellarNetwork

async function runCutoverVerification() {
  const isDryRunArg = process.argv.includes("--dry-run")
  if (isDryRunArg) {
    process.env.PHASE_MAINNET_DRY_RUN = "1"
  }

  console.log("=== PHASE MAINNET CUTOVER VERIFICATION ===")
  console.log(`Phase 238 Feature Gate: ${isPhase238Enabled() ? "ENABLED" : "DISABLED"}`)
  console.log(`Dry-run mode: ${process.env.PHASE_MAINNET_DRY_RUN === "1" ? "ACTIVE (ZERO WRITES ASSERTED)" : "INACTIVE"}`)

  const checklist = verifyMainnetCutoverReadiness({
    env: process.env,
  })

  console.log("\nCutover Checklist:")
  console.log(`  - Cutover ACK (=1): ${process.env.PHASE_MAINNET_CUTOVER_ACK === "1" ? "PASS" : "FAIL"}`)
  console.log(`  - Confirmation Token: ${checklist.tokenValid ? "PASS" : "FAIL"}`)
  console.log(`  - Issuer Public Key: ${checklist.issuerValid ? "PASS" : "FAIL"}`)
  console.log(`  - Soroban Contract ID: ${checklist.contractValid ? "PASS" : "FAIL"}`)
  console.log(`  - Network Passphrase: ${checklist.passphraseValid ? "PASS" : "FAIL"}`)

  if (!checklist.ready) {
    console.error("\n[!] Cutover verification failed with errors:")
    for (const err of checklist.errors) {
      console.error(`  - ${err}`)
    }
    if (!process.env.CUTOVER_TEST_MODE) {
      process.exit(1)
    }
    return false
  }

  // Network resolution check
  try {
    const resolved = resolveStellarNetwork({
      STELLAR_NETWORK: "mainnet",
      PHASE_MAINNET_CUTOVER_ACK: process.env.PHASE_MAINNET_CUTOVER_ACK,
      PHASE_MAINNET_CONFIRMATION_TOKEN: process.env.PHASE_MAINNET_CONFIRMATION_TOKEN,
      FEATURE_PHASE_238: "1",
    })
    console.log(`\nNetwork Resolution: OK (${resolved.network} - ${resolved.passphrase})`)
  } catch (err: any) {
    console.error(`\nNetwork Resolution Failed: ${err.message}`)
    if (!process.env.CUTOVER_TEST_MODE) {
      process.exit(1)
    }
    return false
  }

  console.log("\n[SUCCESS] Mainnet cutover readiness verified successfully.")
  if (checklist.isDryRun) {
    console.log("[DRY-RUN CONFIRMATION] Zero state changes were performed.")
  }
  return true
}

if (process.argv[1] && process.argv[1].includes("mainnet-cutover")) {
  runCutoverVerification().catch((err) => {
    console.error("Cutover script error:", err)
    process.exit(1)
  })
}

export { runCutoverVerification }
