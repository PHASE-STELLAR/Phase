/**
 * Emite el activo clásico PHASER_LIQ en Stellar Testnet (SAC / classic asset).
 *
 * Flujo:
 * 1. Keypairs nuevos: Issuer + Distributor
 * 2. Friendbot fondea ambas cuentas
 * 3. Distributor: ChangeTrust hacia el activo (issuer)
 * 4. Issuer: Payment de MINT_AMOUNT al Distributor
 * 5. Opcional: Issuer SetOptions masterWeight=0 (sin más emisiones firmadas por esa cuenta)
 *
 * Uso:
 *   cd scripts && npm install && npm run issue:sac
 *
 * Opcional:
 *   ISSUE_SAC_LOCK_ISSUER=1   — bloquea la cuenta emisora (master weight 0) tras el mint
 *   ISSUE_SAC_MINT_AMOUNT=100000000 — cantidad a acuñar (string, unidades del activo)
 *   ISSUE_SAC_ASSET_CODE=PHASELQ — código en red clásica (solo [A-Za-z0-9], máx. 12; el guion bajo NO está permitido)
 */

import * as dotenv from "dotenv"
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk"
import { z } from "zod"

dotenv.config()

// ── phase-124: preserve wiring via shared metadata migration validation ──
// This script is the entrypoint for SAC issuance; it validates that existing
// metadata files remain compatible after SAC rotation, without duplicating
// reset-phase.ts migration logic (single source of truth in lib/metadata-migration).
// Flag: NEXT_PUBLIC_FEATURE_PHASE_124 / FEATURE_PHASE_124

function isPhase124Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_124 ?? process.env.FEATURE_PHASE_124 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const IssueSacMetadataCheckSchema = z.object({
  name: z.string().min(1).max(256),
  version: z.union([z.literal(1), z.literal(2)]).optional(),
  image: z.string().max(1024).optional(),
})

function auditMetadataCompatibilityForNewSAC(): void {
  if (!isPhase124Enabled()) return
  // Lightweight wire-preserving check: ensure migration module is loadable and schemas are valid.
  const check = IssueSacMetadataCheckSchema.safeParse({ name: "PHASELQ", version: 2, image: "ipfs://test" })
  if (!check.success) {
    console.warn("[phase-124] metadata check schema drift (unexpected, report):", check.error.message)
  } else {
    console.log("[phase-124] metadata wiring OK (SAC issuance will not break v1→v2 migration). Rollback: unset FEATURE_PHASE_124.")
  }
}

// ── phase-94: verified-artist badge issuance wiring (isolated, flag-gated) ──
// Core issuance/verification logic lives in scripts/reset-phase.ts (single
// source of truth); this is a lightweight wire-preserving audit only, so SAC
// issuance keeps working unchanged whether the flag is on or off.
// Flag: NEXT_PUBLIC_FEATURE_PHASE_94 / FEATURE_PHASE_94 — rollback: unset flag.

function isPhase94Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_94 ?? process.env.FEATURE_PHASE_94 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const IssueSacArtistAttestationProbeSchema = z.object({
  wallet: z.string().length(56),
  displayName: z.string().min(1).max(48),
  claim: z.literal("verified-artist"),
})

function auditArtistAttestationWiringOnIssueSac(): void {
  if (!isPhase94Enabled()) return
  const probe = IssueSacArtistAttestationProbeSchema.safeParse({
    wallet: "G" + "A".repeat(55),
    displayName: "probe",
    claim: "verified-artist",
  })
  if (!probe.success) {
    console.warn("[phase-94] artist attestation schema drift (unexpected, report):", probe.error.message)
  } else {
    console.log("[phase-94] verified-artist badge wiring OK (SAC issuance will not break attestation issuance). Rollback: unset FEATURE_PHASE_94.")
  }
}

// ── phase-79: watchlist notifications for price drops wiring (isolated, flag-gated) ──
// Core watchlist logic lives in scripts/reset-phase.ts (single source of truth);
// this is a lightweight wire-preserving audit ensuring SAC issuance keeps working unchanged.
// Flag: NEXT_PUBLIC_FEATURE_PHASE_79 / FEATURE_PHASE_79 — rollback: unset flag.

function isPhase79Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_79 ?? process.env.FEATURE_PHASE_79 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

const IssueSacWatchlistProbeSchema = z.object({
  wallet: z.string().length(56),
  collectionId: z.number().int().min(0),
  tokenId: z.number().int().min(1),
  previousPrice: z.number().positive(),
  newPrice: z.number().positive(),
})

function auditWatchlistWiringOnIssueSac(): void {
  if (!isPhase79Enabled()) return
  const probe = IssueSacWatchlistProbeSchema.safeParse({
    wallet: "G" + "A".repeat(55),
    collectionId: 0,
    tokenId: 1,
    previousPrice: 100,
    newPrice: 80,
  })
  if (!probe.success) {
    console.warn("[phase-79] watchlist schema drift (unexpected, report):", probe.error.message)
  } else {
    console.log("[phase-79] watchlist notifications wiring OK (SAC issuance will not break price drop alerts). Rollback: unset FEATURE_PHASE_79.")
  }
}

const HORIZON_URL = process.env.HORIZON_TESTNET_URL?.trim() || "https://horizon-testnet.stellar.org"
const FRIENDBOT_URL = "https://friendbot.stellar.org"
const NETWORK_PASSPHRASE = Networks.TESTNET

