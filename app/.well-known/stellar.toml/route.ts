import { NextResponse } from "next/server"
import { stellarTomlPhaserLiqCurrencyRows } from "@/lib/classic-liq"
import { stellarExpertPhaserLiqUrl, tokenContractIdForServer } from "@/lib/phase-protocol"

const PHASE_LIQ_TOKEN_CONTRACT = tokenContractIdForServer()

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
const PRODUCTION_SITE = "https://www.phasee.xyz"

/** Base URL for absolute `image=` in stellar.toml (wallets require HTTPS + absolute). */
function siteBaseForStellarToml(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.trim()?.replace(/\/+$/, "")
  if (fromEnv) return fromEnv.includes("://") ? fromEnv : `https://${fromEnv}`
  if (process.env.VERCEL_ENV === "production") return PRODUCTION_SITE
  const vercel = process.env.VERCEL_URL?.trim()?.replace(/\/+$/, "")
  if (vercel) return `https://${vercel}`
  return process.env.NODE_ENV === "development" ? "http://localhost:3000" : PRODUCTION_SITE
}

export async function GET() {
  const base = siteBaseForStellarToml()
  const icon = `${base}/phaser-liq-token.png`
  const expertPrimary = stellarExpertPhaserLiqUrl()
  const rows = stellarTomlPhaserLiqCurrencyRows()

  const accountsToml = `[\n${rows.map((r) => `  "${r.issuer}",`).join("\n")}\n]`

  const currencyBlocks = rows
    .map((r) => {
      const desc =
        r.code === "PHASERLIQ"
          ? "Legacy PHASERLIQ (classic) liquidity for PHASE settlement flows on testnet."
          : "PHASELQ utility liquidity token for PHASE settlement flows."
      return `[[CURRENCIES]]
code="${r.code}"
issuer="${r.issuer}"
script="${r.script}"
status="test"
name="Phase Liquidity"
desc="${desc}"
image="${icon}"
display_decimals=7`
    })
    .join("\n\n")

  const body = `VERSION="2.0.0"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE}"
ACCOUNTS=${accountsToml}
# Site-wide Soroban / docs (root-level; keep [[CURRENCIES]] SEP-clean for indexers)
PHASER_LIQ_PRIMARY_CONTRACT_ID="${PHASE_LIQ_TOKEN_CONTRACT}"
PHASER_LIQ_ICON="${icon}"
PHASER_LIQ_STELLAR_EXPERT="${expertPrimary}"
PHASER_LIQ_X402_DOCS="https://developers.stellar.org/docs/build/agentic-payments/x402"
PHASER_LIQ_X402_NPM="https://www.npmjs.com/package/x402-stellar"
PHASER_LIQ_NODE_DECLARATION_DOCS="https://developers.stellar.org/docs/validators/tier-1-orgs#declare-your-node"

${currencyBlocks}
`

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Cache-Control": "no-store, max-age=0",
      // Freighter / dApp (Origin www.phasee.xyz) y stellar.expert deben poder leer el TOML (CORS).
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  })
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  })
}
