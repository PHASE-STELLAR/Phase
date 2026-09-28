/**
 * Vincula el distribuidor al asset PHASELQ (changeTrust firmado por el distribuidor)
 * y envía PHASELQ desde el issuer al distribuidor (payment firmado por el issuer).
 *
 * Usa solo las mismas variables que el resto del proyecto (.env.local en la raíz):
 *   CLASSIC_LIQ_ISSUER_SECRET
 *   FAUCET_DISTRIBUTOR_SECRET_KEY
 *   NEXT_PUBLIC_CLASSIC_LIQ_ISSUER (debe coincidir con la G del secret del issuer)
 *   NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE (default PHASELQ)
 *
 * Opcional:
 *   DISTRIBUTOR_TRUST_PAY_AMOUNT — default 1000000.0000000 (7 decimales)
 *   HORIZON_TESTNET_URL
 *
 * Uso:
 *   npm run classic:distributor-trust-and-pay
 *   cd scripts && npm run distributor-trust-and-pay
 * 
 * Phase-134: Enhanced with balance monitoring and recommendations
 */
import * as dotenv from "dotenv"
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
dotenv.config({ path: path.join(repoRoot, ".env.local") })
dotenv.config({ path: path.join(repoRoot, ".env") })
dotenv.config({ path: path.join(__dirname, ".env") })

const HORIZON_URL = process.env.HORIZON_TESTNET_URL?.trim() || "https://horizon-testnet.stellar.org"
const DEFAULT_PAY_AMOUNT = "1000000.0000000"

type HorizonBalance = {
  asset_type?: string
  asset_code?: string
  asset_issuer?: string
}

function assetCodeFromEnv(): string {
  return (
    process.env.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE?.trim() ||
    process.env.CLASSIC_LIQ_ASSET_CODE?.trim() ||
    "PHASELQ"
  )
}

function issuerPublicFromEnv(): string | null {
  const g = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER?.trim() ?? ""
  if (g && StrKey.isValidEd25519PublicKey(g)) return g
  return null
}

