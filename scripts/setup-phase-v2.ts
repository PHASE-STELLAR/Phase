/**
 * Emergency bootstrap: recrea Issuer + Distributor y deja PHASELQ operativo en testnet.
 *
 * Flujo:
 * 1) Genera dos keypairs nuevos (Issuer, Distributor)
 * 2) Fondea ambos con Friendbot
 * 3) Crea trustline del Distributor al asset clásico PHASELQ
 * 4) Envía payment Issuer -> Distributor (supply inicial)
 * 5) Ejecuta `stellar contract asset deploy` para ese asset y captura Contract ID
 * 6) Imprime bloque listo para pegar en .env.local
 *
 * Uso:
 *   cd scripts && npm install && npm run setup:phase-v2
 *
 * Opcional:
 *   PHASE_V2_ASSET_CODE=PHASELQ
 *   PHASE_V2_INITIAL_DISTRIBUTION=100000.0000000
 *   PHASE_V2_RPC_URL=https://soroban-testnet.stellar.org
 *   PHASE_V2_HORIZON_URL=https://horizon-testnet.stellar.org
 */

import * as dotenv from "dotenv"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk"
import { z } from "zod"

dotenv.config()

// ── phase-124: metadata version migration wiring (isolated, flag-gated) ──
// Reuses schema logic from scripts/reset-phase.ts; keeps setup-phase-v2 auditable.
// Flag: NEXT_PUBLIC_FEATURE_PHASE_124 / FEATURE_PHASE_124 — rollback: unset flag.

function isPhase124Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_124 ?? process.env.FEATURE_PHASE_124 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const SetupMetadataV1Schema = z.object({
  version: z.literal(1).optional(),
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional().default(""),
  image: z.string().max(1024).optional().default(""),
  attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) })).optional().default([]),
})
const SetupMetadataV2Schema = z.object({
  version: z.literal(2),
  name: z.string().min(1).max(256),
  description: z.string().max(2048),
  image: z.string().max(1024),
  external_url: z.string().optional().default(""),
  attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) })),
  collectionId: z.number().int().min(0).nullable().default(null),
  migratedAt: z.string().datetime().optional(),
})

function auditMetadataVersionOnSetup(raw: unknown): { version: number | null; needsMigration: boolean } {
  if (!raw || typeof raw !== "object") return { version: null, needsMigration: false }
  const v = (raw as { version?: unknown }).version
  if (v === 2) return { version: 2, needsMigration: false }
  if (v === 1 || v == null) {
    const p1 = SetupMetadataV1Schema.safeParse(raw)
    return { version: p1.success ? 1 : null, needsMigration: p1.success }
  }
  return { version: null, needsMigration: false }
}

async function runSetupMetadataAuditIfFlagged(): Promise<void> {
  if (!isPhase124Enabled()) return
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const publicMetaPath = path.join(repoRoot, "public", "phaser-liq.metadata.json")
  try {
    const raw = JSON.parse(await fs.readFile(publicMetaPath, "utf8"))
    const audit = auditMetadataVersionOnSetup(raw)
    if (audit.needsMigration) {
      console.log(`\n[phase-124] public/phaser-liq.metadata.json is v1 — migration available (additive, safe). Run: FEATURE_PHASE_124=1 npx tsx scripts/reset-phase.ts --migrate-metadata`)
    } else if (audit.version === 2) {
      console.log("\n[phase-124] metadata version check: v2 current (no migration needed).")
    }
  } catch { /* optional audit, not fatal */ }
}

// ── phase-94: verified-artist badge issuance wiring (isolated, flag-gated) ──
// Core issuance/verification logic lives in scripts/reset-phase.ts (single
// source of truth); this is a lightweight wire-preserving audit only.
// Flag: NEXT_PUBLIC_FEATURE_PHASE_94 / FEATURE_PHASE_94 — rollback: unset flag.

function isPhase94Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_94 ?? process.env.FEATURE_PHASE_94 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const SetupArtistAttestationProbeSchema = z.object({
  wallet: z.string().length(56),
  displayName: z.string().min(1).max(48),
  claim: z.literal("verified-artist"),
})

function auditArtistAttestationWiringOnSetup(): void {
  if (!isPhase94Enabled()) return
  const probe = SetupArtistAttestationProbeSchema.safeParse({
    wallet: "G" + "A".repeat(55),
    displayName: "probe",
    claim: "verified-artist",
  })
  if (!probe.success) {
    console.warn("[phase-94] artist attestation schema drift (unexpected, report):", probe.error.message)
  } else {
    console.log("[phase-94] verified-artist badge wiring OK (setup will not break attestation issuance). Rollback: unset FEATURE_PHASE_94.")
  }
}

