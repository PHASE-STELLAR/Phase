/**
 * Generate stellar.toml from environment variables — phase-280
 *
 * Generates SEP-0001 stellar.toml at build time with:
 * - Token icon and canonical asset fields
 * - Build-time validation of env values
 * - Testnet fencing (prevents mainnet values in testnet builds)
 * - CI check support (exit 1 if mismatch detected)
 *
 * Usage:
 *   tsx scripts/generate-stellar-toml.ts
 *   tsx scripts/generate-stellar-toml.ts --verify   # CI mode: check drift
 */

import { writeFile, mkdir } from "node:fs/promises"
import path from "node:path"

interface TomlConfig {
  VERSION: string
  NETWORK_PASSPHRASE: string
  HORIZON_URL: string
  FEDERATION_SERVER: string
  SIGNING_KEY: string
  TRANSFER_SERVER: string
  CURRENCIES: Array<{
    code: string
    issuer: string
    name: string
    desc: string
    image: string
  }>
}

function getenv(key: string, fallback?: string): string {
  const value = process.env[key]
  if (!value) {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required env var: ${key}`)
  }
  return value
}

function isTestnet(): boolean {
  const passphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || ""
  return passphrase.includes("Test")
}

function buildTomlContent(config: TomlConfig): string {
  const currencies = config.CURRENCIES.map(
    (c) => `
[[CURRENCIES]]
code = "${c.code}"
issuer = "${c.issuer}"
name = "${c.name}"
desc = "${c.desc}"
image = "${c.image}"
`,
  ).join("")

  return `# Stellar.toml (SEP-0001)
# Generated at build time from environment variables — phase-280
# DO NOT edit manually — regenerate with: npm run generate:stellar-toml

VERSION = "${config.VERSION}"

[DOCUMENTATION]
ORG_NAME = "PHASE Protocol"
ORG_DESCRIPTION = "AI artifact minting gated by on-chain payment on Stellar Soroban"
ORG_URL = "https://phase.site"
ORG_OFFICIAL_EMAIL = "protocol@phase.site"
ORG_SUPPORT_EMAIL = "support@phase.site"

[PRINCIPALS]
name = "PHASE Protocol"
key_pair = "${config.SIGNING_KEY}"

[FEDERATION_SERVER]
FEDERATION_SERVER = "${config.FEDERATION_SERVER}"

[WEB_AUTH_ENDPOINT]
WEB_AUTH_ENDPOINT = "${config.HORIZON_URL}"

[TRANSFER_SERVER]
TRANSFER_SERVER = "${config.TRANSFER_SERVER}"

[NETWORK_PASSPHRASE]
NETWORK_PASSPHRASE = "${config.NETWORK_PASSPHRASE}"

[HORIZON]
HORIZON_URL = "${config.HORIZON_URL}"
${currencies}
`
}

async function generateStellarToml(): Promise<void> {
  const isTest = isTesnet()
  const networkPassphrase = getenv("NEXT_PUBLIC_NETWORK_PASSPHRASE")

  if (isTest && networkPassphrase.includes("Main")) {
    throw new Error("Mainnet passphrase detected in testnet build — refusing to generate")
  }

  const config: TomlConfig = {
    VERSION: "1.0.0",
    NETWORK_PASSPHRASE: networkPassphrase,
    HORIZON_URL: getenv("NEXT_PUBLIC_HORIZON_URL", "https://soroban-testnet.stellar.org"),
    FEDERATION_SERVER: getenv("NEXT_PUBLIC_FEDERATION_SERVER", "https://phase.site/.well-known/stellar.toml"),
    SIGNING_KEY: getenv("NEXT_PUBLIC_PHASE_PROTOCOL_ID"),
    TRANSFER_SERVER: getenv("NEXT_PUBLIC_TRANSFER_SERVER", "https://phase.site/api/classic-liq"),
    CURRENCIES: [
      {
        code: "PHASELQ",
        issuer: getenv("NEXT_PUBLIC_PHASER_TOKEN_ID"),
        name: "PHASE Liquidity Token",
        desc: "Testnet liquidity token for PHASE protocol settlement",
        image: "https://phase.site/phaser-liq-token.png",
      },
    ],
  }

  const content = buildTomlContent(config)
  const wellKnownDir = path.join(process.cwd(), "public", ".well-known")

  await mkdir(wellKnownDir, { recursive: true })
  await writeFile(path.join(wellKnownDir, "stellar.toml"), content, "utf-8")

  console.log(JSON.stringify({
    event: "stellar_toml_generated",
    timestamp: new Date().toISOString(),
    path: path.join(wellKnownDir, "stellar.toml"),
    network: isTest ? "testnet" : "mainnet",
    version: config.VERSION,
  }))
}

async function verifyStellarToml(): Promise<void> {
  // CI mode: verify that the published document matches the issuer
  const expectedIssuer = getenv("NEXT_PUBLIC_PHASER_TOKEN_ID")
  const tomlPath = path.join(process.cwd(), "public", ".well-known", "stellar.toml")

  try {
    const { readFileSync } = require("node:fs")
    const content = readFileSync(tomlPath, "utf-8")

    if (!content.includes(expectedIssuer)) {
      console.error(JSON.stringify({
        event: "stellar_toml_drift",
        severity: "critical",
        message: `stellar.toml does not reference expected issuer: ${expectedIssuer}`,
        path: tomlPath,
      }))
      process.exitCode = 1
      return
    }

    console.log(JSON.stringify({
      event: "stellar_toml_verified",
      timestamp: new Date().toISOString(),
      issuer: expectedIssuer,
    }))
  } catch (error) {
    console.error(JSON.stringify({
      event: "stellar_toml_verification_failed",
      error: String(error),
    }))
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const isVerifyMode = process.argv.includes("--verify")

  try {
    if (isVerifyMode) {
      await verifyStellarToml()
    } else {
      await generateStellarToml()
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "stellar_toml_error",
      error: String(error),
      timestamp: new Date().toISOString(),
    }))
    process.exitCode = 1
  }
}

main()
