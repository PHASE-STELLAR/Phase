/**
 * Pago clásico testnet: Issuer → Distribuidor (PHASELQ u otro código configurado).
 * El distribuidor debe tener trustline al asset antes de ejecutar.
 *
 * Uso (desde la raíz del repo):
 *   cd scripts && npm install && npm run issuer-to-distributor
 *
 * O desde la raíz:
 *   npm run classic:issuer-to-distributor
 *
 * Variables (.env.local en la raíz):
 *   CLASSIC_LIQ_ISSUER_SECRET     — obligatorio; secret del emisor (firma el payment).
 *   CLASSIC_LIQ_DISTRIBUTOR_PUBLIC — G… del distribuidor (opcional si abajo hay secret).
 *   FAUCET_DISTRIBUTOR_PUBLIC_KEY — mismo uso, alias opcional.
 *   FAUCET_DISTRIBUTOR_SECRET_KEY — si no hay PUBLIC, se usa la G derivada de este secret.
 *   NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE / NEXT_PUBLIC_CLASSIC_LIQ_ISSUER — asset (defaults PHASELQ + GAX… del proyecto).
 *   CLASSIC_LIQ_ISSUER_PAYMENT_AMOUNT — opcional; default 100000.0000000 (7 decimales).
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
const DEFAULT_ISSUER = "GAXRPE5JXPY7RJONMCEWFXELVWDW3CSA7H6LAGYKTOYLFQQDJ5DT4GNS"
const DEFAULT_AMOUNT = "100000.0000000"

function assetIssuerFromEnv(): string {
  const g = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER?.trim() ?? ""
  if (g && StrKey.isValidEd25519PublicKey(g)) return g
  return DEFAULT_ISSUER
}

function assetCodeFromEnv(): string {
  return process.env.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE?.trim() || "PHASELQ"
}

function resolveDistributorPublic(): string | null {
  const pub =
    process.env.CLASSIC_LIQ_DISTRIBUTOR_PUBLIC?.trim() ||
    process.env.FAUCET_DISTRIBUTOR_PUBLIC_KEY?.trim()
  if (pub && StrKey.isValidEd25519PublicKey(pub)) return pub
  const distSecret = process.env.FAUCET_DISTRIBUTOR_SECRET_KEY?.trim()
  if (distSecret && distSecret.length >= 20) {
    try {
      return Keypair.fromSecret(distSecret).publicKey()
    } catch {
      return null
    }
  }
  return null
}

type HorizonBalance = {
  asset_type?: string
  asset_code?: string
  asset_issuer?: string
  balance?: string
}

async function assertDistributorTrustline(distributor: string, asset: Asset): Promise<void> {
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(distributor)}`, {
    headers: { Accept: "application/json" },
  })
  if (res.status === 404) {
    console.error(
      `La cuenta distribuidor ${distributor} no existe en testnet. Fóndala con XLM (Friendbot) y crea la trustline antes.`,
    )
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`Horizon accounts/${distributor}: HTTP ${res.status}`)
    process.exit(1)
  }
  const data = (await res.json()) as { balances?: HorizonBalance[] }
  const balances = Array.isArray(data.balances) ? data.balances : []
  const code = asset.getCode()
  const issuer = asset.getIssuer()
  const ok = balances.some(
    (b) => b.asset_type !== "native" && b.asset_code === code && b.asset_issuer === issuer,
  )
  if (!ok) {
    console.error(
      `El distribuidor ${distributor} no tiene trustline a ${code}:${issuer}. Añádela desde Laboratory/Freighter y reintenta.`,
    )
    process.exit(1)
  }
  console.log(`Trustline OK: ${distributor} → ${code}:${issuer.slice(0, 8)}…`)
}

async function main() {
  const issuerSecret = process.env.CLASSIC_LIQ_ISSUER_SECRET?.trim()
  if (!issuerSecret || issuerSecret.length < 20) {
    console.error("Falta CLASSIC_LIQ_ISSUER_SECRET en .env.local (raíz del repo).")
    process.exit(1)
  }

  let issuerKp: Keypair
  try {
    issuerKp = Keypair.fromSecret(issuerSecret)
  } catch {
    console.error("CLASSIC_LIQ_ISSUER_SECRET no es un secret Stellar válido.")
    process.exit(1)
  }

  const issuerConfigured = assetIssuerFromEnv()
  const issuerPub = issuerKp.publicKey()
  if (issuerPub !== issuerConfigured) {
    console.error(
      `El secret del emisor corresponde a ${issuerPub}, pero NEXT_PUBLIC_CLASSIC_LIQ_ISSUER (o default) es ${issuerConfigured}. Alinea .env o usa el secret del issuer correcto.`,
    )
    process.exit(1)
  }

  const dest = resolveDistributorPublic()
  if (!dest) {
    console.error(
      "Define CLASSIC_LIQ_DISTRIBUTOR_PUBLIC, FAUCET_DISTRIBUTOR_PUBLIC_KEY (G…) o FAUCET_DISTRIBUTOR_SECRET_KEY para indicar el distribuidor.",
    )
    process.exit(1)
  }
  if (dest === issuerPub) {
    console.error("El distribuidor no puede ser la misma cuenta que el issuer.")
    process.exit(1)
  }

  const code = assetCodeFromEnv()
  const asset = new Asset(code, issuerPub)
  const amount = process.env.CLASSIC_LIQ_ISSUER_PAYMENT_AMOUNT?.trim() || DEFAULT_AMOUNT

  await assertDistributorTrustline(dest, asset)

  const server = new Horizon.Server(HORIZON_URL)
  const account = await server.loadAccount(issuerPub)

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: dest,
        asset,
        amount,
      }),
    )
    .setTimeout(180)
    .build()
  tx.sign(issuerKp)

  const result = await server.submitTransaction(tx)
  const base = HORIZON_URL.replace(/\/$/, "")
  console.log("Payment enviado.")
  console.log("Hash:", result.hash)
  console.log(`${base}/transactions/${result.hash}`)
  console.log(`${base}/accounts/${dest}`)

  // Spike 574 (phase-182): part of the distributor balance may be pool seed
  // capital. It is visible on Horizon but NOT spendable by faucet/refill; the
  // ledger subtracts `pool_seed_stroops` in availableBalance(). Print the split
  // so an operator never tops up against a balance that is already committed.
  const seedStroops = BigInt(process.env.LP_POOL_SEED_STROOPS?.trim() || "0")
  if (seedStroops > 0n) {
    console.log("")
    console.log("⚠️  LP pool seed is configured (LP_POOL_SEED_STROOPS=%s).", seedStroops.toString())
    console.log("   That portion is not spendable: call setPoolSeedReserve(distributor, seed) so")
    console.log("   availableBalance() and auto-refill stop treating it as free capital.")
  }
}

main().catch((e) => {
  console.error(e?.response?.data?.extras ?? e?.message ?? e)
  process.exit(1)
})