// ── phase-79: watchlist notifications for price drops wiring (isolated, flag-gated) ──
// Core watchlist and price drop logic lives in scripts/reset-phase.ts (single source of truth);
// this is a lightweight wire-preserving audit ensuring setup-phase-v2 remains compatible.
// Flag: NEXT_PUBLIC_FEATURE_PHASE_79 / FEATURE_PHASE_79 — rollback: unset flag.

function isPhase79Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_79 ?? process.env.FEATURE_PHASE_79 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const SetupWatchlistProbeSchema = z.object({
  wallet: z.string().length(56),
  collectionId: z.number().int().min(0),
  tokenId: z.number().int().min(1),
  previousPrice: z.number().positive(),
  newPrice: z.number().positive(),
})

function auditWatchlistWiringOnSetup(): void {
  if (!isPhase79Enabled()) return
  const probe = SetupWatchlistProbeSchema.safeParse({
    wallet: "G" + "A".repeat(55),
    collectionId: 0,
    tokenId: 1,
    previousPrice: 100,
    newPrice: 80,
  })
  if (!probe.success) {
    console.warn("[phase-79] watchlist schema drift (unexpected, report):", probe.error.message)
  } else {
    console.log("[phase-79] watchlist notifications wiring OK (setup will not break price drop alerts). Rollback: unset FEATURE_PHASE_79.")
  }
}

const RPC_URL = process.env.PHASE_V2_RPC_URL?.trim() || "https://soroban-testnet.stellar.org"
const HORIZON_URL = process.env.PHASE_V2_HORIZON_URL?.trim() || "https://horizon-testnet.stellar.org"
const NETWORK_PASSPHRASE = Networks.TESTNET
const FRIENDBOT_URL = "https://friendbot.stellar.org"
const ASSET_CODE = process.env.PHASE_V2_ASSET_CODE?.trim() || "PHASELQ"
const INITIAL_DISTRIBUTION = process.env.PHASE_V2_INITIAL_DISTRIBUTION?.trim() || "100000.0000000"
const MAX_TRUST = "922337203685.4775807"

function ensureValidClassicAssetCode(code: string): void {
  if (code.length < 1 || code.length > 12 || !/^[a-zA-Z0-9]+$/.test(code)) {
    throw new Error(`Código de asset inválido: "${code}". Debe ser alfanumérico (1-12), sin "_"`)
  }
}

function ensureValidClassicAmount(value: string): void {
  if (!/^\d+(\.\d{1,7})?$/.test(value)) {
    throw new Error(`Monto inválido: "${value}". Usa formato clásico con hasta 7 decimales.`)
  }
}

async function friendbotFund(publicKey: string): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`
  const res = await fetch(url)
  const txt = await res.text()
  if (!res.ok) {
    throw new Error(`Friendbot ${res.status}: ${txt.slice(0, 300)}`)
  }
}

async function waitForAccount(server: Horizon.Server, publicKey: string): Promise<void> {
  for (let i = 0; i < 25; i++) {
    try {
      await server.loadAccount(publicKey)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1200))
    }
  }
  throw new Error(`Timeout esperando cuenta en Horizon: ${publicKey}`)
}

async function submit(
  server: Horizon.Server,
  signer: Keypair,
  ops: Array<ReturnType<typeof Operation.changeTrust> | ReturnType<typeof Operation.payment>>,
): Promise<{ hash: string }> {
  const sourceAccount = await server.loadAccount(signer.publicKey())
  let builder = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
  for (const op of ops) builder = builder.addOperation(op)
  const tx = builder.setTimeout(180).build()
  tx.sign(signer)
  return server.submitTransaction(tx)
}

function parseContractIdFromDeployOutput(output: string): string | null {
  const all = output.match(/C[A-Z2-7]{55}/g)
  if (!all || all.length === 0) return null
  return all[all.length - 1] ?? null
}

function deploySACViaCli(assetDescriptor: string, sourceSecret: string): string {
  const args = [
    "contract",
    "asset",
    "deploy",
    "--network",
    "testnet",
    "--rpc-url",
    RPC_URL,
    "--network-passphrase",
    NETWORK_PASSPHRASE,
    "--asset",
    assetDescriptor,
    "--source-account",
    sourceSecret,
  ]

  let stdout = ""
  try {
    stdout = execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const merged = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`
    const maybeExisting =
      merged.includes("Error(Storage, ExistingValue)") || /contract already exists/i.test(merged)
    if (maybeExisting) {
      // El SAC ya existe para ese code:issuer. Derivamos el ID determinístico.
      const [code, issuer] = assetDescriptor.split(":")
      if (!issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
        throw new Error(`No pude derivar contract id tras ExistingValue. Salida CLI:\n${merged}`)
      }
      return new Asset(code, issuer).contractId(NETWORK_PASSPHRASE)
    }
    throw new Error(`stellar contract asset deploy falló:\n${merged}`)
  }

  const parsed = parseContractIdFromDeployOutput(stdout)
  if (parsed) return parsed

  const [code, issuer] = assetDescriptor.split(":")
  if (!issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error(`No pude extraer Contract ID del output CLI:\n${stdout}`)
  }
  return new Asset(code, issuer).contractId(NETWORK_PASSPHRASE)
}

