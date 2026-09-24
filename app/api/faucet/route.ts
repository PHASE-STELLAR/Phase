import { NextRequest, NextResponse } from "next/server"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import {
  classicLiqIssuerForStellarToml,
  expectedClassicPhaserLiqSorobanContractId,
  readClassicWalletStatus,
} from "@/lib/classic-liq"
import { validateFaucetIssuerConfig } from "@/lib/env-validation"
import { warnPhaserLiqSacMismatchOnce } from "@/lib/phaser-liq-sac-warn"
import { resolvePhaserLiqClassicAsset, summarizeSorobanFailedMint } from "@/lib/stellar"
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk"
import {
  checkHasPhased,
  fetchCreatorCollectionId,
  fetchCreatorCollectionIds,
  fetchTotalCollections,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  PHASER_FAUCET_MINT_STROOPS,
  RPC_URL,
  tokenContractIdForServer,
  userOwnsAnyPhaseToken,
} from "@/lib/phase-protocol"
import { getAllWorldCollections } from "@/lib/narrative-world-store"
import { isQuestSnapshotEnabled, loadQuestSnapshot, saveQuestSnapshot, pruneStaleSnapshots } from "@/lib/quest-snapshot"
import { isStreakMultiplierEnabled, getStreakInfo, applyStreakMultiplier, recordDailyClaim, type StreakInfo } from "@/lib/quest-streak"
import { isReferralQuestEnabled, validateReferralCode, recordReferral, getReferralStats } from "@/lib/referral-quest"
import { isDistributorTopupEnabled, prepareTopup } from "@/lib/distributor-topup"
import {
  evaluateAllQuests,
  getQuestRegistry,
  getQuestRewardAmount,
  isValidQuestId,
  type QuestEvaluationResult
} from "@/lib/quest-registry"
import { assessWalletSybilRisk, isSybilResistanceEnabled } from "@/lib/sybil-resistance"
import { isWalletDenied } from "@/lib/faucet-deny-list"
import { verifyTurnstileToken, turnstileSiteKeyConfigured } from "@/lib/faucet-turnstile"

/** Vercel: Hobby ~10s; Pro/Enterprise permite más — subir si el faucet sigue en 504. */
export const maxDuration = 60

/** Sin caché de respuesta de ruta: cada POST vuelve a simular/preparar en cadena. */
export const dynamic = 'force-dynamic'

const PHASE_LIQ_TOKEN_CONTRACT = tokenContractIdForServer()

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000
const FAUCET_PENDING_TTL_MS = 8 * 60 * 1000
const FAUCET_POLL_INTERVAL_MS = 1000
const FAUCET_MAX_POLLS_PER_REQUEST = 4
const DAILY_REWARD_STROOPS = "20000000"
/** Por debajo de esto, Soroban suele fallar (trap / ihf_trapped) por falta de XLM para fees y renta. */
const MIN_SIGNER_NATIVE_XLM = 5

type RewardType = "genesis" | "daily" | string

type WalletClaims = {
  genesisAt?: number
  dailyAt?: number
  quests?: Record<string, number>
  /** Mint ya enviado; reutilizamos el hash para seguir el poll sin reenviar (serverless timeout). */
  faucetPending?: { hash: string; reward: RewardType; at: number }
}

type FaucetClaims = Record<string, WalletClaims>

/** GET /api/faucet llama `evaluateAllQuests` muchas veces; cache corto evita re-escanear el ledger en cada render. */
const questProgressCache = new Map<string, { at: number; data: Record<string, QuestEvaluationResult> }>()
const QUEST_PROGRESS_CACHE_TTL_MS = 5000

async function readQuestProgressCached(wallet: string | null): Promise<Record<string, QuestEvaluationResult>> {
  if (!wallet) return evaluateAllQuests(null)
  const now = Date.now()
  const hit = questProgressCache.get(wallet)
  if (hit && now - hit.at < QUEST_PROGRESS_CACHE_TTL_MS) return hit.data
  // phase-130: try loading from disk snapshot before scanning on-chain
  if (isQuestSnapshotEnabled()) {
    const snapshot = await loadQuestSnapshot(wallet)
    if (snapshot) {
      questProgressCache.set(wallet, { at: now, data: snapshot })
      return snapshot
    }
  }
  const data = await evaluateAllQuests(wallet)
  questProgressCache.set(wallet, { at: now, data })
  // phase-130: persist snapshot for cold-start recovery
  void saveQuestSnapshot(wallet, data).catch(() => {})
  return data
}

