/**
 * Publica `home_domain` en la cuenta emisora del asset clásico PHASELQ (Horizon testnet).
 * Así Freighter / wallets resuelven https://TU_DOMINIO/.well-known/stellar.toml y el icono.
 *
 * Requiere CLASSIC_LIQ_ISSUER_SECRET (misma que POST /api/classic-liq bootstrap).
 *
 * Uso desde la raíz del repo:
 *   cd scripts && npm install && npm run set:issuer-home-domain
 *
 * Variables:
 *   CLASSIC_LIQ_ISSUER_HOME_DOMAIN  — opcional; host sin protocolo (ej. www.phasee.xyz)
 *   NEXT_PUBLIC_SITE_URL          — si no hay la anterior, se usa el host de esta URL
 */
import * as dotenv from "dotenv"
import { lookup } from "node:dns/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
dotenv.config({ path: path.join(repoRoot, ".env.local") })
dotenv.config({ path: path.join(repoRoot, ".env") })
dotenv.config({ path: path.join(__dirname, ".env") })

const HORIZON_URL = process.env.HORIZON_TESTNET_URL?.trim() || "https://horizon-testnet.stellar.org"

/** Debe coincidir con `LEGACY_PHASERLIQ_ISSUER` en `lib/classic-liq.ts` (PHASERLIQ-GAXR…). */
const LEGACY_PHASERLIQ_ISSUER =
  "GAXRPE5JXPY7RJONMCEWFXELVWDW3CSA7H6LAGYKTOYLFQQDJ5DT4GNS"

function parseHomeDomainFromEnv(): string {
  const explicit = process.env.CLASSIC_LIQ_ISSUER_HOME_DOMAIN?.trim()
  if (explicit) return stripUrlToHost(explicit)
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (site) return stripUrlToHost(site)
  return "www.phasee.xyz"
}

function stripUrlToHost(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .trim()
    .toLowerCase()
}

async function verifyPublishedToml(homeDomain: string, issuer: string, code: string): Promise<void> {
  const addresses = await lookup(homeDomain, { all: true })
  if (!addresses.length) throw new Error(`DNS lookup returned no address for ${homeDomain}`)
  const url = `https://${homeDomain}/.well-known/stellar.toml`
  const response = await fetch(url, { cache: "no-store", headers: { Accept: "text/plain" } })
  if (!response.ok) throw new Error(`TOML preflight failed (${response.status}) at ${url}`)
  const body = await response.text()
  if (!body.includes(`code=\"${code}\"`) || !body.includes(`issuer=\"${issuer}\"`)) {
    throw new Error(`TOML preflight found no ${code}-${issuer} currency row`)
  }
  const image = body.match(/image=\"([^\"]+)\"/)?.[1] ?? ""
  if (!image.startsWith("https://")) throw new Error("TOML image must be an absolute HTTPS URL")
  const imageResponse = await fetch(image, { method: "HEAD", cache: "no-store" })
  if (!imageResponse.ok) throw new Error(`TOML image preflight failed (${imageResponse.status})`)
}

async function main() {
  const phase173Enabled = ["1", "true", "yes", "on"].includes(
    (process.env.FEATURE_PHASE_173 ?? process.env.NEXT_PUBLIC_FEATURE_PHASE_173 ?? "").trim().toLowerCase(),
  )
  const secret = process.env.CLASSIC_LIQ_ISSUER_SECRET?.trim()
  if (!secret || secret.length < 20) {
    console.error(
      "Falta CLASSIC_LIQ_ISSUER_SECRET en .env.local (raíz del repo). Sin la clave del emisor no se puede firmar set_options.",
    )
    process.exit(1)
  }

  const homeDomain = parseHomeDomainFromEnv()
  if (!homeDomain || homeDomain.length > 32) {
    console.error("home_domain inválido o > 32 caracteres (límite Stellar).")
    process.exit(1)
  }

  let kp: Keypair
  try {
    kp = Keypair.fromSecret(secret)
  } catch {
    console.error("CLASSIC_LIQ_ISSUER_SECRET no es un secret Stellar válido.")
    process.exit(1)
  }

  const server = new Horizon.Server(HORIZON_URL)
  const pub = kp.publicKey()
  const assetCode = pub === LEGACY_PHASERLIQ_ISSUER
    ? "PHASERLIQ"
    : process.env.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE?.trim() || "PHASELQ"
  if (phase173Enabled && process.env.ISSUER_HOME_DOMAIN_SKIP_PREFLIGHT !== "1") {
    await verifyPublishedToml(homeDomain, pub, assetCode)
    console.log(`Preflight OK: DNS + TOML + HTTPS image verified for ${homeDomain}`)
  }
  console.log(`Emisor derivado del secret en uso: ${pub}`)
  const account = await server.loadAccount(pub)
  const current = (account.home_domain ?? "").trim()
  if (current === homeDomain) {
    console.log(`home_domain ya es "${homeDomain}" en ${pub}. Nada que hacer.`)
    if (pub !== LEGACY_PHASERLIQ_ISSUER) {
      console.log(
        `Si en Stellar Expert miras PHASERLIQ-${LEGACY_PHASERLIQ_ISSUER.slice(0, 4)}… (emisor legado), es otra cuenta: hay que ejecutar este script con CLASSIC_LIQ_ISSUER_SECRET de esa cuenta (${LEGACY_PHASERLIQ_ISSUER}).`,
      )
    }
    return
  }
  if (current) {
    console.log(`Cambiando home_domain: "${current}" → "${homeDomain}"`)
  } else {
    console.log(`Estableciendo home_domain="${homeDomain}" en emisor ${pub}`)
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        homeDomain,
      }),
    )
    .setTimeout(180)
    .build()
  tx.sign(kp)

  if (process.env.ISSUER_HOME_DOMAIN_DRY_RUN === "1") {
    console.log("DRY RUN: transaction was built and signed but not submitted.")
    console.log(tx.toXDR())
    return
  }
  const res = await server.submitTransaction(tx)
  console.log("OK. Hash:", res.hash)
  console.log(`Horizon: ${HORIZON_URL.replace(/\/$/, "")}/transactions/${res.hash}`)
  if (phase173Enabled) {
    const updated = await server.loadAccount(pub)
    if ((updated.home_domain ?? "").trim() !== homeDomain) throw new Error("Horizon confirmation did not reflect the requested home_domain")
    console.log(`Verified on Horizon: home_domain=${homeDomain}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
