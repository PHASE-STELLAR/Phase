import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises"
import path from "node:path"
import { NextRequest, NextResponse } from "next/server"
import { serverDataJsonPath } from "@/lib/server-data-paths"
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
import { readClassicWalletStatus, type ClassicLiqAsset, type ClassicLiqWalletStatus } from "@/lib/classic-liq"
import {
  ensureTrustlineBeforeClassicPayment,
  logHorizonSubmitError,
  resolvePhaserLiqClassicAsset,
} from "@/lib/stellar"
import { HORIZON_URL } from "@/lib/phase-protocol"

export const dynamic = 'force-dynamic'

type ClassicClaims = Record<string, { classicFundAt?: number }>

function classicClaimsFilePath() {
  return serverDataJsonPath("classicLiqClaims")
}

async function readClassicClaims(): Promise<ClassicClaims> {
  try {
    const raw = await readFile(classicClaimsFilePath(), "utf8")
    const parsed = JSON.parse(raw) as ClassicClaims
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writeClassicClaims(claims: ClassicClaims) {
  const file = classicClaimsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(claims, null, 2), "utf8")
}

function readClassicAssetConfig(): { asset: ClassicLiqAsset; issuerKp: Keypair; amount: string } | null {
  const code = process.env.CLASSIC_LIQ_ASSET_CODE?.trim() || process.env.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE?.trim() || ""
  const issuerSecret = process.env.CLASSIC_LIQ_ISSUER_SECRET?.trim() || ""
  const amount = process.env.CLASSIC_LIQ_BOOTSTRAP_AMOUNT?.trim() || "10.0000000"
  if (!code || !issuerSecret) return null
  let issuerKp: Keypair
  try {
    issuerKp = Keypair.fromSecret(issuerSecret)
  } catch {
    return null
  }
  return { asset: { code, issuer: issuerKp.publicKey() }, issuerKp, amount }
}

async function walletStatus(wallet: string, asset: ClassicLiqAsset): Promise<ClassicLiqWalletStatus> {
  return readClassicWalletStatus(wallet, asset)
}

function classicClaimsLockPath() {
  return `${classicClaimsFilePath()}.lock`
}

// Serializes the check-then-claim below so parallel POSTs for the same
// wallet can't both pass the "already claimed?" check before either has
// written its claim — the race that let concurrent requests each trigger a
// separate Horizon payout for the same bootstrap.
async function withClaimsLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = classicClaimsLockPath()
  const start = Date.now()
  while (true) {
    try {
      const handle = await open(lockPath, "wx")
      await handle.close()
      break
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err
      if (Date.now() - start > 5000) throw new Error("classic-liq claims lock timeout")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
  }
}

/** Atomically claims the bootstrap for `wallet`, or returns false if already claimed. */
async function claimClassicFund(wallet: string): Promise<boolean> {
  return withClaimsLock(async () => {
    const claims = await readClassicClaims()
    if (claims[wallet]?.classicFundAt) return false
    const row = claims[wallet] ?? {}
    row.classicFundAt = Date.now()
    claims[wallet] = row
    await writeClassicClaims(claims)
    return true
  })
}

/** Releases a claim after a failed Horizon submission, so a genuine failure doesn't permanently lock the wallet out. */
async function releaseClassicFundClaim(wallet: string): Promise<void> {
  await withClaimsLock(async () => {
    const claims = await readClassicClaims()
    delete claims[wallet]
    await writeClassicClaims(claims)
  })
}

export async function GET(req: NextRequest) {
  const config = readClassicAssetConfig()
  const wallet = req.nextUrl.searchParams.get("walletAddress")?.trim() ?? null
  if (!config) {
    const flowAsset = resolvePhaserLiqClassicAsset()
    if (wallet && StrKey.isValidEd25519PublicKey(wallet)) {
      try {
        const status = await walletStatus(wallet, flowAsset)
        return NextResponse.json({
          enabled: false,
          trustlineFlowAvailable: true,
          asset: flowAsset,
          wallet,
          status,
        })
      } catch (e) {
        return NextResponse.json(
          {
            enabled: false,
            trustlineFlowAvailable: true,
            asset: flowAsset,
            error: e instanceof Error ? e.message : String(e),
          },
          { status: 502 },
        )
      }
    }
    return NextResponse.json({
      enabled: false,
      trustlineFlowAvailable: true,
      asset: flowAsset,
    })
  }
  if (!wallet) {
    return NextResponse.json({
      enabled: true,
      asset: config.asset,
      bootstrapAmount: config.amount,
    })
  }
  if (!StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "walletAddress inválida." }, { status: 400 })
  }
  try {
    const status = await walletStatus(wallet, config.asset)
    const claims = await readClassicClaims()
    const fundedAt = claims[wallet]?.classicFundAt ?? null
    return NextResponse.json({
      enabled: true,
      asset: config.asset,
      bootstrapAmount: config.amount,
      wallet,
      status,
      fundedAt,
      claimable: status.hasTrustline && !fundedAt,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), enabled: true, asset: config.asset },
      { status: 502 },
    )
  }
}

export async function POST(req: NextRequest) {
  const config = readClassicAssetConfig()
  if (!config) {
    return NextResponse.json(
      { error: "Classic LIQ disabled. Set CLASSIC_LIQ_ASSET_CODE + CLASSIC_LIQ_ISSUER_SECRET." },
      { status: 503 },
    )
  }

  let body: { walletAddress?: string; userAddress?: string }
  try {
    body = (await req.json()) as { walletAddress?: string; userAddress?: string }
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 })
  }

  const wallet = (body.walletAddress ?? body.userAddress)?.trim()
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "walletAddress debe ser cuenta Stellar G válida." }, { status: 400 })
  }

  const status = await walletStatus(wallet, config.asset)
  if (!status.accountExists) {
    return NextResponse.json(
      { error: "Wallet account not found on testnet. Fund account with Friendbot first." },
      { status: 412 },
    )
  }
  const trustOk = await ensureTrustlineBeforeClassicPayment(wallet, config.asset)
  if (!trustOk.ok) {
    return NextResponse.json(
      {
        error: "Trustline required. User must sign changeTrust in Freighter first.",
        asset: config.asset,
        code: trustOk.reason,
      },
      { status: 412 },
    )
  }

  const claimed = await claimClassicFund(wallet)
  if (!claimed) {
    const claims = await readClassicClaims()
    return NextResponse.json(
      {
        error: "Classic bootstrap already claimed for this wallet.",
        fundedAt: claims[wallet]?.classicFundAt ?? null,
      },
      { status: 409 },
    )
  }

  try {
    const server = new Horizon.Server(HORIZON_URL)
    const source = await server.loadAccount(config.issuerKp.publicKey())
    const asset = new Asset(config.asset.code, config.asset.issuer)
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: wallet,
          asset,
          amount: config.amount,
        }),
      )
      .setTimeout(30)
      .build()
    tx.sign(config.issuerKp)
    const submit = await server.submitTransaction(tx)
    return NextResponse.json({
      ok: true,
      hash: submit.hash,
      asset: config.asset,
      amount: config.amount,
    })
  } catch (e) {
    await releaseClassicFundClaim(wallet)
    logHorizonSubmitError("classic-liq POST payment", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), asset: config.asset },
      { status: 502 },
    )
  }
}