type RewardStatus = {
  claimable: boolean
  claimedAt: number | null
  nextAt: number | null
  amountStroops: string
  requirementMet?: boolean
  progressPct?: number
  requirementText?: string
}

async function parseRewardType(input: unknown): Promise<RewardType> {
  const value = typeof input === "string" ? input.trim().toLowerCase() : ""
  if (value === "genesis" || value === "daily") return value
  
  // Check if it's a valid quest ID from the registry
  const registry = await getQuestRegistry()
  if (isValidQuestId(registry, value)) return value
  
  return "genesis"
}

function claimsFilePath() {
  return serverDataJsonPath("faucetClaims")
}

async function readClaims(): Promise<FaucetClaims> {
  try {
    const raw = await readFile(claimsFilePath(), "utf8")
    const parsed = JSON.parse(raw) as Record<string, number | WalletClaims>
    if (!parsed || typeof parsed !== "object") return {}
    const normalized: FaucetClaims = {}
    for (const [wallet, value] of Object.entries(parsed)) {
      if (typeof value === "number") {
        normalized[wallet] = { genesisAt: value }
        continue
      }
      if (!value || typeof value !== "object") continue
      const fp = value.faucetPending
      let faucetPending: WalletClaims["faucetPending"]
      if (fp && typeof fp === "object" && typeof fp.hash === "string" && typeof fp.at === "number") {
        const r = parseRewardType(fp.reward)
        faucetPending = { hash: fp.hash, reward: r, at: fp.at }
      }
      normalized[wallet] = {
        genesisAt: typeof value.genesisAt === "number" ? value.genesisAt : undefined,
        dailyAt: typeof value.dailyAt === "number" ? value.dailyAt : undefined,
        quests: value.quests && typeof value.quests === "object" ? value.quests : {},
        faucetPending,
      }
    }
    return normalized
  } catch {
    return {}
  }
}

async function writeClaims(claims: FaucetClaims) {
  const file = claimsFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(claims, null, 2), "utf8")
}

function faucetUsesDistributorTransfer(): boolean {
  const s = process.env.FAUCET_DISTRIBUTOR_SECRET_KEY?.trim()
  return Boolean(s && s.length >= 20)
}

function faucetConfigured(): boolean {
  if (faucetUsesDistributorTransfer()) return true
  const secret = process.env.ADMIN_SECRET_KEY?.trim()
  return Boolean(secret && secret.length >= 20)
}

async function fetchNativeXlmBalance(gAddress: string): Promise<number | null> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(gAddress)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json()) as { balances?: Array<{ asset_type?: string; balance?: string }> }
    const native = data.balances?.find((b) => b.asset_type === "native")
    if (!native?.balance) return null
    const n = parseFloat(native.balance)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** Mismo contrato token que el resto de la app (`lib/phase-protocol.ts`), ya validado como C…. */
function serverTokenContractId(): string {
  return PHASE_LIQ_TOKEN_CONTRACT
}

function rewardAmountStroops(reward: RewardType): string {
  if (reward === "genesis") return PHASER_FAUCET_MINT_STROOPS
  if (reward === "daily") return DAILY_REWARD_STROOPS
  if (reward === "quest_first_world" || reward === "quest_three_collections") return NEW_QUEST_REWARD_STROOPS
  return QUEST_REWARD_STROOPS
}

function isQuestReward(reward: RewardType): reward is QuestId {
  return QUEST_IDS.includes(reward as QuestId)
}

async function rewardAmountStroops(reward: RewardType): Promise<string> {
  if (reward === "genesis") return PHASER_FAUCET_MINT_STROOPS
  if (reward === "daily") return DAILY_REWARD_STROOPS
  
  // Get reward from quest registry
  const registry = await getQuestRegistry()
  return getQuestRewardAmount(registry, reward)
}

async function isQuestReward(reward: RewardType): Promise<boolean> {
  if (reward === "genesis" || reward === "daily") return false
  const registry = await getQuestRegistry()
  return isValidQuestId(registry, reward)
}

