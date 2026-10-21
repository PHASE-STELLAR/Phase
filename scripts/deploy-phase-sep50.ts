/**
 * Despliega el WASM actual de phase-protocol (p. ej. revision SEP-0050 owner_of/token_uri),
 * ejecuta initialize con valores de `.env.local`, y actualiza `lib/phase-contract-defaults.ts` + `.env.local`.
 *
 * Requiere: `ADMIN_SECRET_KEY`, `NEXT_PUBLIC_PHASER_TOKEN_ID`, `NEXT_PUBLIC_CLASSIC_LIQ_ISSUER`.
 * Opcional: `REQUIRED_AMOUNT` (default 10000000).
 *
 * Uso (desde repo root):
 *   cd contracts/phase-protocol && cargo build --target wasm32-unknown-unknown --release \
 *     && stellar contract optimize --wasm target/wasm32-unknown-unknown/release/phase_protocol.wasm \
 *        --wasm-out target/wasm32-unknown-unknown/release/phase_protocol.optimized.wasm
 *   cd ../../scripts && npx tsx deploy-phase-sep50.ts
 */

import { config } from "dotenv"
import { createHash } from "crypto"
import { execFileSync } from "child_process"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { Keypair } from "@stellar/stellar-sdk"
import { parseContractId } from "./utils.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")

config({ path: resolve(ROOT, ".env.local") })

const RPC = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org"
const NET = process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"

const secret = process.env.ADMIN_SECRET_KEY?.trim()
const token = process.env.NEXT_PUBLIC_PHASER_TOKEN_ID?.trim()
const treasury = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER?.trim()
const required = process.env.REQUIRED_AMOUNT?.trim() || "10000000"

const wasm = resolve(
  ROOT,
  "contracts/phase-protocol/target/wasm32-unknown-unknown/release/phase_protocol.optimized.wasm",
)

function main() {
  if (!secret || !token || !treasury) {
    console.error(
      "Missing ADMIN_SECRET_KEY, NEXT_PUBLIC_PHASER_TOKEN_ID, or NEXT_PUBLIC_CLASSIC_LIQ_ISSUER in .env.local",
    )
    process.exit(1)
  }

  if (!existsSync(wasm)) {
    console.error("Missing WASM:", wasm)
    console.error("Build + optimize first (see script header).")
    process.exit(1)
  }

  // Spike 608 (phase-175): log canonical target and WASM SHA-256 digest before staging/testnet deploy
  const wasmDigest = createHash("sha256").update(readFileSync(wasm)).digest("hex")
  console.log(`[deploy-phase-sep50] target=wasm32-unknown-unknown sha256=${wasmDigest}`)

  const admin = Keypair.fromSecret(secret).publicKey()
  const env = { ...process.env, STELLAR_ACCOUNT: secret }

  function stellar(args: string[]): string {
    return execFileSync("stellar", args, {
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1024 * 1024,
    })
  }

  console.log("Deploying phase-protocol…")
  const deployOut = stellar([
    "contract",
    "deploy",
    "--wasm",
    wasm,
    "--network",
    "testnet",
    "--rpc-url",
    RPC,
    "--network-passphrase",
    NET,
  ])

  const contractId = parseContractId(deployOut) || parseContractId(deployOut + deployOut)
  if (!contractId) {
    console.error("Could not parse contract id from deploy output:\n", deployOut)
    process.exit(1)
  }
  console.log("Contract ID:", contractId)

  console.log("Invoking initialize…")
  const initOut = stellar([
    "contract",
    "invoke",
    "--id",
    contractId,
    "--network",
    "testnet",
    "--rpc-url",
    RPC,
    "--network-passphrase",
    NET,
    "--",
    "initialize",
    "--admin",
    admin,
    "--token_address",
    token,
    "--required_amount",
    required,
    "--protocol_treasury",
    treasury,
  ])
  if (initOut) console.log(initOut.slice(0, 800))

  const defPath = resolve(ROOT, "lib/phase-contract-defaults.ts")
  let def = readFileSync(defPath, "utf8")
  def = def.replace(/export const DEFAULT_PHASE_CONTRACT = "[^"]+"/, `export const DEFAULT_PHASE_CONTRACT = "${contractId}"`)
  writeFileSync(defPath, def)
  console.log("Updated lib/phase-contract-defaults.ts")

  const envPath = resolve(ROOT, ".env.local")
  let envText = readFileSync(envPath, "utf8")
  if (envText.includes("NEXT_PUBLIC_PHASE_PROTOCOL_ID=")) {
    envText = envText.replace(/NEXT_PUBLIC_PHASE_PROTOCOL_ID=.*/m, `NEXT_PUBLIC_PHASE_PROTOCOL_ID=${contractId}`)
  } else {
    envText += `\nNEXT_PUBLIC_PHASE_PROTOCOL_ID=${contractId}\n`
  }
  if (envText.includes("PHASE_PROTOCOL_ID=")) {
    envText = envText.replace(/^PHASE_PROTOCOL_ID=.*/m, `PHASE_PROTOCOL_ID=${contractId}`)
  } else {
    envText += `PHASE_PROTOCOL_ID=${contractId}\n`
  }
  writeFileSync(envPath, envText)
  console.log("Updated .env.local (PHASE protocol ids)")

  console.log("\nDone. NFTs on the previous contract stay there; this is a new deployment.")
}

main()