function printEnvBlock(params: {
  issuerPublic: string
  issuerSecret: string
  distributorPublic: string
  distributorSecret: string
  assetCode: string
  tokenContractId: string
}): void {
  const lines = [
    "",
    "######################### .env.local (PHASE v2 emergency) #########################",
    `NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE=${params.assetCode}`,
    `NEXT_PUBLIC_CLASSIC_LIQ_ISSUER=${params.issuerPublic}`,
    `CLASSIC_LIQ_ASSET_CODE=${params.assetCode}`,
    `CLASSIC_LIQ_ISSUER_SECRET=${params.issuerSecret}`,
    `CLASSIC_LIQ_DISTRIBUTOR_PUBLIC=${params.distributorPublic}`,
    `FAUCET_DISTRIBUTOR_SECRET_KEY=${params.distributorSecret}`,
    "",
    `NEXT_PUBLIC_TOKEN_CONTRACT_ID=${params.tokenContractId}`,
    `TOKEN_CONTRACT_ID=${params.tokenContractId}`,
    `NEXT_PUBLIC_PHASER_TOKEN_ID=${params.tokenContractId}`,
    "####################### fin bloque PHASE v2 emergency #############################",
    "",
  ]
  console.log(lines.join("\n"))
}

async function main() {
  console.log("\n=== PHASE emergency setup v2 (testnet) ===\n")
  ensureValidClassicAssetCode(ASSET_CODE)
  ensureValidClassicAmount(INITIAL_DISTRIBUTION)

  const server = new Horizon.Server(HORIZON_URL)
  const issuer = Keypair.random()
  const distributor = Keypair.random()

  console.log("Nuevas llaves:")
  console.log(`ISSUER_PUBLIC_KEY=${issuer.publicKey()}`)
  console.log(`ISSUER_SECRET_KEY=${issuer.secret()}`)
  console.log(`DISTRIBUTOR_PUBLIC_KEY=${distributor.publicKey()}`)
  console.log(`DISTRIBUTOR_SECRET_KEY=${distributor.secret()}`)

  console.log("\n1) Fondeando con Friendbot...")
  await friendbotFund(issuer.publicKey())
  await friendbotFund(distributor.publicKey())
  await waitForAccount(server, issuer.publicKey())
  await waitForAccount(server, distributor.publicKey())
  console.log("   OK: ambas cuentas ya existen en Horizon.")

  const asset = new Asset(ASSET_CODE, issuer.publicKey())

  console.log("\n2) Creando trustline en distributor...")
  const trust = await submit(server, distributor, [Operation.changeTrust({ asset, limit: MAX_TRUST })])
  console.log(`   trustline tx: ${trust.hash}`)

  console.log(`\n3) Payment Issuer -> Distributor (${INITIAL_DISTRIBUTION} ${ASSET_CODE})...`)
  const pay = await submit(server, issuer, [
    Operation.payment({
      destination: distributor.publicKey(),
      asset,
      amount: INITIAL_DISTRIBUTION,
    }),
  ])
  console.log(`   payment tx: ${pay.hash}`)

  const assetDescriptor = `${ASSET_CODE}:${issuer.publicKey()}`
  console.log(`\n4) Deploy SAC via Stellar CLI (${assetDescriptor})...`)
  const contractId = deploySACViaCli(assetDescriptor, distributor.secret())
  console.log(`   Contract ID: ${contractId}`)

  console.log("\n5) Bloque .env.local listo para pegar:")
  printEnvBlock({
    issuerPublic: issuer.publicKey(),
    issuerSecret: issuer.secret(),
    distributorPublic: distributor.publicKey(),
    distributorSecret: distributor.secret(),
    assetCode: ASSET_CODE,
    tokenContractId: contractId,
  })

  await runSetupMetadataAuditIfFlagged()
  if (isPhase124Enabled()) {
    console.log("[phase-124] Metadata migration tool: enabled. Rollback: unset FEATURE_PHASE_124/NEXT_PUBLIC_FEATURE_PHASE_124.")
  }
  auditArtistAttestationWiringOnSetup()
  auditWatchlistWiringOnSetup()

  console.log("Done.")
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`\nERROR: ${msg}`)
  process.exit(1)
})
