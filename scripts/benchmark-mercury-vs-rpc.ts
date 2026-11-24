/**
 * Spike #40 — Mercury Classic REST vs direct Soroban RPC event/ownership scan.
 *
 * Benchmarks the two token-lookup strategies used by
 * `app/api/wallet/phase-nfts/route.ts`:
 *   1. Mercury Classic REST — one HTTP call to `/events/by-contract/:id`
 *      (requires MERCURY_JWT).
 *   2. Direct Soroban RPC — N `owner_of(token_id)` simulate calls against
 *      the deployed contract (what the route falls back to when Mercury is
 *      unconfigured or errors).
 *
 * This is read-only (simulate calls only, never submits a transaction), so
 * it's safe to run anytime against testnet.
 *
 * Usage (from scripts/, with `.env.local` at repo root populated):
 *   npx tsx benchmark-mercury-vs-rpc.ts [--tokens=20]
 *
 * Reads from `.env.local`: PHASE_PROTOCOL_ID (or NEXT_PUBLIC_PHASE_PROTOCOL_ID),
 * MERCURY_JWT (optional — Mercury benchmark is skipped if absent),
 * MERCURY_REST_URL (optional, defaults to https://api.mercurydata.app/rest).
 */

import { config } from "dotenv"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { Contract, TransactionBuilder, Account, nativeToScVal } from "@stellar/stellar-sdk"
import { sorobanRpc, RPC_URL, NETWORK_PASSPHRASE, log, colors } from "./utils.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
config({ path: resolve(ROOT, ".env.local") })

const contractId = (process.env.PHASE_PROTOCOL_ID || process.env.NEXT_PUBLIC_PHASE_PROTOCOL_ID || "").trim()
const mercuryJwt = process.env.MERCURY_JWT?.trim()
const mercuryRestBase = process.env.MERCURY_REST_URL?.trim() || "https://api.mercurydata.app/rest"

const tokensArg = process.argv.find((a) => a.startsWith("--tokens="))
const tokenSampleSize = tokensArg ? Math.max(1, parseInt(tokensArg.split("=")[1]!, 10)) : 20

// A funded-or-not throwaway account works fine — simulate() doesn't require signing or a real sequence.
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

async function timeit<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number; result: T | null; error?: string }> {
  const start = Date.now()
  try {
    const result = await fn()
    return { label, ms: Date.now() - start, result }
  } catch (e) {
    return { label, ms: Date.now() - start, result: null, error: e instanceof Error ? e.message : String(e) }
  }
}

async function simulateOwnerOf(tokenId: number): Promise<unknown> {
  const source = new Account(SIMULATION_SOURCE, "0")
  const contract = new Contract(contractId)
  const tokenIdArg = nativeToScVal(tokenId, { type: "u32" })
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call("owner_of", tokenIdArg))
    .setTimeout(30)
    .build()
  return sorobanRpc.simulateTransaction(tx)
}

async function benchmarkRpcScan(sampleSize: number) {
  log.section(`Soroban RPC: ${sampleSize} sequential owner_of() simulate calls`)
  const perCall: number[] = []
  for (let tokenId = 1; tokenId <= sampleSize; tokenId++) {
    const t = await timeit(`owner_of(${tokenId})`, () => simulateOwnerOf(tokenId))
    perCall.push(t.ms)
  }
  const total = perCall.reduce((a, b) => a + b, 0)
  const avg = total / perCall.length
  log.info(`total=${total}ms avg=${avg.toFixed(1)}ms/call over ${sampleSize} calls`)
  log.info(`extrapolated to a 5000-token brute-force scan (this repo's PHASE_NFT_WALLET_SCAN_CAP default): ~${((avg * 5000) / 1000).toFixed(1)}s sequential`)
  return { total, avg, sampleSize }
}

async function benchmarkMercury() {
  if (!mercuryJwt) {
    log.warning("MERCURY_JWT not set — skipping Mercury Classic benchmark. Set it in .env.local to compare.")
    return null
  }
  log.section("Mercury Classic REST: single events-by-contract call")
  const t = await timeit("mercury events fetch", async () => {
    const url = new URL(`${mercuryRestBase}/events/by-contract/${contractId}`)
    url.searchParams.set("limit", "1000")
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${mercuryJwt}` } })
    if (!res.ok) throw new Error(`Mercury HTTP ${res.status}`)
    return res.json()
  })
  if (t.error) {
    log.error(`Mercury benchmark failed: ${t.error}`)
    return null
  }
  log.info(`${t.ms}ms for one indexed events fetch (covers the whole contract, not per-token)`)
  return t.ms
}

async function main() {
  if (!contractId) {
    log.error("Missing PHASE_PROTOCOL_ID / NEXT_PUBLIC_PHASE_PROTOCOL_ID in .env.local")
    process.exit(1)
  }
  log.info(`${colors.cyan}RPC:${colors.reset} ${RPC_URL}`)
  log.info(`${colors.cyan}Contract:${colors.reset} ${contractId}`)

  const mercuryMs = await benchmarkMercury()
  const rpcResult = await benchmarkRpcScan(tokenSampleSize)

  log.section("Summary")
  if (mercuryMs != null) {
    console.log(`Mercury (whole-contract index):  ${mercuryMs}ms`)
  }
  console.log(`RPC (per owner_of() simulate):    ${rpcResult.avg.toFixed(1)}ms avg, ${rpcResult.total}ms for ${rpcResult.sampleSize} calls`)
  console.log("")
  console.log(
    "Recommendation: prefer Mercury Classic when MERCURY_JWT is configured — it answers in one\n" +
      "HTTP call regardless of collection size, while the RPC path's cost grows linearly with the\n" +
      "token-id range scanned. When Mercury is unavailable, cache the resolved index (phase-135,\n" +
      "lib/wallet-nft-index-cache.ts) so repeat lookups skip the RPC scan entirely, and degrade to\n" +
      "the last-known-good cached index instead of failing the request if a live scan errors.",
  )
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