async function distributorHasTrustline(distributor: string, asset: Asset): Promise<boolean> {
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(distributor)}`, {
    headers: { Accept: "application/json" },
  })
  if (res.status === 404) return false
  if (!res.ok) {
    throw new Error(`Horizon accounts/${distributor}: HTTP ${res.status}`)
  }
  const data = (await res.json()) as { balances?: HorizonBalance[] }
  const balances = Array.isArray(data.balances) ? data.balances : []
  const code = asset.getCode()
  const issuer = asset.getIssuer()
  return balances.some(
    (b) => b.asset_type !== "native" && b.asset_code === code && b.asset_issuer === issuer,
  )
}

async function main() {
  const issuerSecret = process.env.CLASSIC_LIQ_ISSUER_SECRET?.trim()
  const distributorSecret = process.env.FAUCET_DISTRIBUTOR_SECRET_KEY?.trim()

  if (!issuerSecret || issuerSecret.length < 20) {
    console.error("Falta CLASSIC_LIQ_ISSUER_SECRET en .env.local (raíz del repo).")
    process.exit(1)
  }
  if (!distributorSecret || distributorSecret.length < 20) {
    console.error("Falta FAUCET_DISTRIBUTOR_SECRET_KEY en .env.local (raíz del repo).")
    process.exit(1)
  }

  let issuerKp: Keypair
  let distributorKp: Keypair
  try {
    issuerKp = Keypair.fromSecret(issuerSecret)
  } catch {
    console.error("CLASSIC_LIQ_ISSUER_SECRET no es un secret Stellar válido.")
    process.exit(1)
  }
  try {
    distributorKp = Keypair.fromSecret(distributorSecret)
  } catch {
    console.error("FAUCET_DISTRIBUTOR_SECRET_KEY no es un secret Stellar válido.")
    process.exit(1)
  }

  const issuerConfigured = issuerPublicFromEnv()
  const issuerPub = issuerKp.publicKey()
  if (!issuerConfigured) {
    console.error(
      "Define NEXT_PUBLIC_CLASSIC_LIQ_ISSUER (G… del emisor) y alinéalo con CLASSIC_LIQ_ISSUER_SECRET.",
    )
    process.exit(1)
  }
  if (issuerPub !== issuerConfigured) {
    console.error(
      `El secret del issuer corresponde a ${issuerPub}, pero NEXT_PUBLIC_CLASSIC_LIQ_ISSUER es ${issuerConfigured}. Corrige .env.local.`,
    )
    process.exit(1)
  }

  const distPub = distributorKp.publicKey()
  if (distPub === issuerPub) {
    console.error("El distribuidor no puede ser la misma cuenta que el issuer.")
    process.exit(1)
  }

  const code = assetCodeFromEnv()
  const asset = new Asset(code, issuerPub)
  const amount = process.env.DISTRIBUTOR_TRUST_PAY_AMOUNT?.trim() || DEFAULT_PAY_AMOUNT

  console.log(`Asset: ${code}:${issuerPub.slice(0, 8)}…`)
  console.log(`Distribuidor: ${distPub}`)
  console.log(`Cantidad payment: ${amount} ${code}\n`)

  const server = new Horizon.Server(HORIZON_URL)
  const base = HORIZON_URL.replace(/\/$/, "")

  const hasLine = await distributorHasTrustline(distPub, asset)
  if (hasLine) {
    console.log("Trustline ya activa en el distribuidor; se omite changeTrust.\n")
  } else {
    console.log("Enviando changeTrust (firma: distribuidor)…")
    let accountDist: Horizon.AccountResponse
    try {
      accountDist = await server.loadAccount(distPub)
    } catch {
      console.error(
        `No se pudo cargar la cuenta del distribuidor. Fóndala con XLM en testnet (Friendbot) e intenta de nuevo.`,
      )
      process.exit(1)
    }
    const txTrust = new TransactionBuilder(accountDist, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(180)
      .build()
    txTrust.sign(distributorKp)
    const trustRes = await server.submitTransaction(txTrust)
    console.log(`  OK — changeTrust. Hash: ${trustRes.hash}`)
    console.log(`  ${base}/transactions/${trustRes.hash}\n`)
  }

  console.log("Enviando payment issuer → distribuidor (firma: issuer)…")
  const accountIssuer = await server.loadAccount(issuerPub)
  const txPay = new TransactionBuilder(accountIssuer, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: distPub,
        asset,
        amount,
      }),
    )
    .setTimeout(180)
    .build()
  txPay.sign(issuerKp)
  const payRes = await server.submitTransaction(txPay)
  console.log(`  OK — payment. Hash: ${payRes.hash}`)
  console.log(`  ${base}/transactions/${payRes.hash}`)
  console.log(`  ${base}/accounts/${distPub}`)
  
  // Phase-134: Show post-payment balances and recommendations
  console.log("\n=== Post-Payment Status ===")
  try {
    const distAccount = await server.loadAccount(distPub)
    const phaseLiqBalance = distAccount.balances.find(
      (b: any) => b.asset_code === code && b.asset_issuer === issuerPub
    )
    const xlmBalance = distAccount.balances.find((b: any) => b.asset_type === "native")
    
    if (phaseLiqBalance) {
      console.log(`Distributor PHASELQ: ${phaseLiqBalance.balance} ${code}`)
    }
    if (xlmBalance) {
      console.log(`Distributor XLM: ${xlmBalance.balance} XLM`)
      const xlm = parseFloat(xlmBalance.balance)
      if (xlm < 50) {
        console.log(`\n⚠️  WARNING: Distributor XLM is low (${xlm.toFixed(2)} XLM)`)
        console.log(`   Recommended: Fund with at least 50 XLM for reliable operations`)
        console.log(`   Friendbot: https://friendbot.stellar.org/?addr=${distPub}`)
      }
    }
    
    console.log("\n💡 Next Steps:")
    console.log("   1. Configure FAUCET_DISTRIBUTOR_SECRET_KEY in production")
    console.log("   2. Set up cron job: /api/cron/faucet-health (hourly)")
    console.log("   3. Configure webhooks for alerts (optional):")
    console.log("      - DISCORD_WEBHOOK_URL")
    console.log("      - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID")
    console.log("      - SLACK_WEBHOOK_URL")
    console.log("   4. Monitor health: GET /api/faucet/health")
  } catch (e) {
    console.log("   (Could not fetch post-payment balances)")
  }
}

main().catch((e) => {
  const extras = e?.response?.data?.extras
  if (extras) console.error(JSON.stringify(extras, null, 2))
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
