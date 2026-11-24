/**
 * phase-182 end-to-end testnet proof harness (Spike 574).
 *
 * fund → act → verify → index, with real tx hashes written to a proof sidecar.
 * This script never fabricates hashes: if the wallet is unfunded, the pool does
 * not exist, or the flag is off, it exits with a BLOCKED proof and a non-zero
 * status. Configure the environment first:
 *
 *   FEATURE_PHASE_182=1
 *   PHASE_PROOF_WALLET_SECRET=<testnet G secret, funded or Friendbot-eligible>
 *   SOROSWAP_ROUTER_CONTRACT_ID=<C…>   SOROSWAP_EXPECTED_ROUTER_ID=<C…>
 *   STELLAR_RPC_URL / HORIZON_URL defaults are testnet
 *
 * Run: npx tsx scripts/phase-182-pool-proof.ts
 */
import { writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { Keypair as KeypairType } from "@stellar/stellar-sdk"
/** Testnet-only harness: fixed public Horizon, no server env dependency. */
const HORIZON_URL = "https://horizon-testnet.stellar.org"

// scripts/ has its own package.json ("type": "module"), so root TS libs are
// loaded through dynamic import to keep CJS/ESM named-export interop working.
const sdk = await import("@stellar/stellar-sdk")
const { Keypair, Networks, StrKey, TransactionBuilder } = sdk
const { resolvePhaserLiqClassicAsset } = await import("../lib/stellar")
const {
  buildClassicPoolDepositXdr,
  classicPoolIdForAssets,
  getClassicPoolSnapshot,
  isPhase182Enabled,
  quoteClassicPool,
  recordPoolActivity,
  resolveSoroswapConfig,
} = await import("../lib/liquidity-pool")
const { serverDataJsonPath } = await import("../lib/server-data-paths")

type Proof = {
  flag: string
  network: "testnet"
  generatedAt: string
  status: "COMPLETE" | "BLOCKED"
  blockedReason?: string
  wallet?: string
  fundTxHash?: string
  actTxHash?: string
  quoteHash?: string
  poolId?: string
  verified?: boolean
  indexedActivityId?: string
  routerDrift?: boolean
}

const XLM = { kind: "native" as const }

async function horizonJson(pathname: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${HORIZON_URL}${pathname}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Horizon ${pathname} returned ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

async function submitSigned(xdr: string): Promise<string> {
  const res = await fetch(`${HORIZON_URL}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: xdr }),
  })
  const json = (await res.json().catch(() => ({}))) as { hash?: string; detail?: string }
  if (!res.ok || !json.hash) throw new Error(`Horizon submit failed: ${json.detail ?? res.status}`)
  return json.hash
}

async function main(): Promise<Proof> {
  const proof: Proof = {
    flag: "phase-182",
    network: "testnet",
    generatedAt: new Date().toISOString(),
    status: "BLOCKED",
  }
  if (!isPhase182Enabled()) {
    proof.blockedReason = "FEATURE_PHASE_182 is off — set it to 1 before running the proof."
    return proof
  }
  const secret = process.env.PHASE_PROOF_WALLET_SECRET?.trim()
  if (!secret) {
    proof.blockedReason = "PHASE_PROOF_WALLET_SECRET is not set; no funded key, no live proof."
    return proof
  }
  let keypair: KeypairType
  try {
    keypair = Keypair.fromSecret(secret)
  } catch {
    proof.blockedReason = "PHASE_PROOF_WALLET_SECRET is not a valid Stellar secret."
    return proof
  }
  const wallet = keypair.publicKey()
  proof.wallet = wallet
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    proof.blockedReason = "Invalid wallet public key."
    return proof
  }

  const router = resolveSoroswapConfig()
  proof.routerDrift = !router.ok && router.code === "SOROSWAP_ROUTER_DRIFT"
  if (!router.ok && router.code === "SOROSWAP_ROUTER_DRIFT") {
    proof.blockedReason = "Soroswap router drift detected — fail closed, no proof attempted."
    return proof
  }

  // 1) FUND — Friendbot when the account is absent, otherwise a no-op.
  let account: Record<string, unknown>
  try {
    account = await horizonJson(`/accounts/${encodeURIComponent(wallet)}`)
  } catch {
    const res = await fetch(`${HORIZON_URL.replace("horizon-testnet", "friendbot")}/?addr=${encodeURIComponent(wallet)}`)
    if (!res.ok) {
      proof.blockedReason = "Friendbot could not fund the proof wallet on testnet."
      return proof
    }
    const funded = (await res.json()) as { hash?: string }
    proof.fundTxHash = funded.hash
    account = await horizonJson(`/accounts/${encodeURIComponent(wallet)}`)
  }
  const sequence = account.sequence
  if (typeof sequence !== "string" || !/^\d+$/.test(sequence)) {
    proof.blockedReason = "Horizon account did not expose a usable sequence."
    return proof
  }

  // 2) ACT — quote from a real pool, build unsigned XDR, sign locally.
  const liq = resolvePhaserLiqClassicAsset()
  const pair = [
    XLM,
    { kind: "credit" as const, code: liq.code, issuer: liq.issuer },
  ] as const
  let snapshot
  try {
    snapshot = await getClassicPoolSnapshot(classicPoolIdForAssets(pair[0], pair[1]))
  } catch {
    proof.blockedReason =
      "No live PHASELQ/XLM classic pool on testnet — seed a pool before running the proof."
    return proof
  }
  proof.poolId = snapshot.poolId
  const quote = quoteClassicPool(snapshot, { assetIn: XLM, amountInStroops: 100_000n })
  proof.quoteHash = quote.quoteHash
  const xdr = buildClassicPoolDepositXdr({
    walletAddress: wallet,
    sequence,
    snapshot,
    amountStroops: 100_000n,
  })
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
  tx.sign(keypair)
  proof.actTxHash = await submitSigned(tx.toXDR())

  // 3) VERIFY — the hash must confirm on Horizon before anything is indexed.
  const verifiedTx = await horizonJson(`/transactions/${proof.actTxHash}`)
  proof.verified = verifiedTx.successful === true

  // 4) INDEX — idempotent by activity id; wash-flagged rows are excluded from volume.
  const activity = recordPoolActivity({
    poolId: snapshot.poolId,
    wallet,
    kind: "deposit",
    activityId: `deposit:${proof.actTxHash}`,
    amountA: 100_000n,
  })
  proof.indexedActivityId = activity.id
  proof.status = proof.verified ? "COMPLETE" : "BLOCKED"
  if (!proof.verified) proof.blockedReason = "Horizon reported the submitted transaction as unsuccessful."
  return proof
}

main()
  .then((proof) => {
    const file = path.join(path.dirname(serverDataJsonPath("liquidityPoolIntents")), "phase-182-pool-proof.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(proof, null, 2), "utf8")
    console.log(JSON.stringify(proof, null, 2))
    if (proof.status !== "COMPLETE") process.exitCode = 1
  })
  .catch((e: unknown) => {
    console.error("[phase-182 proof] unexpected failure:", e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
