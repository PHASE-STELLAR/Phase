/**
 * Deploys a fresh phase-protocol contract to testnet for a preview environment.
 *
 * Used by the deploy-preview.yml CI workflow (phase-228).  Outputs a single
 * `CONTRACT_ID=C...` line to stdout so the workflow can capture the ID.
 *
 * Required env vars:
 *   PREVIEW_ADMIN_SECRET_KEY       — testnet secret key for the preview deployer
 *   NEXT_PUBLIC_PHASER_TOKEN_ID    — testnet PHASER token contract ID
 *   NEXT_PUBLIC_CLASSIC_LIQ_ISSUER — testnet issuer public key
 *
 * Optional:
 *   STELLAR_RPC_URL                (default: testnet RPC)
 *   STELLAR_NETWORK_PASSPHRASE     (default: testnet passphrase)
 *   PR_NUMBER                      — PR number for labelling (informational only)
 *   GIT_BRANCH                     — branch name (informational only)
 *   REQUIRED_AMOUNT                (default: 10000000)
 */

import { config } from "dotenv"
import { createHash } from "crypto"
import { execFileSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { Keypair } from "@stellar/stellar-sdk"
import { parseContractId } from "./utils.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")

config({ path: resolve(ROOT, ".env.local") })

const RPC = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org"
const NET =
  process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"

const secret = process.env.PREVIEW_ADMIN_SECRET_KEY?.trim()
const token = process.env.NEXT_PUBLIC_PHASER_TOKEN_ID?.trim()
const treasury = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER?.trim()
const required = process.env.REQUIRED_AMOUNT?.trim() || "10000000"
const prNumber = process.env.PR_NUMBER?.trim() || "unknown"
const branch = process.env.GIT_BRANCH?.trim() || "unknown"

const wasm = resolve(
  ROOT,
  "contracts/phase-protocol/target/wasm32-unknown-unknown/release/phase_protocol.optimized.wasm",
)

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim()
}

function main() {
  if (!secret || !token || !treasury) {
    console.error(
      "Missing PREVIEW_ADMIN_SECRET_KEY, NEXT_PUBLIC_PHASER_TOKEN_ID, or " +
        "NEXT_PUBLIC_CLASSIC_LIQ_ISSUER",
    )
    process.exit(1)
  }

  if (!existsSync(wasm)) {
    console.error("Missing WASM:", wasm)
    console.error("Build + optimize phase-protocol first.")
    process.exit(1)
  }

  const wasmDigest = createHash("sha256").update(readFileSync(wasm)).digest("hex")
  console.log(
    `[deploy-preview-contract] pr=${prNumber} branch=${branch} sha256=${wasmDigest}`,
  )

  const admin = Keypair.fromSecret(secret).publicKey()
  console.log(`[deploy-preview-contract] admin=${admin}`)

  // Upload WASM
  const uploadOut = run("stellar", [
    "contract",
    "upload",
    "--wasm",
    wasm,
    "--source",
    secret,
    "--rpc-url",
    RPC,
    "--network-passphrase",
    NET,
  ])
  console.log(`[deploy-preview-contract] wasm_hash=${uploadOut}`)

  // Deploy contract instance
  const deployOut = run("stellar", [
    "contract",
    "deploy",
    "--wasm-hash",
    uploadOut,
    "--source",
    secret,
    "--rpc-url",
    RPC,
    "--network-passphrase",
    NET,
  ])
  const contractId = parseContractId(deployOut)
  if (!contractId) {
    console.error("[deploy-preview-contract] Could not parse contract ID from:", deployOut)
    process.exit(1)
  }
  console.log(`[deploy-preview-contract] contract_id=${contractId}`)

  // Initialize the contract
  run("stellar", [
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    secret,
    "--rpc-url",
    RPC,
    "--network-passphrase",
    NET,
    "--",
    "initialize",
    "--admin",
    admin,
    "--token",
    token,
    "--treasury",
    treasury,
    "--required_amount",
    required,
  ])
  console.log(`[deploy-preview-contract] initialized`)

  // Emit machine-readable output for the CI step to capture
  console.log(`CONTRACT_ID=${contractId}`)
}

main()