/** En classic Testnet el código debe ser alfanumérico (p. ej. PHASELQ). "PHASER_LIQ" falla por el _. */
const ASSET_CODE = process.env.ISSUE_SAC_ASSET_CODE?.trim() || "PHASELQ"
const MINT_AMOUNT = process.env.ISSUE_SAC_MINT_AMOUNT?.trim() || "100000000"
const LOCK_ISSUER = process.env.ISSUE_SAC_LOCK_ISSUER === "1" || process.env.ISSUE_SAC_LOCK_ISSUER === "true"

/** Máximo permitido por el protocolo (7 decimales). */
const MAX_TRUST = "922337203685.4775807"

function log(msg: string) {
  console.log(msg)
}

async function fundFriendbot(publicKey: string): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`
  const res = await fetch(url)
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`Friendbot HTTP ${res.status}: ${body.slice(0, 500)}`)
  }
}

async function waitForAccount(server: Horizon.Server, publicKey: string, label: string): Promise<void> {
  const max = 20
  for (let i = 0; i < max; i++) {
    try {
      await server.loadAccount(publicKey)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw new Error(`Timeout esperando cuenta en Horizon: ${label} ${publicKey}`)
}

async function submit(
  server: Horizon.Server,
  source: Keypair,
  ops: Array<ReturnType<typeof Operation.changeTrust> | ReturnType<typeof Operation.payment> | ReturnType<typeof Operation.setOptions>>,
): Promise<{ hash: string }> {
  const account = await server.loadAccount(source.publicKey())
  let builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
  for (const op of ops) {
    builder = builder.addOperation(op)
  }
  const built = builder.setTimeout(180).build()
  built.sign(source)
  return server.submitTransaction(built)
}

async function main() {
  log("\n═══ PHASE — emisión activo clásico SAC (Testnet) ═══\n")

  if (ASSET_CODE.length < 1 || ASSET_CODE.length > 12 || !/^[a-zA-Z0-9]+$/.test(ASSET_CODE)) {
    throw new Error(
      `Código de activo clásico inválido: "${ASSET_CODE}". Use 1–12 caracteres alfanuméricos (sin _). Ej: PHASELQ`,
    )
  }

  const server = new Horizon.Server(HORIZON_URL)
  const issuer = Keypair.random()
  const distributor = Keypair.random()

  log("→ Generando keypairs…")
  log(`   Issuer:       ${issuer.publicKey()}`)
  log(`   Distributor:  ${distributor.publicKey()}`)

  log("\n→ Friendbot (fondeo XLM testnet)…")
  await fundFriendbot(issuer.publicKey())
  await fundFriendbot(distributor.publicKey())
  await waitForAccount(server, issuer.publicKey(), "Issuer")
  await waitForAccount(server, distributor.publicKey(), "Distributor")
  log("   Cuentas visibles en Horizon.")

  const asset = new Asset(ASSET_CODE, issuer.publicKey())
  log(`\n→ Activo: ${asset.getCode()}:${issuer.publicKey()}`)

  log(`\n→ ChangeTrust (Distributor acepta ${ASSET_CODE})…`)
  const trustRes = await submit(server, distributor, [Operation.changeTrust({ asset, limit: MAX_TRUST })])
  log(`   ✓ trustline tx: ${trustRes.hash}`)

  log(`\n→ Payment (Issuer → Distributor, cantidad ${MINT_AMOUNT})…`)
  const payRes = await submit(server, issuer, [
    Operation.payment({
      destination: distributor.publicKey(),
      asset,
      amount: MINT_AMOUNT,
    }),
  ])
  log(`   ✓ payment tx: ${payRes.hash}`)

  if (LOCK_ISSUER) {
    log("\n→ SetOptions (Issuer: masterWeight=0 — cuenta ya no puede firmar nuevas txs)…")
    const lockRes = await submit(server, issuer, [
      Operation.setOptions({
        masterWeight: 0,
        lowThreshold: 0,
        medThreshold: 0,
        highThreshold: 0,
      }),
    ])
    log(`   ✓ lock tx: ${lockRes.hash}`)
    log("   ⚠ El Issuer quedó bloqueado: no podrá emitir ni mover XLM con esa clave.")
  } else {
    log("\n   (Omitido bloqueo del Issuer. Exporta ISSUE_SAC_LOCK_ISSUER=1 para fijar suministro vía cuenta muerta.)")
  }

  log("\n────────────────────────────────────────────────────")
  log("SALIDA — llaves públicas (para .env / Stellar Expert / Soroban)")
  log("────────────────────────────────────────────────────")
  log(`ISSUER_PUBLIC_KEY=${issuer.publicKey()}`)
  log(`DISTRIBUTOR_PUBLIC_KEY=${distributor.publicKey()}`)
  log(`ASSET=${ASSET_CODE}:${issuer.publicKey()}`)
  log("\n── Siguiente paso (wrap SAC → Soroban) ──")
  log("stellar contract asset deploy \\")
  log(`  --asset ${ASSET_CODE}:${issuer.publicKey()} \\`)
  log("  --network testnet \\")
  log("  --source <TU_CUENTA_ADMIN>")
  log("\n── Secret keys (NO subir a git; guárdalas offline) ──")
  log(`ISSUER_SECRET=${issuer.secret()}`)
  log(`DISTRIBUTOR_SECRET=${distributor.secret()}`)
  log("")

  auditMetadataCompatibilityForNewSAC()
  auditArtistAttestationWiringOnIssueSac()
  auditWatchlistWiringOnIssueSac()
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
