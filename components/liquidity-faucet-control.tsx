"use client"

import { albedoImplicitTxAllowed, isAlbedoSelectedInKit } from "@/lib/albedo-intent-client"
import { isXBullSelected } from "@/lib/xbull-adapter"
import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { isHardwareWalletSelected, signTransaction } from "@/lib/stellar-wallet-kit"

import { toast } from "sonner"
import { useLang } from "@/components/lang-context"
import { TokenIcon } from "@/components/token-icon"
import {
  buildClassicTrustlineTransactionXdr,
  parseSignedTxXdr,
} from "@/lib/classic-liq"
import { humanizePhaseHostErrorMessage } from "@/lib/phase-host-error"
import { pickCopy } from "@/lib/phase-copy"
import { extractBaseAddress } from "@stellar/stellar-sdk"
import {
  formatLiq,
  getPublicClassicLiqIssuerG,
  isPhaseUnauthorizedError,
  NETWORK_PASSPHRASE,
  stellarExpertTestnetContractUrl,
} from "@/lib/phase-protocol"
import { playTacticalUiClick } from "@/lib/tactical-ui-click"
import { cn } from "@/lib/utils"
import { albedoRetiredSignMessage, isAlbedoRetired } from "@/lib/albedo-sunset"

function comparableStellarAccountG(addr: string): string {
  const t = addr.trim()
  if (!t) return ""
  try {
    return extractBaseAddress(t).trim().toUpperCase()
  } catch {
    return t.toUpperCase()
  }
}

type RewardType = "genesis" | "daily" | "quest_connect_wallet" | "quest_first_collection" | "quest_first_settle"

type RewardState = {
  claimable: boolean
  claimedAt: number | null
  nextAt: number | null
  amountStroops: string
  requirementMet?: boolean
  progressPct?: number
  requirementText?: string
}

type FaucetStatusResponse = {
  enabled: boolean
  questOverview?: {
    completed: number
    total: number
    progressPct: number
  }
  rewards?: Partial<Record<RewardType, RewardState>>
}

type ClassicLiqApiWallet = {
  enabled: boolean
  /** Issuer secret no configurado: igual podemos guiar changeTrust vía NEXT_PUBLIC_* + submit trustline. */
  trustlineFlowAvailable?: boolean
  asset?: { code: string; issuer: string }
  status?: { accountExists?: boolean; hasTrustline?: boolean }
}

type RewardFlowPhase = "idle" | "trustline" | "transmit"

type Props = {
  address: string | null | undefined
  tokenBalance: string
  className?: string
  /** Menos padding y márgenes (p. ej. cámara cockpit sin scroll). */
  compact?: boolean
  onNarrativeLog?: (line: string) => void
  onRefreshBalance: () => void | Promise<void>
  /**
   * Cámara / Forja: si el NFT está en custodia del emisor PHASELQ (G…), expone **Collect** → el servidor firma `transfer(issuer → usuario)` (sin `signTransaction` en cliente; sirve con Albedo u otras wallets).
   * Si `owner_of` ya es la wallet conectada, el bloque no se muestra.
   */
  freighterNftCollect?: { tokenId: number } | null
  /**
   * Cámara (columna derecha): oculta el toggle VER/OCULTAR solo de la cadena de misiones;
   * el panel completo se pliega desde el wrapper exterior.
   */
  hideInlineMissionToggle?: boolean
  /** Oculta genesis + daily (p. ej. quests solo bajo el reactor). */
  omitLiquidityLane?: boolean
  /** Oculta QUEST_01..03 (p. ej. columna derecha solo colectar). */
  omitMissionChain?: boolean
  /** Oculta cabecera de progreso + barra (la cámara pone título propio arriba). */
  omitHeader?: boolean
  /** Oculta bloque COLLECT NFT (vive con liquidez en columna derecha). */
  omitFreighterNftBlock?: boolean
}