async function claimStatusForReward(claim: WalletClaims, reward: RewardType, now: number): Promise<RewardStatus> {
  if (reward === "genesis") {
    return {
      claimable: !claim.genesisAt,
      claimedAt: claim.genesisAt ?? null,
      nextAt: null,
      amountStroops: await rewardAmountStroops("genesis"),
    }
  }

  if (reward === "daily") {
    const last = claim.dailyAt ?? 0
    const claimable = !last || now - last >= DAILY_WINDOW_MS
    return {
      claimable,
      claimedAt: last || null,
      nextAt: claimable ? null : last + DAILY_WINDOW_MS,
      amountStroops: await rewardAmountStroops("daily"),
    }
  }

  const at = claim.quests?.[reward] ?? 0
  return {
    claimable: !at,
    claimedAt: at || null,
    nextAt: null,
    amountStroops: await rewardAmountStroops(reward),
  }
}

async function buildWalletStatus(wallet: string | null, claims: FaucetClaims) {
  const now = Date.now()
  const claim = wallet ? claims[wallet] ?? {} : {}
  const questProgress = await readQuestProgressCached(wallet)
  
  // Get quest registry to build dynamic quest list
  const registry = await getQuestRegistry()
  const enabledQuests = registry.quests.filter((q) => q.enabled).sort((a, b) => a.order - b.order)
  
  // Build rewards object dynamically
  const [rawGenesis, rawDaily] = await Promise.all([
    claimStatusForReward(claim, "genesis", now),
    claimStatusForReward(claim, "daily", now),
  ])
  
  const rewards: Record<string, RewardStatus> = {
    genesis: rawGenesis,
    daily: rawDaily,
  }
  
  // Process all quests dynamically
  const questStatuses: RewardStatus[] = []
  for (const quest of enabledQuests) {
    const rawStatus = await claimStatusForReward(claim, quest.id, now)
    const progress = questProgress[quest.id]
    
    if (progress) {
      const questStatus: RewardStatus = {
        ...rawStatus,
        claimable: rawStatus.claimable && progress.completed,
        requirementMet: Boolean(rawStatus.claimedAt) || progress.completed,
        progressPct: rawStatus.claimedAt ? 100 : progress.progressPct,
        requirementText: progress.requirementText,
      }
      rewards[quest.id] = questStatus
      questStatuses.push(questStatus)
    }
  }
  
  const questsDone = questStatuses.filter((r) => r.claimedAt || r.requirementMet).length
  const totalQuests = questStatuses.length

  // phase-131: include streak multiplier info for daily reward display
  let streakInfo: StreakInfo | undefined
  if (isStreakMultiplierEnabled() && wallet) {
    try {
      streakInfo = await getStreakInfo(wallet)
    } catch { /* non-critical */ }
  }

  // phase-132: include referral stats for the wallet
  let referralStats: { code: string | null; totalReferred: number; remainingSlots: number } | undefined
  if (isReferralQuestEnabled() && wallet) {
    try {
      referralStats = await getReferralStats(wallet)
    } catch { /* non-critical */ }
  }

  return {
    enabled: faucetConfigured(),
    payoutMode: faucetConfigured() ? (faucetUsesDistributorTransfer() ? "transfer" : "mint") : null,
    wallet,
    dailyWindowMs: DAILY_WINDOW_MS,
    questOverview: {
      completed: questsDone,
      total: totalQuests,
      progressPct: Math.round((questsDone / totalQuests) * 100),
    },
    rewards,
    ...(streakInfo ? { streak: streakInfo } : {}),
    ...(referralStats ? { referral: referralStats } : {}),
  }
}

/** Cliente puede comprobar disponibilidad y estado por wallet (sin filtrar secretos). */
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("walletAddress")?.trim() ?? null
  if (wallet && !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "walletAddress inválida." }, { status: 400 })
  }
  const claims = await readClaims()
  return NextResponse.json(await buildWalletStatus(wallet, claims))
}

async function markClaim(wallet: string, reward: RewardType) {
  questProgressCache.delete(wallet)
  const claims = await readClaims()
  const walletClaim = claims[wallet] ?? {}
  walletClaim.faucetPending = undefined
  const now = Date.now()
  if (reward === "genesis") walletClaim.genesisAt = now
  else if (reward === "daily") walletClaim.dailyAt = now
  else if (await isQuestReward(reward)) {
    walletClaim.quests = walletClaim.quests ?? {}
    walletClaim.quests[reward] = now
  }
  claims[wallet] = walletClaim
  await writeClaims(claims)
  // phase-130: prune stale snapshots periodically (fire-and-forget)
  if (isQuestSnapshotEnabled()) {
    void pruneStaleSnapshots().catch(() => {})
  }
}

