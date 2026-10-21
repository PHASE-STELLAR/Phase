"use client"

import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useLang } from "@/components/lang-context"
import { useWallet } from "@/components/wallet-provider"
import { getTokenBalance, formatLiq } from "@/lib/phase-protocol"
import { QrCodeDialog } from "./qr-code-dialog"
import { QrScannerModal } from "./qr-scanner-modal"
import type { ParsedQrPayload } from "@/lib/qr-code"

// ── Types mirroring /api/faucet response ─────────────────────────────────────

type QuestId =
  | "quest_connect_wallet"
  | "quest_first_collection"
  | "quest_first_settle"
  | "quest_first_world"
  | "quest_three_collections"

type RewardId = "genesis" | "daily" | QuestId

type RewardStatus = {
  claimable: boolean
  claimedAt: number | null
  nextAt: number | null
  amountStroops: string
  requirementMet?: boolean
  progressPct?: number
  requirementText?: string
}

type FaucetStatus = {
  enabled: boolean
  dailyWindowMs: number
  questOverview?: { completed: number; total: number; progressPct: number }
  rewards?: Partial<Record<RewardId, RewardStatus>>
  referral?: { code: string | null; totalReferred: number; remainingSlots: number }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stroopsToDisplay(s: string): string {
  return formatLiq(s)
}

function msToCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// ── i18n ─────────────────────────────────────────────────────────────────────

const COPY = {
  en: {
    title: "◈ PHASELQ REWARDS",
    balance: "CURRENT BALANCE",
    unit: "PHASELQ · SEP-41 · TESTNET",
    earned: "EARNED",
    spent: "SPENT",
    streak: "DAILY STREAK",
    claimable: "CLAIMABLE NOW",
    claim: "[ CLAIM ]",
    claiming: "[ CLAIMING... ]",
    claimed: "[ CLAIMED ]",
    cooldown: "[ CLAIMED · ",
    genesis: "GENESIS REWARD",
    daily: "DAILY REWARD",
    quests: "QUESTS",
    activity: "RECENT ACTIVITY",
    noActivity: "No activity yet.",
    connectRequired: "[ CONNECT_WALLET_TO_VIEW_REWARDS ]",
    connect: "[ CONNECT_WALLET ]",
    connecting: "[ CONNECTING... ]",
    notEnabled: "Faucet not configured on this server.",
    questLabels: {
      quest_connect_wallet:   "Connect your wallet",
      quest_first_collection: "Forge or mint in any collection",
      quest_first_settle:     "Complete a Chamber settlement",
      quest_first_world:      "Create a narrative world",
      quest_three_collections:"Mint in 3 different collections",
    } as Record<QuestId, string>,
    questAmounts: {
      quest_connect_wallet:    "+3 PHASELQ",
      quest_first_collection:  "+3 PHASELQ",
      quest_first_settle:      "+3 PHASELQ",
      quest_first_world:       "+5 PHASELQ",
      quest_three_collections: "+5 PHASELQ",
    } as Record<QuestId, string>,
  },
  es: {
    title: "◈ RECOMPENSAS PHASELQ",
    balance: "BALANCE ACTUAL",
    unit: "PHASELQ · SEP-41 · TESTNET",
    earned: "GANADO",
    spent: "GASTADO",
    streak: "RACHA DIARIA",
    claimable: "DISPONIBLE AHORA",
    claim: "[ RECLAMAR ]",
    claiming: "[ RECLAMANDO... ]",
    claimed: "[ RECLAMADO ]",
    cooldown: "[ RECLAMADO · ",
    genesis: "RECOMPENSA GÉNESIS",
    daily: "RECOMPENSA DIARIA",
    quests: "MISIONES",
    activity: "ACTIVIDAD RECIENTE",
    noActivity: "Sin actividad aún.",
    connectRequired: "[ CONECTA_WALLET_PARA_VER_RECOMPENSAS ]",
    connect: "[ CONECTAR_WALLET ]",
    connecting: "[ CONECTANDO... ]",
    notEnabled: "Faucet no configurado en este servidor.",
    questLabels: {
      quest_connect_wallet:    "Conecta tu wallet",
      quest_first_collection:  "Forja o mintea en cualquier colección",
      quest_first_settle:      "Completa un settlement en Chamber",
      quest_first_world:       "Crea un mundo narrativo",
      quest_three_collections: "Mintea en 3 colecciones distintas",
    } as Record<QuestId, string>,
    questAmounts: {
      quest_connect_wallet:    "+3 PHASELQ",
      quest_first_collection:  "+3 PHASELQ",
      quest_first_settle:      "+3 PHASELQ",
      quest_first_world:       "+5 PHASELQ",
      quest_three_collections: "+5 PHASELQ",
    } as Record<QuestId, string>,
  },
} as const

// ── Component ─────────────────────────────────────────────────────────────────

export function FaucetModal() {
  const { lang } = useLang()
  const { address, connecting, connect } = useWallet()
  const t = COPY[lang]

  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<FaucetStatus | null>(null)
  const [balance, setBalance] = useState<string | null>(null)
  const [claimingReward, setClaimingReward] = useState<RewardId | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [qrShareOpen, setQrShareOpen] = useState(false)
  const [qrScanOpen, setQrScanOpen] = useState(false)
  const [scannedReferralCode, setScannedReferralCode] = useState<string | null>(null)

  // Listen for global open event
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener("open-faucet", handler)
    return () => window.removeEventListener("open-faucet", handler)
  }, [])

  // Tick countdown every second while open
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open])

  const loadStatus = useCallback(async () => {
    if (!address) return
    try {
      const res = await fetch(`/api/faucet?walletAddress=${encodeURIComponent(address)}`, {
        cache: "no-store",
      })
      if (!res.ok) return
      setStatus((await res.json()) as FaucetStatus)
    } catch { /* ignore */ }
  }, [address])

  const loadBalance = useCallback(async () => {
    if (!address) return
    try {
      const raw = await getTokenBalance(address)
      setBalance(raw)
    } catch { /* ignore */ }
  }, [address])

  useEffect(() => {
    if (!open || !address) return
    void loadStatus()
    void loadBalance()
  }, [open, address, loadStatus, loadBalance])

  async function handleClaim(rewardId: RewardId) {
    if (!address || claimingReward) return
    setClaimingReward(rewardId)
    try {
      const payload: Record<string, any> = { walletAddress: address, reward: rewardId }
      if (rewardId === "genesis" && scannedReferralCode) {
        payload.referralCode = scannedReferralCode
      }
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (res.ok || res.status === 202) {
        // refresh after claim
        await Promise.all([loadStatus(), loadBalance()])
      }
    } catch { /* ignore */ }
    finally { setClaimingReward(null) }
  }

  const QUEST_IDS: QuestId[] = [
    "quest_connect_wallet",
    "quest_first_collection",
    "quest_first_settle",
    "quest_first_world",
    "quest_three_collections",
  ]

  const rewards = status?.rewards

  function claimButton(rewardId: RewardId, r: RewardStatus | undefined) {
    if (!r) return null
    const isClaiming = claimingReward === rewardId
    if (r.claimedAt && !r.claimable) {
      if (r.nextAt) {
        const remaining = r.nextAt - now
        return (
          <span className="font-mono text-[9px] text-zinc-600">
            {t.cooldown}{msToCountdown(remaining)} ]
          </span>
        )
      }
      return <span className="font-mono text-[9px] text-zinc-600">{t.claimed}</span>
    }
    if (!r.claimable) return null
    return (
      <button
        type="button"
        disabled={isClaiming}
        onClick={() => void handleClaim(rewardId)}
        className="font-mono text-[9px] uppercase tracking-widest text-violet-400 hover:text-violet-200 border border-violet-700/40 hover:border-violet-500 px-2 py-0.5 transition-colors disabled:opacity-50"
      >
        {isClaiming ? t.claiming : t.claim}
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton
        className="max-w-lg w-full p-0 border border-violet-800/30 bg-[#0d0d14] text-zinc-100 overflow-hidden rounded-none"
      >
        <DialogTitle className="sr-only">{t.title}</DialogTitle>

        {/* ── Header ── */}
        <div className="px-6 pt-5 pb-4 border-b border-white/[0.04]">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-violet-400">
            {t.title}
          </p>
        </div>

        {/* ── No wallet ── */}
        {!address && (
          <div className="px-6 py-10 flex flex-col items-center gap-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
              {t.connectRequired}
            </p>
            <button
              type="button"
              onClick={() => void connect().catch(() => {})}
              disabled={connecting}
              className="font-mono text-[10px] uppercase tracking-widest border border-violet-700/40 bg-violet-950/30 px-4 py-2 text-violet-300 hover:border-violet-500 transition-colors disabled:opacity-50"
            >
              {connecting ? t.connecting : t.connect}
            </button>
          </div>
        )}

        {address && (
          <div className="max-h-[80vh] overflow-y-auto divide-y divide-white/[0.04]">

            {/* ── Balance ── */}
            <div className="px-6 py-5">
              <p className="font-mono text-[8px] uppercase tracking-[0.22em] text-zinc-600 mb-2">
                {t.balance}
              </p>
              <p className="font-mono text-4xl font-medium text-zinc-100 leading-none mb-1">
                {balance !== null ? stroopsToDisplay(balance) : "···"}
              </p>
              <p className="font-mono text-[9px] text-violet-500/70 tracking-widest">{t.unit}</p>
            </div>

            {/* ── Claimable now ── */}
            <div className="px-6 py-4">
              <p className="font-mono text-[8px] uppercase tracking-[0.22em] text-zinc-600 mb-3">
                {t.claimable}
              </p>
              <div className="space-y-2">
                {/* Genesis */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-mono text-[10px] text-zinc-300">{t.genesis}</p>
                    <p className="font-mono text-[9px] text-violet-500">
                      +{stroopsToDisplay(rewards?.genesis?.amountStroops ?? "100000000")} PHASELQ
                    </p>
                  </div>
                  {claimButton("genesis", rewards?.genesis)}
                </div>
                {/* Daily */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-mono text-[10px] text-zinc-300">{t.daily}</p>
                    <p className="font-mono text-[9px] text-violet-500">
                      +{stroopsToDisplay(rewards?.daily?.amountStroops ?? "20000000")} PHASELQ
                    </p>
                  </div>
                  {claimButton("daily", rewards?.daily)}
                </div>
              </div>
            </div>

            {/* ── Referral & QR Share ── */}
            {status?.referral && (
              <div className="px-6 py-4 bg-violet-950/10">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-mono text-[8px] uppercase tracking-[0.22em] text-violet-400">
                    REFERRAL QUEST (PHASE-132 / QR-166)
                  </p>
                  <span className="font-mono text-[8px] text-zinc-500">
                    {status.referral.totalReferred} REFERRED · {status.referral.remainingSlots} SLOTS
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] text-zinc-300 truncate">
                      Code: <strong className="text-violet-300 font-mono">{status.referral.code || "—"}</strong>
                    </p>
                    {scannedReferralCode && (
                      <p className="font-mono text-[9px] text-emerald-400">
                        Friend Code Applied: {scannedReferralCode}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {status.referral.code && (
                      <button
                        type="button"
                        onClick={() => setQrShareOpen(true)}
                        className="px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider border border-violet-700/40 bg-violet-950/30 text-violet-300 hover:border-violet-500 rounded-none transition-colors"
                      >
                        [ SHARE QR ]
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setQrScanOpen(true)}
                      className="px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider border border-zinc-700/60 bg-zinc-900 text-zinc-300 hover:border-violet-500 rounded-none transition-colors"
                    >
                      [ SCAN QR ]
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Quests ── */}
            <div className="px-6 py-4">
              <div className="flex items-center justify-between mb-3">
                <p className="font-mono text-[8px] uppercase tracking-[0.22em] text-zinc-600">
                  {t.quests}
                </p>
                {status?.questOverview && (
                  <span className="font-mono text-[8px] text-zinc-600">
                    {status.questOverview.completed}/{status.questOverview.total}
                  </span>
                )}
              </div>

              {/* Progress bar */}
              {status?.questOverview && (
                <div className="h-px bg-zinc-800 mb-3 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-600 transition-all duration-500"
                    style={{ width: `${status.questOverview.progressPct}%` }}
                  />
                </div>
              )}

              <div className="space-y-2.5">
                {QUEST_IDS.map((qid) => {
                  const r = rewards?.[qid]
                  const done = Boolean(r?.claimedAt) || Boolean(r?.requirementMet)
                  const claimable = Boolean(r?.claimable)
                  return (
                    <div key={qid} className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2 min-w-0">
                        <span
                          className={[
                            "shrink-0 mt-0.5 font-mono text-[10px]",
                            done ? "text-violet-400" : "text-zinc-700",
                          ].join(" ")}
                        >
                          {done ? "✓" : "○"}
                        </span>
                        <div className="min-w-0">
                          <p
                            className={[
                              "font-mono text-[10px]",
                              done && !claimable ? "line-through text-zinc-600" : "text-zinc-300",
                            ].join(" ")}
                          >
                            {t.questLabels[qid]}
                          </p>
                          <p className="font-mono text-[9px] text-violet-500/70">
                            {t.questAmounts[qid]}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0">
                        {claimButton(qid, r)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── Not enabled ── */}
            {status && !status.enabled && (
              <div className="px-6 py-3">
                <p className="font-mono text-[9px] text-zinc-700">{t.notEnabled}</p>
              </div>
            )}

          </div>
        )}

        <QrCodeDialog
          open={qrShareOpen}
          onOpenChange={setQrShareOpen}
          mode="referral"
          referralCode={status?.referral?.code}
        />

        <QrScannerModal
          open={qrScanOpen}
          onOpenChange={setQrScanOpen}
          title="◈ SCAN REFERRAL OR CLAIM QR"
          onScan={(result: ParsedQrPayload) => {
            if (result.type === "referral_code") {
              setScannedReferralCode(result.code)
            } else if (result.type === "raw" && result.text) {
              setScannedReferralCode(result.text)
            }
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