export function LiquidityFaucetControl({
  address,
  tokenBalance: _tokenBalance,
  className,
  compact = false,
  onNarrativeLog,
  onRefreshBalance,
  freighterNftCollect = null,
  hideInlineMissionToggle = false,
  omitLiquidityLane = false,
  omitMissionChain = false,
  omitHeader = false,
  omitFreighterNftBlock = false,
}: Props) {
  const { lang } = useLang()
  const ch = pickCopy(lang).chamber
  const logs = ch.logs
  const normalizeToastError = useCallback(
    (msg: string) => {
      const h = humanizePhaseHostErrorMessage(msg, ch.phaseHostContractErrors, ch.phaseHostContractUnknown)
      if (h) return h
      return isPhaseUnauthorizedError(msg) ? ch.biometricTrustGateClosed : msg
    },
    [ch.biometricTrustGateClosed, ch.phaseHostContractErrors, ch.phaseHostContractUnknown],
  )

  const [status, setStatus] = useState<FaucetStatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingReward, setLoadingReward] = useState<RewardType | null>(null)
  const [rewardFlowPhase, setRewardFlowPhase] = useState<RewardFlowPhase>("idle")
  const [helpOpen, setHelpOpen] = useState(false)
  /** En compact (Forge lateral) las quests deben verse sin pulsar VER; el botón sigue permitiendo colapsar. */
  const [missionsOpen, setMissionsOpen] = useState(true)
  const [nftCollectBusy, setNftCollectBusy] = useState(false)
  /** null = sin comprobar; loading / resultado de owner on-chain para Collect. */
  const [nftCollectEligibility, setNftCollectEligibility] = useState<
    | null
    | { status: "loading" }
    | { status: "ready"; viewerIsOwner: boolean; onChainOwner: string }
    | { status: "error"; message: string }
  >(null)

  useEffect(() => {
    if (!helpOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false)
    }
    window.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [helpOpen])

  const loadStatus = useCallback(async () => {
    const query = address ? `?walletAddress=${encodeURIComponent(address)}` : ""
    const res = await fetch(`/api/faucet${query}`, { cache: "no-store" })
    const data = (await res.json().catch(() => ({}))) as FaucetStatusResponse
    if (!res.ok) throw new Error("Unable to load faucet status")
    setStatus(data)
  }, [address])

  useEffect(() => {
    void loadStatus().catch(() => setStatus({ enabled: false }))
  }, [loadStatus])

  useEffect(() => {
    if (!address || !freighterNftCollect) {
      setNftCollectEligibility(null)
      return
    }
    let cancelled = false
    setNftCollectEligibility({ status: "loading" })
    ;(async () => {
      const c = pickCopy(lang).chamber
      const maxAttempts = 5
      const delayMs = 550
      try {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (cancelled) return
          if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs))
          const vr = await fetch("/api/phase-nft/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tokenId: freighterNftCollect.tokenId,
              walletAddress: address,
            }),
            cache: "no-store",
          })
          const vd = (await vr.json().catch(() => ({}))) as {
            ok?: boolean
            owner?: string
            viewerIsOwner?: boolean
            code?: string
            detail?: string
            error?: string
          }
          if (cancelled) return
          if (vr.ok) {
            const owner = typeof vd.owner === "string" ? vd.owner.trim() : ""
            if (!owner) {
              setNftCollectEligibility({
                status: "error",
                message: lang === "es" ? "Sin propietario on-chain." : "Missing on-chain owner.",
              })
              return
            }
            setNftCollectEligibility({
              status: "ready",
              viewerIsOwner: Boolean(vd.viewerIsOwner),
              onChainOwner: owner,
            })
            return
          }
          const isNotMinted = vd.code === "NFT_NOT_MINTED"
          if (isNotMinted && attempt + 1 < maxAttempts) continue
          const msg =
            isNotMinted
              ? c.rewardsNftCollectVerifyNotMintedYet
              : vd.detail || vd.error || `HTTP ${vr.status}`
          setNftCollectEligibility({ status: "error", message: msg })
          return
        }
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setNftCollectEligibility({ status: "error", message: msg })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [address, freighterNftCollect, lang])

  const ensureClassicTrustlineForReward = useCallback(async (): Promise<boolean> => {
    if (!address) return true
    const chamber = pickCopy(lang).chamber
    const L = chamber.logs
    let classic: ClassicLiqApiWallet
    try {
      const cr = await fetch(
        `/api/classic-liq?walletAddress=${encodeURIComponent(address)}`,
        { cache: "no-store" },
      )
      classic = (await cr.json().catch(() => ({}))) as ClassicLiqApiWallet
    } catch {
      return true
    }
    const canRunTrustlineFlow =
      Boolean(classic.asset) && (classic.enabled || Boolean(classic.trustlineFlowAvailable))
    if (!canRunTrustlineFlow) return true
    const asset = classic.asset
    if (!asset) return true
    const hasTrustline = Boolean(classic.status?.hasTrustline)
    if (hasTrustline) return true
    if (!classic.status?.accountExists) {
      onNarrativeLog?.(L.classicTrustlineAccountMissing)
      toast.error(chamber.rewardsTrustlineAccountMissing)
      return false
    }
    onNarrativeLog?.(L.classicTrustlineEstablishing)
    if (isXBullSelected()) {
      onNarrativeLog?.("xBull: Confirm trustline in extension/web")
    } else if (isHardwareWalletSelected()) {
      onNarrativeLog?.("Ledger: Review and confirm trustline on hardware device screen")
    } else {
      onNarrativeLog?.(L.classicTrustlineFreighter)
    }

    setRewardFlowPhase("trustline")

    try {
      // Spike 626: retired Albedo never reaches the implicit-session probe.
      if (isAlbedoSelectedInKit() && isAlbedoRetired()) {
        const retiredMsg = albedoRetiredSignMessage()
        onNarrativeLog?.(retiredMsg)
        toast.error(retiredMsg)
        return false
      }
      if (isAlbedoSelectedInKit() && !(await albedoImplicitTxAllowed(address))) {
        onNarrativeLog?.(chamber.rewardsTrustlineAlbedoImplicitRequired)
        toast.error(chamber.rewardsTrustlineAlbedoImplicitRequired)
        return false
      }
      const trustTx = await buildClassicTrustlineTransactionXdr(address, asset)
      const signResult = await signTransaction(trustTx, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address,
      })
      if (signResult.error) {
        onNarrativeLog?.(L.classicTrustlineRejected)
        toast.error(chamber.rewardsTrustlineRejectedToast)
        return false
      }
      const signedXdr = parseSignedTxXdr(signResult)
      if (!signedXdr) {
        onNarrativeLog?.(L.classicTrustlineRejected)
        toast.error(chamber.rewardsTrustlineRejectedToast)
        return false
      }
      const submitRes = await fetch("/api/classic-liq/trustline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedXdr }),
      })
      const submitData = (await submitRes.json().catch(() => ({}))) as { error?: string }
      if (!submitRes.ok) {
        const msg = submitData.error || `HTTP ${submitRes.status}`
        onNarrativeLog?.(`${L.faucetFailPrefix} ${msg}`)
        toast.error(normalizeToastError(msg))
        return false
      }
      onNarrativeLog?.(L.classicTrustlineConfirmed)
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      onNarrativeLog?.(`${L.faucetFailPrefix} ${msg}`)
      toast.error(normalizeToastError(msg))
      return false
    } finally {
      setRewardFlowPhase("idle")
    }
  }, [address, lang, normalizeToastError, onNarrativeLog])

  const request = useCallback(
    async (reward: RewardType) => {
      if (!address || loading || loadingReward) return
      playTacticalUiClick()
      setLoading(true)
      setLoadingReward(reward)
      setRewardFlowPhase("idle")
      onNarrativeLog?.(
        lang === "es"
          ? `[ SOLICITANDO_RECOMPENSA :: ${reward.toUpperCase()} ]`
          : `[ REQUESTING_REWARD :: ${reward.toUpperCase()} ]`,
      )
      try {
        const trustOk = await ensureClassicTrustlineForReward()
        if (!trustOk) {
          await loadStatus()
          return
        }

        setRewardFlowPhase("transmit")
        const res = await fetch("/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: address, reward }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          error?: string
          detail?: string
          ok?: boolean
          pending?: boolean
          note?: string
          hash?: string
          amountStroops?: string
        }
        if (!res.ok) {
          const msg = typeof data.error === "string" ? data.error : `HTTP ${res.status}`
          const detail = typeof data.detail === "string" ? data.detail : undefined
          onNarrativeLog?.(`${logs.faucetFailPrefix} ${msg}${detail ? ` — ${detail}` : ""}`)
          toast.error(normalizeToastError(msg), detail ? { description: detail } : undefined)
          await loadStatus()
          return
        }
        if (data.pending || data.ok === false) {
          const msg =
            typeof data.note === "string"
              ? data.note
              : lang === "es"
                ? "Transacción pendiente en ledger. Reintenta en unos segundos."
                : "Transaction pending on ledger. Retry in a few seconds."
          onNarrativeLog?.(`${logs.tracePrefix} ${msg}`)
          toast.message(msg)
          await loadStatus()
          return
        }
        const amount = formatLiq(data.amountStroops ?? "0")
        const line =
          lang === "es"
            ? `[ RECOMPENSA_ACREDITADA ] +${amount} PHASELQ`
            : `[ REWARD_CREDITED ] +${amount} PHASELQ`
        onNarrativeLog?.(logs.faucetOk)
        onNarrativeLog?.(line)
        if (data.hash) onNarrativeLog?.(`${logs.tracePrefix} ${data.hash}`)
        toast.success(line, {
          icon: <TokenIcon className="h-4 w-4" pulse />,
        })
        await onRefreshBalance()
        await loadStatus()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        onNarrativeLog?.(`${logs.faucetFailPrefix} ${msg}`)
        toast.error(normalizeToastError(msg))
      } finally {
        setLoading(false)
        setLoadingReward(null)
        setRewardFlowPhase("idle")
      }
    },
    [
      address,
      ensureClassicTrustlineForReward,
      lang,
      loadStatus,
      loading,
      loadingReward,
      logs,
      normalizeToastError,
      onNarrativeLog,
      onRefreshBalance,
    ],
  )

  const handleFreighterNftCollect = useCallback(async () => {
    if (!address || !freighterNftCollect) return
    playTacticalUiClick()
    setNftCollectBusy(true)
    try {
      const res = await fetch("/api/phase-nft/custodian-release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenId: freighterNftCollect.tokenId,
          recipientWallet: address,
        }),
        cache: "no-store",
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        hash?: string | null
        error?: string
        detail?: string
        code?: string
      }
      if (!res.ok) {
        const msg =
          data.code === "NOT_ISSUER_CUSTODY"
            ? lang === "es"
              ? "El NFT no está en custodia del emisor configurado (quizá ya está en tu wallet)."
              : "This NFT is not held by the configured issuer (it may already be in your wallet)."
            : data.detail || data.error || `HTTP ${res.status}`
        onNarrativeLog?.(
          lang === "es" ? `[ NFT_COLLECT_FAIL ] ${msg}` : `[ NFT_COLLECT_FAIL ] ${msg}`,
        )
        toast.error(normalizeToastError(msg))
        return
      }
      const hash = typeof data.hash === "string" ? data.hash : undefined
      toast.success(
        lang === "es"
          ? `NFT enviado a tu wallet${hash ? `. Hash: ${hash}` : ""}`
          : `NFT sent to your wallet${hash ? `. Hash: ${hash}` : ""}`,
      )
      if (hash) onNarrativeLog?.(`${logs.tracePrefix} ${hash}`)
      setNftCollectEligibility({
        status: "ready",
        viewerIsOwner: true,
        onChainOwner: address,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(normalizeToastError(msg))
      onNarrativeLog?.(`${logs.faucetFailPrefix} ${msg}`)
    } finally {
      setNftCollectBusy(false)
    }
  }, [
    address,
    freighterNftCollect,
    lang,
    logs.faucetFailPrefix,
    logs.tracePrefix,
    normalizeToastError,
    onNarrativeLog,
  ])

  const statusLabel = useCallback(
    (reward: RewardState | undefined) => {
      if (!reward) return lang === "es" ? "CARGANDO..." : "LOADING..."
      if (reward.requirementMet === false) return lang === "es" ? "BLOQUEADO" : "LOCKED"
      if (reward.claimable) return lang === "es" ? "LISTO" : "READY"
      if (reward.nextAt) {
        const t = new Date(reward.nextAt).toLocaleString(lang === "es" ? "es-ES" : "en-US")
        return `RESET @ ${t}`
      }
      return lang === "es" ? "RECLAMADO" : "CLAIMED"
    },
    [lang],
  )

  const rewardButton = (
    reward: RewardType,
    title: string,
    description: string,
    state: RewardState | undefined,
  ) => {
    const disabled = loading || loadingReward !== null || !state?.claimable
    const isActive = loadingReward === reward
    const trustlineUi = isActive && rewardFlowPhase === "trustline"
    const transmitUi = isActive && rewardFlowPhase === "transmit"
    const pct = Math.max(0, Math.min(100, state?.claimedAt ? 100 : state?.progressPct ?? 0))
    return (
      <div
        className={cn(
          "tactical-interactive-glitch rounded border border-cyan-400/30 bg-cyan-950/10 shadow-[inset_0_1px_0_rgba(34,211,238,0.06)]",
          compact ? "p-2" : "p-2.5",
        )}
      >
        <div className={cn("flex items-start justify-between gap-2", compact ? "mb-1" : "mb-1.5")}>
          <span
            className={cn(
              "font-semibold uppercase leading-tight tracking-[0.18em] text-cyan-100/95",
              compact ? "text-[10px] sm:text-[11px]" : "text-[11px] sm:text-xs",
            )}
          >
            {title}
          </span>
          <span
            className={cn(
              "shrink-0 font-mono font-semibold tabular-nums tracking-tight text-cyan-200/95",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {state ? `+${formatLiq(state.amountStroops)}` : "—"}
            {state ? (
              <span className={cn("ml-1 font-medium text-cyan-400/80", compact ? "text-[10px]" : "text-[11px]")}>
                {ch.rewardsTokenTicker}
              </span>
            ) : null}
          </span>
        </div>
        <p className={cn("leading-snug text-cyan-100/60", compact ? "mb-1.5 text-[10px]" : "mb-2 text-[11px]")}>{description}</p>
        <div className={compact ? "mb-1.5" : "mb-2"}>
          <div className="h-2 w-full overflow-hidden rounded bg-cyan-950/70">
            <div
              className="h-full bg-cyan-300/75 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[10px] uppercase tracking-[0.16em] text-cyan-300/70">
            {lang === "es" ? "PROGRESO" : "PROGRESS"}{" "}
            <span className="tabular-nums">{pct}</span>%
          </p>
          {state?.requirementText && !state.claimedAt ? (
            <p className="mt-1 text-[10px] leading-snug text-gray-400">{state.requirementText}</p>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/75">{statusLabel(state)}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void request(reward).catch(() => {})}
            className={cn(
              "tactical-phosphor text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors",
              trustlineUi && "tactical-reward-trustline-establishing border-violet-600/70 text-violet-100",
              Boolean(state?.claimedAt) &&
                "cursor-not-allowed border border-gray-800 px-3 py-1 text-gray-600 opacity-50",
              !state?.claimedAt &&
                state?.claimable &&
                loadingReward === null &&
                !loading &&
                "cursor-pointer border border-cyan-800 bg-transparent px-3 py-1 text-cyan-100 hover:border-cyan-500 hover:bg-cyan-900/30",
              !state?.claimedAt &&
                (!state?.claimable || loading || loadingReward !== null) &&
                "cursor-not-allowed border border-cyan-950/50 bg-transparent px-3 py-1 text-cyan-600/50 opacity-60",
            )}
          >
            {loadingReward === reward
              ? trustlineUi
                ? ch.rewardsButtonEstablishingTrustline
                : transmitUi
                  ? ch.rewardsButtonTransmittingFunds
                  : lang === "es"
                    ? "PROCESANDO..."
                    : "PROCESSING..."
              : state?.claimedAt
                ? lang === "es"
                  ? "RECLAMADO"
                  : "CLAIMED"
                : lang === "es"
                  ? "RECLAMAR"
                  : "CLAIM"}
          </button>
        </div>
      </div>
    )
  }

  if (!address || status?.enabled === false) return null

  const missionRewards = [
    status?.rewards?.quest_connect_wallet,
    status?.rewards?.quest_first_collection,
    status?.rewards?.quest_first_settle,
  ]
  const missionReadyCount = missionRewards.filter((r) => r?.claimable).length
  const missionClaimedCount = missionRewards.filter((r) => Boolean(r?.claimedAt)).length

  const helpModal =
    helpOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[500] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="liq-rewards-help-title"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
              aria-label={ch.rewardsHelpClose}
              onClick={() => setHelpOpen(false)}
            />
            <div className="relative max-h-[min(85vh,32rem)] w-full max-w-md overflow-y-auto rounded-lg border border-cyan-500/45 bg-[oklch(0.078_0.022_218)] p-4 shadow-[0_0_48px_rgba(34,211,238,0.12)] sm:p-5">
              <div className="mb-3 flex items-start justify-between gap-3 border-b border-cyan-500/20 pb-3">
                <h2
                  id="liq-rewards-help-title"
                  className="tactical-phosphor text-left text-sm font-bold uppercase tracking-[0.2em] text-cyan-100"
                >
                  {ch.rewardsHelpModalTitle}
                </h2>
                <button
                  type="button"
                  onClick={() => setHelpOpen(false)}
                  className="tactical-phosphor shrink-0 rounded border border-cyan-500/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-cyan-200 hover:border-cyan-300 hover:text-white"
                >
                  {ch.rewardsHelpClose}
                </button>
              </div>
              <div className="space-y-4 text-[13px] leading-relaxed text-cyan-100/88">
                <div>
                  <h3 className="mb-1.5 text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">{ch.rewardsHelpLiqTitle}</h3>
                  <p className="whitespace-pre-line text-cyan-100/82">{ch.rewardsHelpLiqBody}</p>
                </div>
                <div>
                  <h3 className="mb-1.5 text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">{ch.rewardsHelpQuestsTitle}</h3>
                  <p className="whitespace-pre-line text-cyan-100/82">{ch.rewardsHelpQuestsBody}</p>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  const showHeader = !omitHeader
  const showLiquidityLane = !omitLiquidityLane
  const showMissionChain = !omitMissionChain
  const issuerG = getPublicClassicLiqIssuerG()
  const showViewerOwnsNft =
    !omitFreighterNftBlock &&
    Boolean(freighterNftCollect && address) &&
    nftCollectEligibility?.status === "ready" &&
    nftCollectEligibility.viewerIsOwner

  const showFreighterBlock =
    !omitFreighterNftBlock &&
    Boolean(freighterNftCollect && address) &&
    nftCollectEligibility?.status === "ready" &&
    !nftCollectEligibility.viewerIsOwner &&
    comparableStellarAccountG(nftCollectEligibility.onChainOwner) === comparableStellarAccountG(issuerG)

  const showCustodyHint =
    !omitFreighterNftBlock &&
    Boolean(freighterNftCollect && address) &&
    nftCollectEligibility?.status === "ready" &&
    !nftCollectEligibility.viewerIsOwner &&
    !showFreighterBlock &&
    comparableStellarAccountG(nftCollectEligibility.onChainOwner) !== comparableStellarAccountG(issuerG)

  return (
    <section
      className={cn(
        "tactical-quest-flow w-full rounded border border-cyan-400/35 bg-slate-950/40 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.05)] backdrop-blur-[2px]",
        compact ? "tactical-quest-flow--compact p-2 sm:p-2.5" : "p-3 sm:p-3.5",
        className,
      )}
    >
      {helpModal}
      {showHeader ? (
        <header className={compact ? "mb-1.5" : "mb-2.5"}>
          <div className="flex items-center justify-between gap-2">
            {hideInlineMissionToggle ? (
              <p className="tactical-phosphor min-w-0 flex-1 text-[10px] uppercase tracking-[0.18em] text-cyan-300/85 sm:text-[11px]">
                {ch.rewardsQuestProgress}{" "}
                <span className="tabular-nums text-cyan-100/95">
                  {status?.questOverview
                    ? `${status.questOverview.completed}/${status.questOverview.total}`
                    : "—/—"}
                </span>
              </p>
            ) : (
              <p className="tactical-phosphor min-w-0 flex-1 text-[11px] uppercase tracking-[0.22em] text-cyan-100 sm:text-xs">
                {ch.rewardsSectionTitle}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                playTacticalUiClick()
                setHelpOpen(true)
              }}
              aria-label={ch.rewardsHelpAria}
              title={ch.rewardsHelpAria}
              className="tactical-interactive-glitch tactical-phosphor flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/50 bg-cyan-950/40 text-sm font-bold text-cyan-200 transition hover:border-cyan-300 hover:bg-cyan-900/50 hover:text-white"
            >
              ?
            </button>
          </div>
          <div className={hideInlineMissionToggle ? "mt-1.5" : compact ? "mt-1" : "mt-2"}>
            <div className={cn("w-full overflow-hidden rounded bg-cyan-950/70", compact ? "h-1.5" : "h-2")}>
              <div
                className="h-full bg-cyan-300/80 transition-all"
                style={{ width: `${status?.questOverview?.progressPct ?? 0}%` }}
              />
            </div>
            {!hideInlineMissionToggle ? (
              <p className={cn("text-[10px] uppercase tracking-[0.16em] text-cyan-300/75", compact ? "mt-1" : "mt-1.5")}>
                {ch.rewardsQuestProgress}{" "}
                <span className="tabular-nums">
                  {status?.questOverview
                    ? `${status.questOverview.completed}/${status.questOverview.total}`
                    : "—/—"}
                </span>
              </p>
            ) : null}
          </div>
        </header>
      ) : (
        <div className={cn("mb-1.5 flex justify-end", compact && "mb-1")}>
          <button
            type="button"
            onClick={() => {
              playTacticalUiClick()
              setHelpOpen(true)
            }}
            aria-label={ch.rewardsHelpAria}
            title={ch.rewardsHelpAria}
            className="tactical-interactive-glitch tactical-phosphor flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cyan-400/50 bg-cyan-950/40 text-xs font-bold text-cyan-200 transition hover:border-cyan-300 hover:bg-cyan-900/50 hover:text-white sm:h-8 sm:w-8 sm:text-sm"
          >
            ?
          </button>
        </div>
      )}
      {freighterNftCollect && address && nftCollectEligibility?.status === "loading" ? (
        <div
          className={cn(
            "mb-2 rounded border border-cyan-500/35 bg-cyan-950/25 px-2 py-2",
            compact && "mb-1.5 py-1.5",
          )}
        >
          <p className="text-[9px] font-semibold uppercase tracking-widest text-cyan-200/90">
            {ch.rewardsNftCollectVerifying}
          </p>
        </div>
      ) : freighterNftCollect && address && nftCollectEligibility?.status === "error" ? (
        <div
          className={cn(
            "mb-2 rounded border border-red-500/40 bg-red-950/20 px-2 py-2",
            compact && "mb-1.5 py-1.5",
          )}
        >
          <p className="text-[9px] font-semibold uppercase tracking-widest text-red-200/95">
            {ch.rewardsNftCollectVerifyFailed}
          </p>
          <p className="mt-1 text-[8px] leading-snug text-red-100/80">{nftCollectEligibility.message}</p>
        </div>
      ) : null}
      {showViewerOwnsNft && freighterNftCollect ? (
        <div
          className={cn(
            "mb-2 rounded border border-emerald-500/40 bg-emerald-950/20 px-2 py-2",
            compact && "mb-1.5 py-1.5",
          )}
        >
          <p className="text-[9px] font-semibold uppercase tracking-widest text-emerald-200/95">
            {ch.rewardsNftInWalletTitle}
          </p>
          <p className="mt-1 text-[9px] leading-snug text-emerald-100/80">
            {lang === "es"
              ? `Token #${freighterNftCollect.tokenId} · contrato PHASE en testnet.`
              : `Token #${freighterNftCollect.tokenId} · PHASE contract on testnet.`}
          </p>
          <a
            href={stellarExpertTestnetContractUrl()}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => playTacticalUiClick()}
            className="tactical-interactive-glitch mt-2 inline-flex border border-emerald-400/50 px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest text-emerald-100 hover:border-emerald-300 hover:text-white"
          >
            {ch.rewardsNftStellarExpertLink}
            <span className="ml-1 text-[0.65em] font-normal opacity-80" aria-hidden>
              ↗
            </span>
          </a>
        </div>
      ) : showFreighterBlock && freighterNftCollect ? (
        <div
          className={cn(
            "mb-2 rounded border border-violet-400/35 bg-violet-950/20 px-2 py-2",
            compact && "mb-1.5 py-1.5",
          )}
        >
          <p className="text-[9px] font-semibold uppercase tracking-widest text-violet-200/90">
            {ch.rewardsNftCollectPanelTitle}
          </p>
          <p className="mt-1 text-[9px] leading-snug text-violet-100/75">
            {ch.rewardsNftCollectPanelBody
              .replace("{tokenId}", String(freighterNftCollect.tokenId))
              .replace("{issuerShort}", issuerG.slice(0, 6))}
          </p>
          <button
            type="button"
            disabled={nftCollectBusy}
            onClick={() => void handleFreighterNftCollect()}
            className="tactical-interactive-glitch mt-2 w-full border border-violet-400/55 py-2 text-[10px] font-bold uppercase tracking-widest text-violet-100 hover:border-violet-300 disabled:opacity-50"
          >
            {nftCollectBusy ? ch.rewardsNftCollectSending : ch.rewardsNftCollectButton}
          </button>
        </div>
      ) : showCustodyHint && freighterNftCollect ? (
        <div
          className={cn(
            "mb-2 rounded border border-violet-500/35 bg-violet-950/20 px-2 py-2",
            compact && "mb-1.5 py-1.5",
          )}
        >
          <p className="text-[9px] font-semibold uppercase tracking-widest text-violet-200/90">
            {lang === "es" ? "NFT · NO EN CUSTODIA DEL EMISOR" : "NFT · NOT IN ISSUER CUSTODY"}
          </p>
          <p className="mt-1 text-[9px] leading-snug text-violet-100/80">
            {ch.rewardsNftNotIssuerCustodyBody.replace("{tokenId}", String(freighterNftCollect.tokenId))}
          </p>
        </div>
      ) : null}
      {showLiquidityLane ? (
        <div className="tactical-quest-flow__lane">
          <p className="tactical-quest-flow__lane-title">{ch.rewardsLiquidityLaneTitle}</p>
          <div className={cn("flex w-full flex-col", compact ? "gap-2" : "gap-3")}>
            {rewardButton(
              "genesis",
              "GENESIS SUPPLY",
              lang === "es" ? "Carga inicial para wallets nuevas." : "Initial bootstrap supply for new wallets.",
              status?.rewards?.genesis,
            )}
            {rewardButton(
              "daily",
              "DAILY RECHARGE",
              lang === "es" ? "Recarga diaria para pruebas en testnet." : "Daily recharge for testnet experimentation.",
              status?.rewards?.daily,
            )}
          </div>
        </div>
      ) : null}
      {showMissionChain ? (
      <div className="tactical-quest-flow__missions">
        <div className="tactical-quest-flow__rail" aria-hidden />
        <div className="flex items-center justify-between gap-2 pl-5">
          <p className="tactical-quest-flow__chain-title">{ch.rewardsMissionChainTitle}</p>
          {compact && !hideInlineMissionToggle ? (
            <button
              type="button"
              onClick={() => {
                playTacticalUiClick()
                setMissionsOpen((o) => !o)
              }}
              className="tactical-interactive-glitch rounded border border-cyan-500/45 bg-cyan-950/25 px-2 py-0.5 text-[9px] uppercase tracking-[0.2em] text-cyan-200 hover:border-cyan-300 hover:text-white"
              aria-expanded={missionsOpen}
            >
              {missionsOpen ? (lang === "es" ? "OCULTAR" : "HIDE") : lang === "es" ? "VER" : "VIEW"}
            </button>
          ) : null}
        </div>
        {compact && !hideInlineMissionToggle && !missionsOpen ? (
          <div className="mt-1 ml-5 rounded border border-cyan-900/45 bg-black/35 px-2 py-1 text-[9px] uppercase tracking-[0.18em] text-cyan-300/85">
            {lang === "es" ? "RESUMEN" : "SUMMARY"} · {missionClaimedCount}/3 ·{" "}
            {lang === "es" ? "LISTAS" : "READY"} {missionReadyCount}
          </div>
        ) : (
          <div className="pl-1">
            <div className="tactical-quest-step">
              {rewardButton(
                "quest_connect_wallet",
                "QUEST_01 · CONNECT",
                lang === "es" ? "Primera conexión de wallet." : "First wallet connection reward.",
                status?.rewards?.quest_connect_wallet,
              )}
            </div>
            <div className="tactical-quest-step">
              {rewardButton(
                "quest_first_collection",
                "QUEST_02 · COLLECTION",
                lang === "es" ? "Crear tu primera colección." : "Create your first collection.",
                status?.rewards?.quest_first_collection,
              )}
            </div>
            <div className="tactical-quest-step">
              {rewardButton(
                "quest_first_settle",
                "QUEST_03 · SETTLEMENT",
                lang === "es" ? "Completar tu primer settlement." : "Complete your first settlement.",
                status?.rewards?.quest_first_settle,
              )}
            </div>
          </div>
        )}
      </div>
      ) : null}
    </section>
  )
}