async function clearFaucetPendingOnly(wallet: string) {
  const claims = await readClaims()
  const w = claims[wallet]
  if (!w?.faucetPending) return
  w.faucetPending = undefined
  claims[wallet] = w
  await writeClaims(claims)
}

type MintPollResult =
  | { outcome: "SUCCESS" }
  | { outcome: "FAILED"; failed: rpc.Api.GetFailedTransactionResponse }
  | { outcome: "PENDING" }

/** A lo sumo ~5s de espera por invocación (compatible con timeout serverless). */
async function pollSubmittedMint(soroban: rpc.Server, hash: string): Promise<MintPollResult> {
  for (let i = 0; i < FAUCET_MAX_POLLS_PER_REQUEST; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, FAUCET_POLL_INTERVAL_MS))
    }
    try {
      const st = await soroban.getTransaction(hash)
      if (st.status === rpc.Api.GetTransactionStatus.SUCCESS) return { outcome: "SUCCESS" }
      if (st.status === rpc.Api.GetTransactionStatus.FAILED) {
        return { outcome: "FAILED", failed: st as rpc.Api.GetFailedTransactionResponse }
      }
    } catch {
      // RPC intermitente: seguir intentando dentro del presupuesto de polls
    }
  }
  return { outcome: "PENDING" }
}

function faucetMintLedgerFailedResponse(
  hash: string,
  failed: rpc.Api.GetFailedTransactionResponse,
): NextResponse {
  const sorobanSummary = summarizeSorobanFailedMint(failed)
  console.error("[faucet] Soroban mint/transfer FAILED (trustline ya verificada en esta petición)", {
    hash,
    sorobanSummary,
    ledger: failed.ledger,
  })
  return NextResponse.json(
    {
      error: "La transacción falló en el ledger (Soroban).",
      code: "FAUCET_MINT_LEDGER_FAILED",
      detail: `En esta petición ya comprobamos en Horizon que tenías trustline PHASELQ (mismo code+issuer que la app). El rechazo viene del contrato token o de otra regla on-chain, no de "falta trustline". Detalle: ${sorobanSummary}. Abre el hash en Stellar Expert (Soroban testnet) para ver el motivo exacto.`,
      hash,
      sorobanSummary,
    },
    { status: 502 },
  )
}

/**
 * El mint Soroban acredita el mismo PHASELQ que el asset clásico: sin trustline el ledger rechaza la tx.
 * Usa solo vars públicas (NEXT_PUBLIC_CLASSIC_LIQ_*) — no requiere CLASSIC_LIQ_ISSUER_SECRET.
 */
async function preflightClassicTrustlineForMint(userAddress: string): Promise<NextResponse | null> {
  const asset = resolvePhaserLiqClassicAsset()
  try {
    const ws = await readClassicWalletStatus(userAddress, asset)
    if (!ws.accountExists) {
      return NextResponse.json(
        {
          error: "Cuenta de usuario no encontrada en testnet.",
          code: "USER_ACCOUNT_NOT_FOUND",
          detail: `La wallet ${userAddress.slice(0, 8)}... no existe en Stellar testnet. ` +
                  `Debes fondearla primero con XLM usando Friendbot antes de poder recibir PHASELQ.`,
          hint: `Visita: https://friendbot.stellar.org/?addr=${userAddress}`,
          action: "Fondea tu cuenta con XLM usando Friendbot, luego vuelve a intentar.",
        },
        { status: 412 },
      )
    }
    if (!ws.hasTrustline) {
      return NextResponse.json(
        {
          error: "Trustline PHASELQ no encontrada.",
          code: "TRUSTLINE_REQUIRED",
          detail: `Tu wallet ${userAddress.slice(0, 8)}... existe pero no tiene trustline para ${asset.code}:${asset.issuer.slice(0, 8)}... ` +
                  `Sin trustline, el ledger de Stellar rechazará cualquier recepción de este asset.`,
          hint: "En la página de Forge, haz clic en 'INITIALIZE PHASER PROTOCOL' para establecer la trustline automáticamente.",
          actionSteps: [
            "1. Ve a la página /forge",
            "2. Conecta tu wallet Freighter",
            "3. Haz clic en 'INITIALIZE PHASER PROTOCOL'",
            "4. Firma la transacción changeTrust en Freighter",
            "5. Vuelve a intentar reclamar del faucet",
          ],
          asset,
        },
        { status: 412 },
      )
    }

    // Validación adicional: verificar que el usuario tenga algo de XLM para fees
    // (aunque el faucet paga el mint, el usuario necesita XLM para operaciones futuras)
    const userXlmRes = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(userAddress)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
    if (userXlmRes.ok) {
      const userData = await userXlmRes.json() as { balances?: Array<{ asset_type?: string; balance?: string }> }
      const nativeBalance = userData.balances?.find(b => b.asset_type === "native")?.balance
      const xlmAmount = nativeBalance ? parseFloat(nativeBalance) : 0
      if (xlmAmount < 1) {
        console.warn(`[faucet] Warning: user ${userAddress.slice(0, 8)}... has only ${xlmAmount} XLM. Consider funding more.`)
      }
    }
  } catch (e) {
    // Horizon intermitente: loggear pero no bloqueamos el mint
    console.warn("[faucet] Horizon check failed, proceeding anyway:", e instanceof Error ? e.message : String(e))
    return null
  }
  return null
}

/**
 * PHASELQ al usuario:
 * - **mint** (por defecto): firma `ADMIN_SECRET_KEY` — en el Stellar Asset Contract debe ser el **Issuer** (G… del asset), no un distribuidor.
 * - **transfer** (opcional): si existe `FAUCET_DISTRIBUTOR_SECRET_KEY`, se llama `transfer(distribuidor → usuario)`; el distribuidor debe tener saldo y XLM para fees.
 *
 * Body: `{ "walletAddress": "G…", "reward": "genesis|daily|quest_*" }`
 */
export async function POST(req: NextRequest) {
  if (!faucetConfigured()) {
    return NextResponse.json(
      {
        error:
          "Faucet desactivado: define ADMIN_SECRET_KEY (mint como issuer del SAC) o FAUCET_DISTRIBUTOR_SECRET_KEY (transfer desde billetera con liquidez). Reinicia el servidor.",
        code: "FAUCET_NOT_CONFIGURED",
      },
      { status: 503 },
    )
  }

  let body: { walletAddress?: string; userAddress?: string; reward?: string; referralCode?: string; turnstileToken?: string; hashcashProof?: string }
  try {
    body = (await req.json()) as { walletAddress?: string; userAddress?: string; reward?: string; referralCode?: string; turnstileToken?: string; hashcashProof?: string }
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 })
  }

  const userAddress = (body.walletAddress ?? body.userAddress)?.trim()
  if (!userAddress || !StrKey.isValidEd25519PublicKey(userAddress)) {
    return NextResponse.json(
      { error: "walletAddress (o userAddress) debe ser una cuenta Stellar G válida." },
      { status: 400 },
    )
  }

  // Triple check #1: Check deny-list (governance veto)
  if (await isWalletDenied(userAddress)) {
    return NextResponse.json(
      {
        error: "Esta wallet ha sido excluida del faucet por gobernanza.",
        code: "WALLET_DENIED",
        detail: "Contacta al equipo PHASE si crees que esto es un error.",
      },
      { status: 403 },
    )
  }

  // Triple check #2: Turnstile bot check (client-side Cloudflare challenge)
  if (turnstileSiteKeyConfigured()) {
    if (!body.turnstileToken) {
      return NextResponse.json(
        {
          error: "Turnstile token requerido.",
          code: "TURNSTILE_REQUIRED",
          detail: "Ejecuta el desafío Cloudflare Turnstile en el cliente antes de enviar.",
        },
        { status: 400 },
      )
    }
    try {
      const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || undefined
      const turnstileOk = await verifyTurnstileToken(body.turnstileToken, clientIp)
      if (!turnstileOk) {
        return NextResponse.json(
          { error: "Turnstile check failed.", code: "TURNSTILE_FAILED" },
          { status: 403 },
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error"
      return NextResponse.json(
        { error: `Turnstile verification failed: ${msg}`, code: "TURNSTILE_ERROR" },
        { status: 500 },
      )
    }
  }

  // Triple check #3: Sybil resistance score (on-chain wallet history)
  if (isSybilResistanceEnabled()) {
    const sybilScore = await assessWalletSybilRisk(userAddress)
    if (sybilScore && sybilScore.suspect) {
      return NextResponse.json(
        {
          error: "Wallet appears to be new or suspicious. Try again after building more on-chain history.",
          code: "SYBIL_SUSPECT",
          suspectBand: sybilScore.band,
          signals: sybilScore.signals.slice(0, 3),
          detail: "Sybil resistance active: fresh or dormant accounts are rate-limited.",
        },
        { status: 429 },
      )
    }
  }

  /** Cada intento de claim debe ver el ledger al día (p. ej. acabas de hacer settle). */
  questProgressCache.delete(userAddress)

  const reward = parseRewardType(body.reward)
  const claims = await readClaims()
  const walletClaim = claims[userAddress] ?? {}

  if (await isQuestReward(reward)) {
    const q = await evaluateAllQuests(userAddress)
    const quest = q[reward]
    if (!quest || !quest.completed) {
      return NextResponse.json(
        {
          error: `Quest requirement not met: ${quest?.requirementText ?? "Quest not found"}`,
          reward,
          requirementMet: false,
          progressPct: quest?.progressPct ?? 0,
        },
        { status: 412 },
      )
    }
  }

  // phase-132: validate referral code early (before mint) to fail fast
  if (reward === "genesis" && body.referralCode && isReferralQuestEnabled()) {
    const refValidation = await validateReferralCode(body.referralCode, userAddress)
    if (!refValidation.valid) {
      return NextResponse.json(
        { error: refValidation.error ?? "Invalid referral code.", code: "REFERRAL_INVALID" },
        { status: 400 },
      )
    }
  }

  const status = claimStatusForReward(walletClaim, reward, Date.now())
  if (!status.claimable) {
    const already = status.nextAt
      ? "Reward on cooldown. Claim it again after reset."
      : "Reward already claimed for this wallet."
    return NextResponse.json(
      {
        error: already,
        code: status.nextAt ? "FAUCET_COOLDOWN" : "FAUCET_REWARD_ALREADY_CLAIMED",
        reward,
        claimedAt: status.claimedAt,
        nextAt: status.nextAt,
      },
      { status: status.nextAt ? 429 : 409 },
    )
  }

  const trustlineBlock = await preflightClassicTrustlineForMint(userAddress)
  if (trustlineBlock) return trustlineBlock

  const useTransfer = faucetUsesDistributorTransfer()
  let signerKp: Keypair
  if (useTransfer) {
    const distSecret = process.env.FAUCET_DISTRIBUTOR_SECRET_KEY!.trim()
    try {
      signerKp = Keypair.fromSecret(distSecret)
    } catch {
      return NextResponse.json(
        { error: "FAUCET_DISTRIBUTOR_SECRET_KEY no es un secret Stellar válido.", code: "FAUCET_BAD_DISTRIBUTOR_SECRET" },
        { status: 500 },
      )
    }
  } else {
    const adminSecret = process.env.ADMIN_SECRET_KEY?.trim()
    if (!adminSecret || adminSecret.length < 20) {
      return NextResponse.json(
        {
          error: "Falta ADMIN_SECRET_KEY para modo mint, o usa FAUCET_DISTRIBUTOR_SECRET_KEY para modo transfer.",
          code: "FAUCET_ADMIN_MISSING",
        },
        { status: 503 },
      )
    }
    try {
      signerKp = Keypair.fromSecret(adminSecret)
    } catch {
      return NextResponse.json({ error: "ADMIN_SECRET_KEY no es un secret Stellar válido." }, { status: 500 })
    }
  }

  const tokenId = serverTokenContractId()
  warnPhaserLiqSacMismatchOnce(tokenId, "faucet")
  const server = new rpc.Server(RPC_URL)
  const source = signerKp.publicKey()

  // Validación estricta: en modo mint, el signer DEBE ser el issuer del asset clásico
  if (!useTransfer) {
    const sacExpected = expectedClassicPhaserLiqSorobanContractId()
    const issuerG = classicLiqIssuerForStellarToml()

    // Verificar mismatch usando la nueva función de validación
    const issuerValidationError = validateFaucetIssuerConfig(
      process.env.ADMIN_SECRET_KEY,
      issuerG,
    )

    if (issuerValidationError) {
      return NextResponse.json(
        {
          error: issuerValidationError,
          code: "FAUCET_ADMIN_NOT_ISSUER",
          expectedIssuer: issuerG,
          signerPublic: source,
          hint: "Para modo mint, ADMIN_SECRET_KEY debe ser el secret del issuer del asset PHASELQ. " +
                "O configura FAUCET_DISTRIBUTOR_SECRET_KEY para usar modo transfer.",
        },
        { status: 503 },
      )
    }

    // Validación adicional: verificar que el tokenId coincida con el SAC esperado
    if (tokenId !== sacExpected) {
      console.warn("[faucet] Warning: PHASE_LIQ_TOKEN_CONTRACT no coincide con el SAC derivado del asset clásico", {
        configured: tokenId,
        expectedFromClassic: sacExpected,
      })
    }
  }

  // Validación estricta de balance XLM antes de intentar cualquier transacción
  const nativeXlm = await fetchNativeXlmBalance(source)
  if (nativeXlm === null) {
    return NextResponse.json(
      {
        error: `No se pudo verificar el balance XLM de la cuenta firmante (${source.slice(0, 8)}...). ` +
               `Asegúrate de que la cuenta exista en testnet y tenga fondos.`,
        code: "FAUCET_SIGNER_ACCOUNT_NOT_FOUND",
        signer: source,
        hint: "Fondea la cuenta con Friendbot: https://friendbot.stellar.org/?addr=" + source,
      },
      { status: 503 },
    )
  }

  if (nativeXlm < MIN_SIGNER_NATIVE_XLM) {
    // Check if we have health status information to provide better context
    let healthContext = ""
    if (useTransfer) {
      try {
        const { getDistributorHealthStatus } = await import("@/lib/distributor-health-store")
        const healthStatus = await getDistributorHealthStatus()
        if (healthStatus) {
          healthContext = ` Sistema de auto-refill está ${healthStatus.status === "healthy" ? "activo" : "en alerta"}. ` +
                         `Última verificación: ${new Date(healthStatus.checkedAt).toLocaleString()}.`
        }
      } catch {
        // Health status is optional enhancement
      }
    }

    return NextResponse.json(
      {
        error: `La cuenta firmante tiene solo ${nativeXlm.toFixed(2)} XLM, pero se requieren al menos ${MIN_SIGNER_NATIVE_XLM} XLM ` +
               `para pagar fees de Soroban y renta de almacenamiento. Sin suficiente XLM, las transacciones fallan con ` +
               `"trap" o "ihf_trapped" (insufficient balance para fees).${healthContext}`,
        code: "FAUCET_SIGNER_LOW_XLM",
        signer: source,
        nativeXlmApprox: nativeXlm,
        minRequiredXlm: MIN_SIGNER_NATIVE_XLM,
        hint: `Fondea la cuenta ${source.slice(0, 8)}... con al menos ${MIN_SIGNER_NATIVE_XLM - nativeXlm + 1} XLM más usando Friendbot.`,
      },
      { status: 503 },
    )
  }

  try {
    // phase-133: auto-top-up distributor if balance is low (fire-and-forget, non-blocking)
    if (isDistributorTopupEnabled() && useTransfer) {
      void prepareTopup(source).then((topup) => {
        if (topup.shouldTopup) {
          console.log(`[faucet] phase-133 distributor auto-top-up: ${topup.reason}`)
        }
      }).catch(() => {})
    }

    const now = Date.now()
    let liveClaims = await readClaims()
    let row: WalletClaims = { ...(liveClaims[userAddress] ?? {}) }

    if (row.faucetPending && now - row.faucetPending.at > FAUCET_PENDING_TTL_MS) {
      row = { ...row, faucetPending: undefined }
      liveClaims[userAddress] = row
      await writeClaims(liveClaims)
    }

    if (row.faucetPending?.reward === reward) {
      const pendingHash = row.faucetPending.hash
      const out = await pollSubmittedMint(server, pendingHash)
      if (out.outcome === "SUCCESS") {
        await markClaim(userAddress, reward)
        let streakInfo: StreakInfo | undefined
        if (reward === "daily") {
          const recorded = await recordDailyClaim(userAddress)
          streakInfo = recorded
        }
        // phase-132: record referral bonus on genesis claim
        let referralBonus: string | null = null
        if (reward === "genesis" && body.referralCode && isReferralQuestEnabled()) {
          const refResult = await recordReferral(body.referralCode, userAddress)
          referralBonus = refResult.bonus
        }
        return NextResponse.json({
          ok: true,
          hash: pendingHash,
          reward,
          amountStroops: rewardAmountStroops(reward),
          ...(streakInfo ? { streak: streakInfo } : {}),
          ...(referralBonus ? { referralBonus } : {}),
        })
      }
      if (out.outcome === "FAILED") {
        await clearFaucetPendingOnly(userAddress)
        return faucetMintLedgerFailedResponse(pendingHash, out.failed)
      }
      return NextResponse.json(
        {
          ok: false,
          hash: pendingHash,
          pending: true,
          reward,
          amountStroops: rewardAmountStroops(reward),
          note: "Transaction still pending on ledger. Retry the same reward in a few seconds.",
        },
        { status: 202 },
      )
    }

    if (row.faucetPending && row.faucetPending.reward !== reward) {
      return NextResponse.json(
        {
          error:
            "Hay otra recompensa de faucet confirmándose en ledger. Espera unos segundos y vuelve a intentar esta recompensa.",
          code: "FAUCET_MINT_IN_PROGRESS",
          reward,
          blockingReward: row.faucetPending.reward,
        },
        { status: 409 },
      )
    }

    let account: Awaited<ReturnType<typeof server.getAccount>>
    try {
      account = await server.getAccount(source)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/not found/i.test(msg)) {
        return NextResponse.json(
          {
            error:
              "La cuenta que firma el faucet no existe en testnet (o el RPC no la encuentra). " +
              "Comprueba ADMIN_SECRET_KEY / FAUCET_DISTRIBUTOR_SECRET_KEY y fondea esa G con Friendbot.",
            code: "FAUCET_SIGNER_ACCOUNT_NOT_FOUND_RPC",
            detail: msg,
            signer: source,
            hint: `https://friendbot.stellar.org/?addr=${encodeURIComponent(source)}`,
          },
          { status: 503 },
        )
      }
      throw e
    }
    const c = new Contract(tokenId)
    // phase-131: apply streak multiplier to daily reward amount
    let effectiveAmountStroops = rewardAmountStroops(reward)
    if (reward === "daily" && isStreakMultiplierEnabled()) {
      const streak = await getStreakInfo(userAddress)
      if (streak.multiplier > 1) {
        effectiveAmountStroops = applyStreakMultiplier(effectiveAmountStroops, streak.multiplier)
      }
    }
    const amountSc = nativeToScVal(BigInt(effectiveAmountStroops), { type: "i128" })
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        useTransfer
          ? c.call(
              "transfer",
              Address.fromString(source).toScVal(),
              Address.fromString(userAddress).toScVal(),
              amountSc,
            )
          : c.call("mint", Address.fromString(userAddress).toScVal(), amountSc),
      )
      .setTimeout(30)
      .build()

    const prepared = await server.prepareTransaction(tx)
    prepared.sign(signerKp)
    const send = await server.sendTransaction(prepared)
    if (send.status === "ERROR") {
      const err = (send as { errorResult?: unknown }).errorResult
      return NextResponse.json(
        { error: "RPC rechazó la transacción.", detail: String(err ?? send) },
        { status: 502 },
      )
    }
    const hash = send.hash as string

    liveClaims = await readClaims()
    liveClaims[userAddress] = {
      ...(liveClaims[userAddress] ?? {}),
      faucetPending: { hash, reward, at: Date.now() },
    }
    await writeClaims(liveClaims)

    const out = await pollSubmittedMint(server, hash)
    if (out.outcome === "SUCCESS") {
      await markClaim(userAddress, reward)
      let streakInfo: StreakInfo | undefined
      if (reward === "daily") {
        const recorded = await recordDailyClaim(userAddress)
        streakInfo = recorded
      }
      // phase-132: record referral bonus on genesis claim
      let referralBonus: string | null = null
      if (reward === "genesis" && body.referralCode && isReferralQuestEnabled()) {
        const refResult = await recordReferral(body.referralCode, userAddress)
        referralBonus = refResult.bonus
      }
      return NextResponse.json({
        ok: true,
        hash,
        reward,
        amountStroops: effectiveAmountStroops,
        ...(streakInfo ? { streak: streakInfo } : {}),
        ...(referralBonus ? { referralBonus } : {}),
      })
    }
    if (out.outcome === "FAILED") {
      await clearFaucetPendingOnly(userAddress)
      return faucetMintLedgerFailedResponse(hash, out.failed)
    }
    return NextResponse.json(
      {
        ok: false,
        hash,
        pending: true,
        reward,
        amountStroops: rewardAmountStroops(reward),
        note: "Transaction still pending on ledger. Retry the same reward in a few seconds.",
      },
      { status: 202 },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
