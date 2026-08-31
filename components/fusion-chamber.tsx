"use client"

import { albedoImplicitTxAllowed, isAlbedoSelectedInKit } from "@/lib/albedo-intent-client"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { signTransaction } from "@/lib/stellar-wallet-kit"
import { toast } from "sonner"
import { IpfsDisplayImg } from "@/components/ipfs-display-img"
import { ArtistAliasControl } from "@/components/artist-alias-control"
import { LangToggle } from "@/components/lang-toggle"
import { useLang } from "@/components/lang-context"
import { LiquidityFaucetControl } from "@/components/liquidity-faucet-control"
import { TokenIcon } from "@/components/token-icon"
import { useWallet } from "@/components/wallet-provider"
import { fetchArtistAlias } from "@/lib/artist-profile-client"
import { humanizePhaseHostErrorMessage } from "@/lib/phase-host-error"
import { pickCopy } from "@/lib/phase-copy"
import { cn } from "@/lib/utils"
import { GatewayHealthDashboard } from "@/components/gateway-health-dashboard"
import {
  buildClassicTrustlineTransactionXdr,
  classicLiqAssetConfigFromPublicEnv,
  parseSignedTxXdr,
  type ClassicLiqWalletStatus,
} from "@/lib/classic-liq"
import type { CollectionInfo } from "@/lib/phase-protocol"
import { extractBaseAddress } from "@stellar/stellar-sdk"
import {
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  PHASER_LIQ_SYMBOL,
  displayPhaserLiqSymbol,
  REQUIRED_AMOUNT,
  TOKEN_ADDRESS,
  buildSettleTransaction,
  buildTransferPhaseNftTransaction,
  checkHasPhased,
  fetchCollectionInfo,
  fetchCollectionSupply,
  fetchCollectionsCatalog,
  fetchPhaseUtilityNftCount,
  fetchTokenOwnerAddress,
  fetchTokenSymbol,
  fetchTokenMetadataDisplay,
  fetchTokenUriString,
  formatLiq,
  getProtocolSettleTokenBalance,
  getPublicClassicLiqIssuerG,
  getTokenBalance,
  getTransactionResult,
  isAuthentic,
  isValidClassicStellarAddress,
  isLowEnergy,
  isPhaseInsufficientBalanceError,
  isPhaseUnauthorizedError,
  isStellarDesyncError,
  sendTransaction,
  stellarExpertPhaserLiqUrl,
  stellarExpertTestnetContractUrl,
  stroopsToLiqDisplay,
} from "@/lib/phase-protocol"
import { PhaseArtifactVisualizer, type ArtifactVerificationMode } from "@/components/phase-artifact-visualizer"
import { TerminalHeader } from "@/components/chamber/terminal-header"
import { ArtifactViewer } from "@/components/chamber/artifact-viewer"
import { SettlementWizard } from "@/components/chamber/settlement-wizard"
import { EnergyGaugeDisplay } from "@/components/chamber/energy-gauge-display"
import { CertificateExporter } from "@/components/chamber/certificate-exporter"
import { useChamberSettlement } from "@/components/chamber/use-chamber-settlement"
import { ChamberLogStream } from "@/components/chamber/log-stream"
import { ChamberCatalogThumb } from "@/components/chamber/catalog-thumb"
import { PhaserLiqTokenLink } from "@/components/chamber/phaser-liq-token-link"
import { chamberChromeNav, chamberChromeNavHere, chamberChromePrimaryBtn, chamberChromeRefreshBtn } from "@/components/chamber/chamber-chrome"

/** Primer `G…` válido en el texto del portapapeles (una línea o varias). */
function recipientGFromClipboardText(text: string, isValidG: (addr: string) => boolean): string {
  const u = text.trim()
  if (isValidG(u)) return u
  for (const line of u.split("\n")) {
    const t = line.trim()
    if (isValidG(t)) return t
  }
  return ""
}
import { TacticalCornerSigil } from "@/components/tactical-corner-sigil"
import { playTacticalUiClick } from "@/lib/tactical-ui-click"
import { viewerSignatureShort } from "@/lib/viewer-signature"

type PaymentPhase = "idle" | "busy" | "error"

function truncateAddress(addr: string) {
  if (!addr || addr.length < 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function formatPowerBp(bp: number) {
  const safeBp = Math.min(10_000, Math.max(0, bp))
  return `${Math.round(safeBp / 100)}%`
}





/** Enlace al asset PHASELQ en Stellar Expert (icono + símbolo). */


/** Same zinc / violet chrome as `/dashboard` (Phase Market). */


export function FusionChamber() {
  const router = useRouter()
  const { lang } = useLang()
  const ch = pickCopy(lang).chamber
  const nav = pickCopy(lang).nav
  const dash = pickCopy(lang).dashboard

  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back()
    } else {
      router.push("/")
    }
  }, [router])

  const searchParams = useSearchParams()
  const collectionId = useMemo(() => {
    const raw = searchParams.get("collection")
    if (raw == null || raw === "") return 0
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }, [searchParams])

  const { address, connect, disconnect, connecting, refresh, openWalletPicker, artistAlias } = useWallet()
  const logEndModalRef = useRef<HTMLDivElement>(null)
  const logEndDockRef = useRef<HTMLDivElement>(null)
  const logId = useRef(0)
  const [lines, setLines] = useState<{ id: number; text: string }[]>([])

  /** Stroops en el SAC que el contrato PHASE usa en `settle` (puede ser 0 con saldo en otro emisor). */
  const [tokenBalance, setTokenBalance] = useState("0")
  /** Máximo PHASELQ visto (Horizon + SACs) — solo informativo si difiere de `tokenBalance`. */
  const [walletLiqTotal, setWalletLiqTotal] = useState("0")
  const [hasPhased, setHasPhased] = useState<boolean | null>(null)
  const [phaseId, setPhaseId] = useState<number | null>(null)
  const [energyLevelBp, setEnergyLevelBp] = useState<number | null>(null)

  const [x402Tx, setX402Tx] = useState<PaymentPhase>("idle")
  const [genesisLoading, setGenesisLoading] = useState(false)
  const [faucetEnabled, setFaucetEnabled] = useState<boolean | null>(null)
  const [systemDesync, setSystemDesync] = useState(false)
  /** Pedestal: acuñación NFT de fase en curso */
  const [mintingArtifact, setMintingArtifact] = useState(false)
  /** THE_REACTOR: POST /api/phase-nft/custodian-release (mismo flujo que el panel COLLECT). */
  const [claimToWalletBusy, setClaimToWalletBusy] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [operatorModalOpen, setOperatorModalOpen] = useState(false)
  const [collectionInfo, setCollectionInfo] = useState<CollectionInfo | null>(null)
  const [collectionLoadState, setCollectionLoadState] = useState<"idle" | "loading" | "done">("idle")
  /** `image` parseado de `token_uri` on-chain (colección 0 o refuerzo). */
  const [artifactImageFromUri, setArtifactImageFromUri] = useState<string | null>(null)
  /** `owner_of(phaseId)` — verificación de originalidad vs wallet conectada. */
  const [onChainTokenOwner, setOnChainTokenOwner] = useState<string | null>(null)
  const [tokenOwnerLookupDone, setTokenOwnerLookupDone] = useState(false)
  /** `balance(wallet)` en contrato PHASE (recuento NFT utilidad). */
  const [phaseLedgerNftCount, setPhaseLedgerNftCount] = useState<string | null>(null)
  const [phaseLedgerNftCountDone, setPhaseLedgerNftCountDone] = useState(false)
  const [tokenUriLookupDone, setTokenUriLookupDone] = useState(false)
  const [tokenUriExists, setTokenUriExists] = useState(false)
  const [freighterIndexPingBusy, setFreighterIndexPingBusy] = useState(false)
  const [freighterTransferBusy, setFreighterTransferBusy] = useState(false)
  const [freighterTransferTo, setFreighterTransferTo] = useState("")
  const [freighterSep50Busy, setFreighterSep50Busy] = useState(false)
  const [freighterSep50Report, setFreighterSep50Report] = useState<string | null>(null)
  const [collectionSupply, setCollectionSupply] = useState<{ minted: number; cap: number } | null>(null)
  const [chainTokenSymbol, setChainTokenSymbol] = useState(PHASER_LIQ_SYMBOL)
  const [balanceGlitch, setBalanceGlitch] = useState(false)
  const prevBalanceRef = useRef<string | null>(null)
  const classicAsset = useMemo(() => classicLiqAssetConfigFromPublicEnv(), [])
  const [classicEnabled, setClassicEnabled] = useState(false)
  const [classicBootstrapAmount, setClassicBootstrapAmount] = useState<string>("0")
  const [classicFundedAt, setClassicFundedAt] = useState<number | null>(null)
  const [classicStatus, setClassicStatus] = useState<ClassicLiqWalletStatus | null>(null)
  const [classicBusy, setClassicBusy] = useState(false)

  const [worldData, setWorldData] = useState<{ world_name: string; world_prompt: string } | null>(null)
  const [narrativeData, setNarrativeData] = useState<string | null>(null)
  const [narrativeLoading, setNarrativeLoading] = useState(false)

  const effectivePriceStroops = useMemo(() => {
    if (collectionId > 0 && collectionInfo?.price) return collectionInfo.price
    return REQUIRED_AMOUNT
  }, [collectionId, collectionInfo])

  const isCreatorCurrentCollection = useMemo(() => {
    if (!address || !collectionInfo?.creator) return false
    return address.trim().toUpperCase() === collectionInfo.creator.trim().toUpperCase()
  }, [address, collectionInfo?.creator])

  const invalidCollection =
    collectionId > 0 && collectionLoadState === "done" && collectionInfo == null

  useEffect(() => {
    if (collectionId <= 0) {
      setCollectionInfo(null)
      setCollectionLoadState("done")
      return
    }
    let cancelled = false
    setCollectionLoadState("loading")
    void fetchCollectionInfo(collectionId)
      .then((info) => {
        if (cancelled) return
        setCollectionInfo(info)
        setCollectionLoadState("done")
      })
      .catch(() => {
        if (!cancelled) setCollectionLoadState("done")
      })
    return () => {
      cancelled = true
    }
  }, [collectionId])

  useEffect(() => {
    setArtifactImageFromUri(null)
  }, [collectionId])

  useEffect(() => {
    if (!phaseId || phaseId <= 0) {
      setOnChainTokenOwner(null)
      setTokenOwnerLookupDone(true)
      return
    }
    let cancelled = false
    setTokenOwnerLookupDone(false)
    void fetchTokenOwnerAddress(CONTRACT_ID, phaseId)
      .then((owner) => {
        if (!cancelled) {
          setOnChainTokenOwner(owner)
          setTokenOwnerLookupDone(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOnChainTokenOwner(null)
          setTokenOwnerLookupDone(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [phaseId])

  useEffect(() => {
    if (!address) {
      setPhaseLedgerNftCount(null)
      setPhaseLedgerNftCountDone(false)
      return
    }
    let cancelled = false
    setPhaseLedgerNftCountDone(false)
    void fetchPhaseUtilityNftCount(address)
      .then((c) => {
        if (!cancelled) {
          setPhaseLedgerNftCount(c)
          setPhaseLedgerNftCountDone(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhaseLedgerNftCount("0")
          setPhaseLedgerNftCountDone(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [address, hasPhased, phaseId])

  useEffect(() => {
    if (!hasPhased || phaseId == null || phaseId <= 0) {
      setArtifactImageFromUri(null)
      setTokenUriLookupDone(true)
      setTokenUriExists(false)
      return
    }
    let cancelled = false
    setTokenUriLookupDone(false)
    setTokenUriExists(false)
    void fetchTokenUriString(phaseId)
      .then(async (raw) => {
        if (cancelled) return
        const hasUri = Boolean(raw && raw.trim().length > 0)
        setTokenUriExists(hasUri)
        if (hasUri && raw) {
          const { image } = await fetchTokenMetadataDisplay(raw)
          if (cancelled) return
          if (image && image.trim().length > 0) setArtifactImageFromUri(image.trim())
        }
        setTokenUriLookupDone(true)
      })
      .catch(() => {
        if (cancelled) return
        setTokenUriExists(false)
        setTokenUriLookupDone(true)
      })
    return () => {
      cancelled = true
    }
  }, [hasPhased, phaseId])

  // Fetch world config + narrative when a token inside a world-enabled collection loads.
  useEffect(() => {
    const cid = collectionId
    const tid = phaseId
    if (!cid || cid <= 0 || !tid || tid <= 0) {
      setWorldData(null)
      setNarrativeData(null)
      return
    }
    let cancelled = false

    async function loadWorldNarrative() {
      // 1. Fetch world config
      let world: { world_name: string; world_prompt: string } | null = null
      try {
        const res = await fetch(`/api/world/${cid}`, { cache: "no-store" })
        if (res.ok) {
          const json = (await res.json()) as { world: typeof world }
          world = json.world
        }
      } catch {
        /* no world — silent */
      }
      if (cancelled) return
      setWorldData(world)
      if (!world) return

      // 2. Check for existing narrative
      let existing: string | null = null
      try {
        const res = await fetch(`/api/world/narrative/${tid}`, { cache: "no-store" })
        if (res.ok) {
          const json = (await res.json()) as { narrative: { narrative: string } | null }
          existing = json.narrative?.narrative ?? null
        }
      } catch {
        /* silent */
      }
      if (cancelled) return
      if (existing) {
        setNarrativeData(existing)
        return
      }

      // 3. Lazy-generate narrative on first chamber load for this token
      setNarrativeLoading(true)
      try {
        // Fetch lore from metadata API (description field)
        let loreText = ""
        try {
          const metaRes = await fetch(`/api/metadata/${tid}`, { cache: "no-store" })
          if (metaRes.ok) {
            const meta = (await metaRes.json()) as { description?: string }
            loreText = meta.description?.trim() ?? ""
          }
        } catch {
          /* lore optional */
        }
        if (cancelled) return

        const narRes = await fetch("/api/narrator", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token_id: tid, collection_id: cid, lore: loreText }),
        })
        if (narRes.ok) {
          const json = (await narRes.json()) as { narrative?: string }
          if (!cancelled && json.narrative) setNarrativeData(json.narrative)
        }
      } catch {
        /* narrator offline — no narrative shown */
      } finally {
        if (!cancelled) setNarrativeLoading(false)
      }
    }

    void loadWorldNarrative()
    return () => {
      cancelled = true
    }
  }, [collectionId, phaseId])

  const effectiveArtifactImage = useMemo(() => {
    const fromCol = collectionInfo?.imageUri?.trim() ?? ""
    if (fromCol.length > 0) return fromCol
    return artifactImageFromUri?.trim() ?? ""
  }, [collectionInfo?.imageUri, artifactImageFromUri])

  const [communityCatalog, setCommunityCatalog] = useState<CollectionInfo[]>([])
  const [catalogLoadState, setCatalogLoadState] = useState<"idle" | "loading" | "done">("idle")
  const [creatorAliasByWallet, setCreatorAliasByWallet] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    setCatalogLoadState("loading")
    void fetchCollectionsCatalog()
      .then((list) => {
        if (cancelled) return
        setCommunityCatalog(list)
        setCatalogLoadState("done")
      })
      .catch(() => {
        if (!cancelled) setCatalogLoadState("done")
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (communityCatalog.length === 0) {
      setCreatorAliasByWallet({})
      return
    }
    let cancelled = false
    const uniqueCreators = Array.from(new Set(communityCatalog.map((c) => c.creator).filter(Boolean)))
    void Promise.all(uniqueCreators.map(async (wallet) => ({ wallet, alias: await fetchArtistAlias(wallet) })))
      .then((rows) => {
        if (cancelled) return
        const next: Record<string, string> = {}
        for (const row of rows) {
          if (row.alias) next[row.wallet] = row.alias
        }
        setCreatorAliasByWallet(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [communityCatalog])

  useEffect(() => {
    void fetch("/api/faucet")
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setFaucetEnabled(Boolean(d.enabled)))
      .catch(() => setFaucetEnabled(false))
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchTokenSymbol(TOKEN_ADDRESS)
      .then((symbol) => {
        if (!cancelled && symbol && symbol.trim().length > 0) {
          setChainTokenSymbol(displayPhaserLiqSymbol(symbol))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const appendLog = useCallback((text: string) => {
    const id = logId.current++
    setLines((prev) => [...prev, { id, text }])
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const addr = await refresh()
      if (!addr) {
        setTokenBalance("0")
        setWalletLiqTotal("0")
        setHasPhased(null)
        setPhaseId(null)
        setEnergyLevelBp(null)
        return
      }
      try {
        const [settleBal, totalBal] = await Promise.all([
          getProtocolSettleTokenBalance(addr),
          getTokenBalance(addr),
        ])
        setTokenBalance(settleBal)
        setWalletLiqTotal(totalBal)
      } catch {
        setTokenBalance("0")
        setWalletLiqTotal("0")
      }
      const ph = await checkHasPhased(addr, collectionId)
      setHasPhased(ph.phased)
      setPhaseId(ph.phaseId ?? null)
      setEnergyLevelBp(ph.phased ? (ph.energyLevelBp ?? 10_000) : null)
    } catch {
      setTokenBalance("0")
      setWalletLiqTotal("0")
      setHasPhased(null)
      setPhaseId(null)
      setEnergyLevelBp(null)
    }
  }, [refresh, collectionId])

  useEffect(() => {
    if (!address?.trim()) {
      setTokenBalance("0")
      setWalletLiqTotal("0")
      setHasPhased(null)
      setPhaseId(null)
      setEnergyLevelBp(null)
      setOnChainTokenOwner(null)
      setTokenOwnerLookupDone(false)
      setArtifactImageFromUri(null)
      setTokenUriLookupDone(true)
      setTokenUriExists(false)
      setPhaseLedgerNftCount(null)
      setPhaseLedgerNftCountDone(false)
      setMintingArtifact(false)
      setClaimToWalletBusy(false)
      setX402Tx("idle")
      return
    }
    setHasPhased(null)
    setPhaseId(null)
    setOnChainTokenOwner(null)
    setTokenOwnerLookupDone(false)
    setArtifactImageFromUri(null)
    setTokenUriLookupDone(false)
    setTokenUriExists(false)
    setEnergyLevelBp(null)
    setMintingArtifact(false)
    setClaimToWalletBusy(false)
    setX402Tx("idle")
    void refreshStatus().catch(() => {})
    // refreshStatus is stable for a given collectionId; we only need to re-sync when the connected G-address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit refreshStatus to avoid re-running on collection-only changes
  }, [address])

  const refreshClassicStatus = useCallback(async () => {
    if (!classicAsset) {
      setClassicEnabled(false)
      setClassicStatus(null)
      setClassicFundedAt(null)
      setClassicBootstrapAmount("0")
      return
    }
    if (!address) {
      setClassicEnabled(true)
      setClassicStatus(null)
      setClassicFundedAt(null)
      setClassicBootstrapAmount("0")
      return
    }
    try {
      const res = await fetch(`/api/classic-liq?walletAddress=${encodeURIComponent(address)}`, { cache: "no-store" })
      const data = (await res.json().catch(() => ({}))) as {
        enabled?: boolean
        bootstrapAmount?: string
        fundedAt?: number | null
        status?: ClassicLiqWalletStatus
      }
      setClassicEnabled(Boolean(data.enabled))
      setClassicBootstrapAmount(data.bootstrapAmount ?? "0")
      setClassicFundedAt(typeof data.fundedAt === "number" ? data.fundedAt : null)
      setClassicStatus(data.status ?? null)
    } catch {
      setClassicEnabled(false)
      setClassicStatus(null)
      setClassicFundedAt(null)
      setClassicBootstrapAmount("0")
    }
  }, [address, classicAsset])

  useEffect(() => {
    appendLog(pickCopy(lang).chamber.logs.chamberOnline)
    void refreshStatus().catch(() => {})
  }, [appendLog, refreshStatus, lang])

  useEffect(() => {
    void refreshClassicStatus().catch(() => {})
  }, [refreshClassicStatus])

  useEffect(() => {
    if (!address) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      void refreshStatus().catch(() => {})
      void refreshClassicStatus().catch(() => {})
    }, 12_000)
    return () => window.clearInterval(id)
  }, [address, refreshStatus, refreshClassicStatus])

  useEffect(() => {
    if (!logsOpen) return
    const t = window.setTimeout(() => {
      logEndModalRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
    }, 160)
    return () => window.clearTimeout(t)
  }, [lines, logsOpen])

  useEffect(() => {
    const t = window.setTimeout(() => {
      logEndDockRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
    }, 160)
    return () => window.clearTimeout(t)
  }, [lines])

  useEffect(() => {
    if (!logsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLogsOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [logsOpen])

  useEffect(() => {
    if (!operatorModalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOperatorModalOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [operatorModalOpen])

  useEffect(() => {
    if (!operatorModalOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [operatorModalOpen])

  const handleConnect = async () => {
    const logs = pickCopy(lang).chamber.logs
    appendLog(logs.walletRequest)
    try {
      await connect()
      const addr = await refresh()
      if (addr) {
        appendLog(`${logs.walletLinkedPrefix} ${truncateAddress(addr)}`)
      } else {
        appendLog(logs.walletDenied)
      }
    } catch {
      appendLog(logs.walletDenied)
    }
    void refreshStatus().catch(() => {})
    void refreshClassicStatus().catch(() => {})
  }

  const handleAccessPrivateMetadata = useCallback(async () => {
    try {
      if (phaseId == null || phaseId <= 0) return
      const raw = await fetchTokenUriString(phaseId)
      if (!raw) {
        toast.error(lang === "es" ? "Sin token_uri en cadena." : "No on-chain token_uri.")
        return
      }
      let body = raw
      try {
        body = JSON.stringify(JSON.parse(raw), null, 2)
      } catch {
        /* keep raw string */
      }
      const blob = new Blob([body], { type: "application/json;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      window.open(url, "_blank", "noopener,noreferrer")
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      toast.success(lang === "es" ? "Metadata abierta en nueva pestaña." : "Metadata opened in new tab.")
    } catch {
      toast.error(lang === "es" ? "No se pudo leer metadata on-chain." : "Could not read on-chain metadata.")
    }
  }, [phaseId, lang])

  const handleNarrativeError = useCallback(
    (err: unknown) => {
      const logs = pickCopy(lang).chamber.logs
      const msg = err instanceof Error ? err.message : String(err)
      if (isStellarDesyncError(msg)) {
        setSystemDesync(true)
        appendLog(logs.systemDesync)
        appendLog(`${logs.tracePrefix} ${msg}`)
        return
      }
      if (isPhaseInsufficientBalanceError(msg)) {
        const ch = pickCopy(lang).chamber
        const friendly =
          humanizePhaseHostErrorMessage(msg, ch.phaseHostContractErrors, ch.phaseHostContractUnknown) ||
          ch.phaseHostContractErrors[2] ||
          msg
        const neededLiq = stroopsToLiqDisplay(effectivePriceStroops)
        const haveLiq = stroopsToLiqDisplay(tokenBalance)
        appendLog(`[ INSUFFICIENT_BALANCE ] ${friendly}`)
        appendLog(`[ READOUT ] ${haveLiq} PHASELQ (UI) · need ≥ ${neededLiq} for this collection`)
        appendLog(logs.lowEnergyWarning)
        appendLog(`${logs.tracePrefix} HostError Contract #2 — PhaseError::InsufficientBalance`)
        if (faucetEnabled) {
          appendLog(
            lang === "es"
              ? "[ SUGERENCIA ] Usá el faucet (Genesis o Daily) para PHASELQ en el SAC."
              : "[ HINT ] Use the faucet (Genesis or Daily) for PHASELQ on the SAC.",
          )
        }
        return
      }
      {
        const ch = pickCopy(lang).chamber
        const friendly = humanizePhaseHostErrorMessage(msg, ch.phaseHostContractErrors, ch.phaseHostContractUnknown)
        appendLog(`${logs.runtimeFaultPrefix} ${friendly ?? msg}`)
      }
    },
    [appendLog, lang, effectivePriceStroops, tokenBalance, faucetEnabled, stroopsToLiqDisplay],
  )

  const rebootProcess = () => {
    setSystemDesync(false)
    setX402Tx("idle")
    appendLog(pickCopy(lang).chamber.logs.rebootProcess)
    void refreshStatus().catch(() => {})
    void refreshClassicStatus().catch(() => {})
  }

  const delayLog = async (entries: string[]) => {
    for (const t of entries) {
      await new Promise((r) => setTimeout(r, 650))
      appendLog(t)
    }
  }

  const initiateX402 = async () => {
    const logs = pickCopy(lang).chamber.logs
    if (x402Tx === "busy" || invalidCollection) return

    appendLog(logs.walletKitPickerForSettle)
    const picked = await openWalletPicker()
    if (!picked) {
      appendLog(logs.walletKitPickerDismissed)
      return
    }
    const signerAddress = picked.trim()
    if (!signerAddress) {
      appendLog(logs.walletKitPickerDismissed)
      return
    }

    const bal = await getProtocolSettleTokenBalance(signerAddress)
    const balBigInt = BigInt(bal || "0")
    const requiredBigInt = BigInt(effectivePriceStroops)

    if (balBigInt < requiredBigInt) {
      const balDisplay = stroopsToLiqDisplay(bal)
      const reqDisplay = stroopsToLiqDisplay(effectivePriceStroops)
      appendLog(
        `[ BALANCE_CHECK ] ${signerAddress.slice(0, 6)}… · ${balDisplay} PHASELQ, Required: ${reqDisplay} PHASELQ`,
      )
      appendLog(logs.lowEnergyWarning)
      if (faucetEnabled && balBigInt === BigInt("0")) {
        appendLog(
          lang === "es"
            ? "[ SUGERENCIA ] Esa cuenta tiene 0 PHASELQ en el SAC. Usá el faucet u otra wallet desde el modal."
            : "[ HINT ] That account has 0 PHASELQ on the SAC. Use the faucet or pick another wallet from the modal.",
        )
      }
      return
    }

    try {
      setX402Tx("busy")
      appendLog(logs.x402Initiating)
      await delayLog([logs.receivingChallenge, logs.signingAuth, logs.settlingPayment])
      const invoiceId = Math.floor(Math.random() * 1_000_000)
      const txEnvelope = await buildSettleTransaction(
        signerAddress,
        effectivePriceStroops,
        invoiceId,
        collectionId,
      )
      const signResult = await signTransaction(txEnvelope, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: signerAddress,
      })
      if (signResult.error) throw new Error(signResult.error.message || "SIGN_FAIL")
      const signedXdr =
        (signResult as { signedTxXdr?: string }).signedTxXdr ||
        (signResult as { signedTransaction?: string }).signedTransaction
      if (!signedXdr) throw new Error("NO_SIGNED_XDR")
      setMintingArtifact(true)
      appendLog(logs.mintingNft)
      const sendResult = await sendTransaction(signedXdr)
      appendLog(`${logs.tracePrefix} Transaction sent, hash: ${String(sendResult.hash).slice(0, 16)}...`)

      // Esperar resultado con mejor manejo de errores
      try {
        await getTransactionResult(sendResult.hash as string)
      } catch (txErr) {
        const txMsg = txErr instanceof Error ? txErr.message : String(txErr)
        const ch = pickCopy(lang).chamber
        const friendly = humanizePhaseHostErrorMessage(
          txMsg,
          ch.phaseHostContractErrors,
          ch.phaseHostContractUnknown,
        )
        if (isPhaseInsufficientBalanceError(txMsg)) {
          throw new Error(friendly ?? ch.phaseHostContractErrors[2] ?? txMsg)
        }
        throw txErr
      }

      appendLog(logs.decrypting)
      await new Promise((r) => setTimeout(r, 1100))
      appendLog(logs.x402Ok)
      await refreshStatus()
      setMintingArtifact(false)
      appendLog(logs.forgedOnSettle)
    } catch (e) {
      console.error(e)
      setX402Tx("error")
      handleNarrativeError(e)
    } finally {
      setMintingArtifact(false)
      setX402Tx("idle")
    }
  }

  const handleClaimNftToWallet = useCallback(async () => {
    if (!address || phaseId == null || phaseId <= 0) return
    playTacticalUiClick()
    setClaimToWalletBusy(true)
    const logs = pickCopy(lang).chamber.logs
    try {
      const res = await fetch("/api/phase-nft/custodian-release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenId: phaseId,
          recipientWallet: address.trim(),
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
              ? "El NFT no está en custodia del emisor (quizá ya está en tu wallet)."
              : "This NFT is not held by the configured issuer (it may already be in your wallet)."
            : data.detail || data.error || `HTTP ${res.status}`
        appendLog(`[ NFT_COLLECT_FAIL ] ${msg}`)
        toast.error(msg)
        return
      }
      const hash = typeof data.hash === "string" ? data.hash : undefined
      toast.success(
        lang === "es"
          ? `NFT enviado a tu wallet${hash ? `. Hash: ${hash}` : ""}`
          : `NFT sent to your wallet${hash ? `. Hash: ${hash}` : ""}`,
      )
      if (hash) appendLog(`${logs.tracePrefix} ${hash}`)
      setOnChainTokenOwner(address.trim())
      setTokenOwnerLookupDone(true)
      await refreshStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(msg)
      appendLog(`${logs.faucetFailPrefix} ${msg}`)
    } finally {
      setClaimToWalletBusy(false)
    }
  }, [address, phaseId, lang, appendLog, refreshStatus])

  const lowEnergy = address ? isLowEnergy(tokenBalance, effectivePriceStroops) : false
  const canInitializeGenesisSupply = Boolean(
    address &&
      !(hasPhased && phaseId) &&
      !invalidCollection &&
      faucetEnabled &&
      (() => {
        try {
          return BigInt(tokenBalance || "0") === BigInt("0")
        } catch {
          return tokenBalance === "0"
        }
      })(),
  )

  const showLiqIssuerMismatch = useMemo(() => {
    if (!address) return false
    try {
      return BigInt(walletLiqTotal || "0") > BigInt(tokenBalance || "0")
    } catch {
      return false
    }
  }, [address, walletLiqTotal, tokenBalance])

  const playElectronicClick = useCallback(() => {
    if (typeof window === "undefined") return
    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = "square"
    osc.frequency.setValueAtTime(1300, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(720, ctx.currentTime + 0.06)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.03, ctx.currentTime + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.085)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.09)
    window.setTimeout(() => void ctx.close(), 180)
  }, [])

  useEffect(() => {
    if (!address) {
      prevBalanceRef.current = null
      return
    }
    if (prevBalanceRef.current == null) {
      prevBalanceRef.current = tokenBalance
      return
    }
    if (prevBalanceRef.current !== tokenBalance) {
      prevBalanceRef.current = tokenBalance
      setBalanceGlitch(true)
      playElectronicClick()
      const t = window.setTimeout(() => setBalanceGlitch(false), 420)
      return () => window.clearTimeout(t)
    }
  }, [address, tokenBalance, playElectronicClick])

  const normalizeToastError = useCallback(
    (msg: string) => {
      const h = humanizePhaseHostErrorMessage(msg, ch.phaseHostContractErrors, ch.phaseHostContractUnknown)
      if (h) return h
      return isPhaseUnauthorizedError(msg) ? ch.biometricTrustGateClosed : msg
    },
    [ch.biometricTrustGateClosed, ch.phaseHostContractErrors, ch.phaseHostContractUnknown],
  )

  const requestGenesisSupply = useCallback(async () => {
    if (!address || genesisLoading) return
    setGenesisLoading(true)
    appendLog(ch.logs.genesisSupplyRequested)
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, reward: "genesis" }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        detail?: string
        hash?: string
        pending?: boolean
        ok?: boolean
        note?: string
      }
      if (!res.ok) {
        const msg = typeof data.error === "string" ? data.error : `HTTP ${res.status}`
        const detail = typeof data.detail === "string" ? data.detail : undefined
        appendLog(`${ch.logs.faucetFailPrefix} ${msg}${detail ? ` — ${detail}` : ""}`)
        toast.error(normalizeToastError(msg), detail ? { description: detail } : undefined)
        return
      }
      if (data.pending || data.ok === false) {
        const pendingMsg =
          data.note ||
          (lang === "es"
            ? "Transacción de faucet pendiente en ledger. Reintenta en unos segundos."
            : "Faucet transaction pending on ledger. Retry in a few seconds.")
        appendLog(`${ch.logs.tracePrefix} ${pendingMsg}`)
        toast.message(pendingMsg)
        await refreshStatus()
        return
      }
      appendLog(ch.logs.faucetOk)
      appendLog(ch.logs.genesisTransferComplete)
      if (data.hash) appendLog(`${ch.logs.tracePrefix} ${data.hash}`)
      toast.success(ch.logs.genesisTransferComplete, {
        icon: <TokenIcon className="h-4 w-4" pulse />,
      })
      await refreshStatus()
    } catch (e) {
      appendLog(`${ch.logs.faucetFailPrefix} ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenesisLoading(false)
    }
  }, [address, genesisLoading, appendLog, ch.logs, refreshStatus])

  const requestClassicBootstrap = useCallback(async () => {
    if (!address || classicBusy || !classicAsset) return
    setClassicBusy(true)
    try {
      const res = await fetch("/api/classic-liq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; amount?: string }
      if (!res.ok) {
        const msg = data.error || `HTTP ${res.status}`
        appendLog(`${ch.logs.faucetFailPrefix} ${msg}`)
        toast.error(normalizeToastError(msg))
        await refreshClassicStatus()
        return
      }
      appendLog(
        lang === "es"
          ? `[ CLASSIC_ASSET_FONDEADO ] +${data.amount ?? classicBootstrapAmount} ${classicAsset.code}`
          : `[ CLASSIC_ASSET_FUNDED ] +${data.amount ?? classicBootstrapAmount} ${classicAsset.code}`,
      )
      toast.success(
        lang === "es"
          ? `Asset clásico acreditado: +${data.amount ?? classicBootstrapAmount} ${classicAsset.code}`
          : `Classic asset credited: +${data.amount ?? classicBootstrapAmount} ${classicAsset.code}`,
      )
      await refreshClassicStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendLog(`${ch.logs.faucetFailPrefix} ${msg}`)
      toast.error(normalizeToastError(msg))
    } finally {
      setClassicBusy(false)
    }
  }, [
    address,
    classicAsset,
    classicBootstrapAmount,
    classicBusy,
    appendLog,
    ch.logs.faucetFailPrefix,
    lang,
    normalizeToastError,
    refreshClassicStatus,
  ])

  const enableClassicAssetTrustline = useCallback(async () => {
    if (!address || classicBusy || !classicAsset) return
    setClassicBusy(true)
    try {
      const chCopy = pickCopy(lang).chamber
      if (isAlbedoSelectedInKit() && !(await albedoImplicitTxAllowed(address))) {
        toast.error(chCopy.rewardsTrustlineAlbedoImplicitRequired)
        appendLog(chCopy.rewardsTrustlineAlbedoImplicitRequired)
        return
      }
      const trustTx = await buildClassicTrustlineTransactionXdr(address, classicAsset)
      const signResult = await signTransaction(trustTx, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address,
      })
      if (signResult.error) throw new Error(signResult.error.message || "TRUSTLINE_SIGNATURE_REJECTED")
      const signedXdr = parseSignedTxXdr(signResult)
      if (!signedXdr) throw new Error("NO_SIGNED_TRUSTLINE_XDR")
      const submitRes = await fetch("/api/classic-liq/trustline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedXdr }),
      })
      const submitData = (await submitRes.json().catch(() => ({}))) as { error?: string }
      if (!submitRes.ok) {
        throw new Error(submitData.error || `HTTP ${submitRes.status}`)
      }
      appendLog(
        lang === "es"
          ? `[ TRUSTLINE_ACTIVADA ] ${classicAsset.code}:${truncateAddress(classicAsset.issuer)}`
          : `[ TRUSTLINE_ENABLED ] ${classicAsset.code}:${truncateAddress(classicAsset.issuer)}`,
      )
      toast.success(
        lang === "es" ? "Trustline activada." : "Trustline enabled.",
      )
      await refreshClassicStatus()
      await requestClassicBootstrap()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendLog(`${ch.logs.faucetFailPrefix} ${msg}`)
      toast.error(normalizeToastError(msg))
    } finally {
      setClassicBusy(false)
    }
  }, [
    address,
    classicAsset,
    classicBusy,
    appendLog,
    ch.logs.faucetFailPrefix,
    lang,
    normalizeToastError,
    refreshClassicStatus,
    requestClassicBootstrap,
  ])

  const collectClassicAsset = useCallback(async () => {
    if (!address || !classicAsset || !classicEnabled || classicBusy) return
    if (!classicStatus?.hasTrustline) {
      await enableClassicAssetTrustline()
      return
    }
    if (!classicFundedAt) {
      await requestClassicBootstrap()
    }
  }, [
    address,
    classicAsset,
    classicEnabled,
    classicBusy,
    classicStatus?.hasTrustline,
    classicFundedAt,
    enableClassicAssetTrustline,
    requestClassicBootstrap,
  ])

  const copyClassicAssetForManualAdd = useCallback(async () => {
    if (!classicAsset) return
    const code = displayPhaserLiqSymbol(classicAsset.code)
    const payload = `${code}:${classicAsset.issuer}`
    try {
      await navigator.clipboard.writeText(payload)
      toast.success(
        lang === "es"
          ? "Asset copiado. Pegalo en Freighter para agregarlo manualmente."
          : "Asset copied. Paste it in Freighter to add it manually.",
      )
    } catch {
      toast.error(lang === "es" ? "No se pudo copiar el asset." : "Could not copy asset.")
    }
  }, [classicAsset, lang])

  const copyFreighterCollectibleField = useCallback(
    async (label: string, value: string) => {
      try {
        await navigator.clipboard.writeText(value)
        const preview = value.length > 48 ? `${value.slice(0, 22)}…${value.slice(-10)}` : value
        toast.success(
          lang === "es"
            ? `${label} copiado: ${preview}`
            : `${label} copied: ${preview}`,
        )
      } catch {
        toast.error(
          lang === "es" ? `No se pudo copiar ${label}.` : `Could not copy ${label}.`,
        )
      }
    },
    [lang],
  )

  const copyFreighterCollectibleBundle = useCallback(
    async (contract: string, numericTokenId: string) => {
      const c = pickCopy(lang).chamber
      const payload = `${contract.trim()}\n${numericTokenId.trim()}`
      try {
        await navigator.clipboard.writeText(payload)
        toast.success(c.freighterCopyBundleToast)
      } catch {
        toast.error(lang === "es" ? "No se pudo copiar el bloque para Freighter." : "Could not copy Freighter block.")
      }
    },
    [lang],
  )

  const chamberTitle = useMemo(() => {
    const c = pickCopy(lang).chamber
    if (collectionId > 0 && collectionInfo) {
      return c.titleWithName.replace("{name}", collectionInfo.name).replace("{id}", String(collectionId))
    }
    if (collectionId > 0) return `${c.collectionTitleLoading} #${collectionId}`
    return c.defaultChamberTitle
  }, [lang, collectionId, collectionInfo])

  const collectionPedestalLine = useMemo(() => {
    const c = pickCopy(lang).chamber
    if (collectionId > 0 && collectionInfo) {
      return c.pedestalWithCreator
        .replace("{name}", collectionInfo.name)
        .replace("{addr}", truncateAddress(collectionInfo.creator))
    }
    if (collectionId > 0) return c.pedestalLoading
    return c.pedestalDefault
  }, [lang, collectionId, collectionInfo])

  const artifactCollectionTitle = useMemo(() => {
    const c = pickCopy(lang).chamber
    if (collectionId > 0 && collectionInfo) {
      return `${collectionInfo.name.toUpperCase()} ${c.artifact.sepSuffix}`.trim()
    }
    return undefined
  }, [lang, collectionId, collectionInfo])

  const artifactPublicCollectionName = useMemo(() => {
    const c = pickCopy(lang).chamber
    if (collectionId > 0 && collectionInfo?.name) return collectionInfo.name
    if (collectionId > 0) return `${c.collectionTitleLoading} #${collectionId}`.replace(/\s+/g, " ").trim()
    return c.pedestalDefault
  }, [lang, collectionId, collectionInfo])

  const processing = x402Tx === "busy"
  const phased = Boolean(hasPhased && phaseId)

  useEffect(() => {
    let cancelled = false
    void fetchCollectionSupply(collectionId)
      .then((s) => {
        if (!cancelled) setCollectionSupply(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [collectionId, hasPhased, phaseId])

  const expertUrl = stellarExpertPhaserLiqUrl()
  const isOwnerOnChain =
    phased && phaseId != null && tokenOwnerLookupDone && isAuthentic(address, onChainTokenOwner)
  /** `owner_of` = emisor clásico PHASELQ: el usuario puede usar COLLECT en el panel lateral (servidor firma transfer). */
  const issuerCustodyForCollect = useMemo(() => {
    if (!phased || phaseId == null || phaseId <= 0 || !tokenOwnerLookupDone || !onChainTokenOwner?.trim()) {
      return false
    }
    if (isAuthentic(address, onChainTokenOwner)) return false
    const issuerG = getPublicClassicLiqIssuerG().trim()
    if (!issuerG) return false
    try {
      return (
        extractBaseAddress(onChainTokenOwner).trim().toUpperCase() ===
        extractBaseAddress(issuerG).trim().toUpperCase()
      )
    } catch {
      return false
    }
  }, [address, onChainTokenOwner, phased, phaseId, tokenOwnerLookupDone])
  const authenticityPending = phased && phaseId != null && address != null && !tokenOwnerLookupDone
  const freighterCollectibleReady =
    phased &&
    phaseId != null &&
    phaseId > 0 &&
    tokenOwnerLookupDone &&
    tokenUriLookupDone &&
    Boolean(onChainTokenOwner) &&
    tokenUriExists
  const manualAddEnabled = phased && phaseId != null && phaseId > 0
  /** Freighter “Token ID” = entero, sin `#`; evita confundir con asset `CODE:issuer`. */
  const nftNumericTokenIdStr = useMemo(() => {
    if (phaseId == null || !Number.isFinite(Number(phaseId))) return ""
    return String(Math.max(0, Math.floor(Number(phaseId))))
  }, [phaseId])

  const handleFreighterIndexPing = useCallback(async () => {
    const c = pickCopy(lang).chamber
    const g = address?.trim()
    if (!g || !nftNumericTokenIdStr || freighterIndexPingBusy) return
    const tid = Math.floor(Number(nftNumericTokenIdStr))
    if (!Number.isFinite(tid) || tid <= 0) return
    setFreighterIndexPingBusy(true)
    try {
      const txEnvelope = await buildTransferPhaseNftTransaction(g, g, tid)
      const signResult = await signTransaction(txEnvelope, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: g,
      })
      if (signResult.error) {
        throw new Error(signResult.error.message || "SIGN_FAIL")
      }
      const signedXdr =
        (signResult as { signedTxXdr?: string }).signedTxXdr ||
        (signResult as { signedTransaction?: string }).signedTransaction
      if (!signedXdr) throw new Error("NO_SIGNED_XDR")
      const sendResult = await sendTransaction(signedXdr)
      await getTransactionResult(sendResult.hash as string)
      toast.success(c.freighterIndexPingToastOk)
    } catch (e) {
      console.error(e)
      toast.error(c.freighterIndexPingToastFail)
    } finally {
      setFreighterIndexPingBusy(false)
    }
  }, [address, nftNumericTokenIdStr, freighterIndexPingBusy, lang])

  const runNftTransferToRecipient = useCallback(
    async (clipboardOrPastedText: string) => {
      const c = pickCopy(lang).chamber
      const g = address?.trim()
      const toRaw = recipientGFromClipboardText(clipboardOrPastedText, isValidClassicStellarAddress)
      if (!g || !nftNumericTokenIdStr || freighterTransferBusy) return
      if (!toRaw) {
        toast.error(c.freighterTransferInvalidRecipient)
        return
      }
      let fromG = ""
      let toG = ""
      try {
        fromG = extractBaseAddress(g).trim().toUpperCase()
        toG = extractBaseAddress(toRaw).trim().toUpperCase()
      } catch {
        toast.error(c.freighterTransferInvalidRecipient)
        return
      }
      if (fromG === toG) {
        toast.error(c.freighterTransferSameAddress)
        return
      }
      const tid = Math.floor(Number(nftNumericTokenIdStr))
      if (!Number.isFinite(tid) || tid <= 0) return
      setFreighterTransferBusy(true)
      try {
        const txEnvelope = await buildTransferPhaseNftTransaction(g, toRaw, tid)
        const signResult = await signTransaction(txEnvelope, {
          networkPassphrase: NETWORK_PASSPHRASE,
          address: g,
        })
        if (signResult.error) {
          throw new Error(signResult.error.message || "SIGN_FAIL")
        }
        const signedXdr =
          (signResult as { signedTxXdr?: string }).signedTxXdr ||
          (signResult as { signedTransaction?: string }).signedTransaction
        if (!signedXdr) throw new Error("NO_SIGNED_XDR")
        const sendResult = await sendTransaction(signedXdr)
        await getTransactionResult(sendResult.hash as string)
        toast.success(c.freighterTransferToastOk)
        await refreshStatus().catch(() => {})
      } catch (e) {
        console.error(e)
        toast.error(c.freighterTransferToastFail)
      } finally {
        setFreighterTransferBusy(false)
      }
    },
    [address, nftNumericTokenIdStr, freighterTransferBusy, lang, refreshStatus],
  )

  const handleFreighterTransferFromInput = useCallback(async () => {
    const c = pickCopy(lang).chamber
    if (!address?.trim() || !nftNumericTokenIdStr || freighterTransferBusy) return
    const raw = freighterTransferTo.trim()
    if (!raw) {
      toast.error(c.freighterTransferInvalidRecipient)
      return
    }
    await runNftTransferToRecipient(raw)
  }, [address, nftNumericTokenIdStr, freighterTransferBusy, freighterTransferTo, lang, runNftTransferToRecipient])

  const handleCollectWithWalletKit = useCallback(async () => {
    if (!phaseId || phaseId <= 0) return
    playTacticalUiClick()
    setClaimToWalletBusy(true)
    const logs = pickCopy(lang).chamber.logs
    try {
      let recipient = address?.trim()
      if (!recipient) {
        const picked = await openWalletPicker()
        if (!picked) return
        recipient = picked
      }
      const res = await fetch("/api/phase-nft/custodian-release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: phaseId, recipientWallet: recipient }),
        cache: "no-store",
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean; hash?: string | null; error?: string; detail?: string; code?: string
      }
      if (!res.ok) {
        const msg =
          data.code === "NOT_ISSUER_CUSTODY"
            ? lang === "es"
              ? "El NFT no está en custodia del emisor (quizá ya está en tu wallet)."
              : "This NFT is not held by the configured issuer (it may already be in your wallet)."
            : data.detail || data.error || `HTTP ${res.status}`
        appendLog(`[ NFT_COLLECT_FAIL ] ${msg}`)
        toast.error(msg)
        return
      }
      const hash = typeof data.hash === "string" ? data.hash : undefined
      toast.success(
        lang === "es"
          ? `NFT enviado a tu wallet${hash ? `. Hash: ${hash}` : ""}`
          : `NFT sent to your wallet${hash ? `. Hash: ${hash}` : ""}`,
      )
      if (hash) appendLog(`${logs.tracePrefix} ${hash}`)
      setOnChainTokenOwner(recipient)
      setTokenOwnerLookupDone(true)
      await refreshStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendLog(`[ NFT_COLLECT_ERROR ] ${msg}`)
      toast.error(msg)
    } finally {
      setClaimToWalletBusy(false)
    }
  }, [address, openWalletPicker, phaseId, lang, appendLog, refreshStatus])

  const handleFreighterSep50Check = useCallback(async () => {
    const chCopy = pickCopy(lang).chamber
    if (!nftNumericTokenIdStr || freighterSep50Busy) return
    setFreighterSep50Busy(true)
    setFreighterSep50Report(null)
    try {
      const q = new URLSearchParams({
        contract: CONTRACT_ID,
        tokenId: nftNumericTokenIdStr,
      })
      const res = await fetch(`/api/freighter/sep50-check?${q.toString()}`)
      const data = (await res.json()) as Record<string, unknown>
      setFreighterSep50Report(JSON.stringify(data, null, 2))
      if (data.ok === true && data.sep50Ready === true) {
        toast.success(lang === "es" ? "SEP-50: todas las comprobaciones OK." : "SEP-50: all checks passed.")
      } else if (data.ok === true) {
        toast.message(lang === "es" ? "SEP-50: revisá el informe (algunos ítems fallan)." : "SEP-50: see report (some checks failed).")
      } else {
        toast.error(chCopy.freighterSep50CheckFailToast)
      }
    } catch (e) {
      console.error(e)
      toast.error(chCopy.freighterSep50CheckFailToast)
    } finally {
      setFreighterSep50Busy(false)
    }
  }, [nftNumericTokenIdStr, freighterSep50Busy, lang])

  const artifactVerificationMode: ArtifactVerificationMode = useMemo(() => {
    if (hasPhased && phaseId != null && phaseId > 0 && address) return "verified"
    if (address && hasPhased === null) return "verifying"
    return "locked"
  }, [address, hasPhased, phaseId])

  return (
    <div
      className="tactical-command-root tactical-command-root--chamber tactical-command-root--cockpit tactical-command-root--stable fixed inset-0 z-[100] flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden bg-black font-mono text-foreground"
      suppressHydrationWarning
    >
      <div className="grid-bg pointer-events-none fixed inset-0 z-0 opacity-[0.28]" aria-hidden />
      <div className="tactical-film-grain opacity-[0.055]" aria-hidden />
      <div className="tactical-crt-veil opacity-[0.11]" aria-hidden />
      <div className="tactical-crt-fine opacity-50" aria-hidden />
      <TacticalCornerSigil className="pointer-events-none fixed bottom-2 left-2 z-[200] hidden opacity-70 sm:block" />

      <header className="relative z-[102] flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur-sm md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/" className={chamberChromeNav} onClick={() => playTacticalUiClick()}>
            {nav.home}
          </Link>
          <Link href="/explore" className={chamberChromeNav} onClick={() => playTacticalUiClick()}>
            {lang === "es" ? "Explorar" : "Explore"}
          </Link>
          <Link href="/world" className={chamberChromeNav} onClick={() => playTacticalUiClick()}>
            {lang === "es" ? "Mundos" : "World"}
          </Link>
          <Link href="/forge" className={chamberChromeNav} onClick={() => playTacticalUiClick()}>
            {nav.forge}
          </Link>
          <Link href="/dashboard" className={chamberChromeNav} onClick={() => playTacticalUiClick()}>
            {nav.market}
          </Link>
          <span className={chamberChromeNavHere} aria-current="page">
            {nav.chamber.toUpperCase()}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              playTacticalUiClick()
              void refreshStatus().catch(() => {})
              void refreshClassicStatus().catch(() => {})
              void refresh().catch(() => {})
            }}
            className={chamberChromeRefreshBtn}
          >
            ⟳ {ch.sync}
          </button>
          {!address ? (
            <button
              type="button"
              disabled={connecting}
              onClick={() => {
                playTacticalUiClick()
                void handleConnect().catch(() => {})
              }}
              className="rounded-sm border border-violet-700/60 bg-violet-950/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-violet-300 transition-colors hover:bg-violet-900/40 disabled:opacity-50"
            >
              {connecting ? dash.connecting : dash.connect}
            </button>
          ) : (
            <div className="group flex max-w-[14rem] items-center gap-2 rounded-sm border border-violet-700/40 bg-violet-950/30 px-3 py-1.5">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" aria-hidden />
              <span className="truncate text-[10px] font-medium text-violet-300">{truncateAddress(address)}</span>
              <button
                type="button"
                onClick={() => {
                  playTacticalUiClick()
                  disconnect()
                  appendLog(ch.logs.walletUnlink)
                  void refreshStatus().catch(() => {})
                  void refreshClassicStatus().catch(() => {})
                }}
                className="ml-1 shrink-0 text-[9px] font-bold uppercase text-zinc-500 transition-colors hover:text-red-400"
              >
                {dash.disconnect}
              </button>
            </div>
          )}
          <LangToggle variant="phosphor" />
        </div>
      </header>

      <div className="relative z-[102] shrink-0 border-b border-zinc-800/90 bg-zinc-950/85 px-4 py-2 md:px-6 md:py-2.5">
        <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-zinc-500">
          PHASE · {nav.chamber.toUpperCase()}
        </p>
        <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-zinc-600">{ch.pageHeroSubtitle}</p>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-violet-400/95">{chamberTitle}</p>
      </div>

      <div
        className={cn(
          "relative z-[102] grid min-h-0 flex-1 grid-cols-1 items-stretch gap-0 overflow-hidden md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] [&>*]:min-h-0",
          address
            ? "lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_minmax(12.5rem,17.5rem)] xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_minmax(14rem,18rem)]"
            : "lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]",
        )}
        suppressHydrationWarning
      >
        {/* STATUS_MONITOR */}
        <aside
          className={cn(
            "tactical-cockpit-aside tactical-chamber-aside relative z-[102] flex h-full min-h-0 flex-col overflow-hidden border-zinc-800/90 bg-zinc-950/25 p-3 sm:p-4",
            "max-md:max-h-[min(36dvh,300px)] max-md:overflow-y-auto max-md:overscroll-contain max-md:border-b max-md:border-zinc-800 md:border-r",
          )}
        >
          <h2 className="mb-2 border-b border-zinc-800 pb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-zinc-500">
            {ch.statusMonitor}
          </h2>
          <p className="mb-2 line-clamp-3 text-[9px] leading-relaxed text-zinc-600">{ch.protocolStackLabel}</p>

          {invalidCollection && (
            <div className="tactical-alert-critical relative z-0 mb-4 px-3 py-3">
              <p className="relative z-[1] text-center text-[10px] font-bold uppercase tracking-wider text-red-200">
                ⚠ {ch.invalidCollectionTitle}
              </p>
              <p className="relative z-[1] mt-2 text-center text-[9px] text-red-100/85">
                {ch.invalidCollectionBody.replace("{id}", String(collectionId))}
              </p>
            </div>
          )}

          {systemDesync && (
            <div className="tactical-frame mb-3 border-violet-500/50 bg-violet-950/30 p-2.5 shadow-[0_0_16px_rgba(139,92,246,0.12)]">
              <p className="text-center text-[9px] uppercase tracking-wide text-violet-300 tactical-phosphor">
                ⚠ {ch.nodeDesyncTitle}
              </p>
              <button
                type="button"
                onClick={() => {
                  playTacticalUiClick()
                  rebootProcess()
                }}
                className="tactical-interactive-glitch tactical-btn mt-2 w-full py-1.5 text-[9px] uppercase tracking-widest text-violet-200"
              >
                <span>⟲ {ch.rebootProcess}</span>
              </button>
            </div>
          )}

          {lowEnergy && address && !phased && !invalidCollection && (
            <div className="tactical-frame mb-2 border-violet-500/40 bg-violet-950/20 px-2.5 py-1.5 shadow-[0_0_16px_rgba(139,92,246,0.12)]">
              <p className="text-center text-[10px] font-bold uppercase tracking-wider text-violet-300 tactical-phosphor">
                ⚡ {ch.lowEnergyTitle}
              </p>
              <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-1 text-center text-[10px] text-violet-200/80">
                <span>{ch.reqLiqPrefix}</span>{" "}
                <span className="tactical-digits-7seg text-violet-200/95">{stroopsToLiqDisplay(effectivePriceStroops)}</span>{" "}
                <PhaserLiqTokenLink
                  href={expertUrl}
                  symbol={chainTokenSymbol}
                  iconClassName="h-3.5 w-3.5"
                  className="text-[10px] text-violet-300/90"
                />
              </p>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-y-auto">
            <div className="space-y-6 pr-0.5">
              <section className="space-y-3">
                <h3 className="text-[9px] font-semibold uppercase tracking-[0.22em] text-zinc-600">
                  {lang === "es" ? "Operador" : "Operator"}
                </h3>
                <dl className="space-y-2.5">
                  <div>
                    <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.wallet}</dt>
                    <dd className="mt-1 font-mono text-[13px] leading-snug text-zinc-200">
                      {address ? truncateAddress(address) : ch.offline}
                    </dd>
                  </div>
                  {address ? (
                    <div>
                      <dt className="text-[9px] uppercase tracking-wider text-zinc-500">
                        {lang === "es" ? "Artista" : "Artist"}
                      </dt>
                      <dd className="mt-1 text-[13px] text-zinc-300">{artistAlias ?? (lang === "es" ? "Sin alias" : "No alias")}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>

              <hr className="border-zinc-800/90" />

              <section className="space-y-3">
                <h3 className="text-[9px] font-semibold uppercase tracking-[0.22em] text-zinc-600">
                  {lang === "es" ? "Liquidez" : "Liquidity"}
                </h3>
                <dl className="space-y-2.5">
                  <div>
                    <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.liqBalance}</dt>
                    <dd className={cn("mt-1", lowEnergy && "text-violet-400", balanceGlitch && "tactical-balance-glitch")}>
                      <span className="tactical-digits-7seg text-xl tabular-nums tracking-tight text-zinc-100">
                        {formatLiq(tokenBalance)}
                      </span>{" "}
                      <PhaserLiqTokenLink
                        href={expertUrl}
                        symbol={chainTokenSymbol}
                        className="align-middle text-xs text-zinc-400"
                      />
                      {address && <p className="mt-1.5 text-[8px] leading-relaxed text-zinc-600">{ch.tokenStandardSep41Note}</p>}
                      {showLiqIssuerMismatch ? (
                        <p className="mt-1.5 text-[8px] leading-relaxed text-violet-400/90">
                          {ch.liqBalanceIssuerMismatch.replace("{total}", formatLiq(walletLiqTotal))}
                        </p>
                      ) : null}
                    </dd>
                  </div>
                  {address && classicAsset && (
                    <>
                      <div>
                        <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.classicAssetLabel}</dt>
                        <dd className="mt-1 text-[12px] text-zinc-300">
                          {displayPhaserLiqSymbol(classicAsset.code)} · {truncateAddress(classicAsset.issuer)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.freighterBalanceLabel}</dt>
                        <dd className="mt-1 font-mono text-[13px] tabular-nums text-zinc-200">
                          {classicStatus?.hasTrustline ? (classicStatus.balance ?? "0.0000000") : ch.noTrustline}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              </section>

              <hr className="border-zinc-800/90" />

              <section className="space-y-3">
                <h3 className="text-[9px] font-semibold uppercase tracking-[0.22em] text-zinc-600">
                  {lang === "es" ? "Colección / red" : "Collection / network"}
                </h3>
                <dl className="space-y-2.5">
                  <div>
                    <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.collectionId}</dt>
                    <dd className="mt-1 font-mono text-[13px] tabular-nums text-zinc-200">
                      {collectionId > 0 ? String(collectionId) : ch.collectionIdProtocol}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.x402Price}</dt>
                    <dd className="mt-1 text-zinc-100">
                      <span className="tactical-digits-7seg text-lg tabular-nums tracking-tight">
                        {stroopsToLiqDisplay(effectivePriceStroops)}
                      </span>{" "}
                      <PhaserLiqTokenLink href={expertUrl} symbol={chainTokenSymbol} className="align-middle text-xs text-zinc-400" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.network}</dt>
                    <dd className="mt-1 font-mono text-[12px] text-zinc-400">{ch.networkValue}</dd>
                  </div>
                </dl>
              </section>

              <hr className="border-zinc-800/90" />

              <section className="space-y-3">
                <h3 className="text-[9px] font-semibold uppercase tracking-[0.22em] text-zinc-600">{ch.phaseState}</h3>
                <dl className="space-y-2.5">
                  <div>
                    <dd className="text-[13px] leading-snug">
                      {phased ? (
                        <span className="font-medium text-emerald-400">
                          {ch.nftMinted} · #{phaseId}
                        </span>
                      ) : (
                        <span className="text-zinc-500">{ch.liquid}</span>
                      )}
                    </dd>
                  </div>
                  {phased && energyLevelBp != null && (
                    <div>
                      <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.powerLevel}</dt>
                      <dd className="mt-1 font-mono text-[13px] tabular-nums text-zinc-300">
                        {(energyLevelBp / 100).toFixed(0)}% <span className="text-zinc-600">({energyLevelBp} bp)</span>
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
            </div>
          </div>

          {!address ? (
            <button
              type="button"
              disabled={connecting}
              onClick={() => {
                playTacticalUiClick()
                void handleConnect().catch(() => {})
              }}
              className="tactical-interactive-glitch tactical-btn tactical-phosphor mt-2.5 w-full py-2.5 text-[9px] uppercase tracking-widest text-cyan-200 disabled:opacity-50"
            >
              <span>
                {connecting ? `◌ ${ch.uplinking}` : `▣ ${ch.linkWallet}`}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                playTacticalUiClick()
                disconnect()
                appendLog(ch.logs.walletUnlink)
                void refreshStatus().catch(() => {})
                void refreshClassicStatus().catch(() => {})
              }}
              className="tactical-interactive-glitch tactical-btn mt-2.5 w-full border-red-500/30 py-2 text-[9px] uppercase tracking-widest text-red-400/80 hover:border-red-500/60"
            >
              <span>◇ {ch.disconnect}</span>
            </button>
          )}

          {address && classicAsset ? (
            <div className="tactical-frame mt-2.5 border-violet-500/35 bg-violet-950/15 px-3 py-2.5">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-violet-300">
                {ch.classicRewardOptions}
              </p>
              <div className="mt-2 flex flex-col gap-2">
                <button
                  type="button"
                  disabled={classicBusy || !classicEnabled || (classicStatus?.hasTrustline && !!classicFundedAt)}
                  onClick={() => {
                    playTacticalUiClick()
                    void collectClassicAsset().catch(() => {})
                  }}
                  className="tactical-interactive-glitch tactical-btn w-full border-violet-500/55 py-2 text-[9px] uppercase tracking-widest text-violet-200 disabled:opacity-50"
                >
                  {!classicEnabled
                    ? ch.classicCollectDisabled
                    : classicBusy
                    ? ch.classicCollecting
                    : classicStatus?.hasTrustline && !!classicFundedAt
                    ? ch.classicAlreadyCollected
                    : !classicStatus?.hasTrustline
                    ? ch.classicAutoCollect.replace("{amount}", classicBootstrapAmount || "0")
                    : ch.classicCollectAsset.replace("{amount}", classicBootstrapAmount || "0")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    playTacticalUiClick()
                    void copyClassicAssetForManualAdd().catch(() => {})
                  }}
                  className="tactical-interactive-glitch tactical-btn w-full border-violet-400/40 py-1.5 text-[9px] uppercase tracking-widest text-violet-300/80"
                >
                  {lang === "es" ? "COPIAR ASSET PARA FREIGHTER" : "COPY ASSET CODE FOR FREIGHTER"}
                </button>
              </div>
              <div className="mt-2.5 border border-violet-500/20 bg-black/30 px-2.5 py-2">
                <p className="text-[8px] uppercase tracking-widest text-violet-400/70">
                  {lang === "es" ? "Asset para trustline manual" : "Asset code for manual trustline"}
                </p>
                <p className="mt-1 break-all font-mono text-[9px] text-violet-200/80">
                  {classicAsset.code}:{classicAsset.issuer}
                </p>
              </div>
            </div>
          ) : null}

          {address ? (
            <div className="mt-3 shrink-0 rounded border border-cyan-900/50 bg-black/40 p-2">
              <ArtistAliasControl compact />
            </div>
          ) : null}

          {isCreatorCurrentCollection ? (
            <div className="tactical-frame mt-2 border-cyan-400/35 bg-cyan-950/25 px-2.5 py-2">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-cyan-200">{ch.creatorCanMint}</p>
              <p className="mt-1 text-[10px] text-cyan-200/80">
                {phased ? ch.creatorAlreadyMinted : ch.creatorMintRule}
              </p>
            </div>
          ) : null}
        </aside>

        {/* THE_REACTOR */}
        <main className="tactical-cockpit-stage relative z-[102] flex min-h-0 flex-1 flex-col overflow-hidden max-lg:border-b max-lg:border-zinc-800/80">
          <div
            className="pointer-events-none absolute inset-2 rounded-sm bg-gradient-to-b from-zinc-800/20 to-transparent shadow-[inset_0_1px_0_rgba(63,63,70,0.2)] sm:inset-3"
            aria-hidden
          />

          <div className="tactical-cockpit-stage__content relative flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2 sm:px-4 sm:py-3 lg:px-5 lg:py-4">
          <div className="relative z-10 flex min-h-0 w-full max-w-[min(76rem,100%)] flex-1 flex-col gap-3 overflow-hidden lg:mx-auto lg:max-w-none">
          <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-contain lg:min-h-0">
            <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* Exhibition pedestal — NFT de utilidad PHASE (Soroban) */}
          <div className="relative z-10 mx-auto mb-0 flex min-h-0 w-full max-w-[min(76rem,100%)] flex-1 flex-col lg:mx-0 lg:max-w-none">
            <p className="mb-1 shrink-0 text-center text-[12px] font-medium tracking-wide text-zinc-300 lg:text-left">
              {ch.pedestalVisualShort}
            </p>
            <p className="mb-2 shrink-0 text-center text-[10px] leading-snug text-zinc-500 lg:text-left">
              {collectionPedestalLine}
            </p>
            <div className="flex min-h-0 flex-1 flex-col items-stretch gap-3 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-3 py-3 sm:gap-3 sm:px-4 sm:py-4">
              {mintingArtifact ? (
                <div className="flex flex-1 items-center justify-center text-center">
                  <div>
                    <div className="mx-auto mb-3 h-12 w-12 animate-spin rounded-full border-2 border-violet-500/60 border-t-transparent" />
                    <p className="animate-pulse text-sm font-bold uppercase tracking-[0.2em] text-violet-400">
                      {ch.mintingTitle}
                    </p>
                    <p className="mt-2 text-[9px] uppercase tracking-widest text-muted-foreground">
                      {ch.committingLedger}
                    </p>
                  </div>
                </div>
              ) : phased && phaseId != null && address ? (
                <div className="grid w-full max-h-full min-h-0 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start lg:gap-5">
                  <div className="ch-chamber-split-preview relative flex min-h-0 min-w-0 w-full max-w-full flex-col overflow-y-auto overflow-x-hidden rounded-xl lg:max-w-none lg:self-start">
                    <div
                      className="pointer-events-none absolute inset-0 z-[1] rounded-xl opacity-[0.34] [background:repeating-linear-gradient(0deg,transparent,transparent_3px,rgba(0,0,0,0.12)_3px,rgba(0,0,0,0.12)_4px)]"
                      aria-hidden
                    />
                    <div className="relative z-[2] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-cyan-500/35 bg-black/50 px-2.5 py-1.5 sm:px-3">
                        <p className="min-w-0 truncate font-mono text-[8px] font-semibold uppercase tracking-[0.2em] text-cyan-200/95 sm:text-[9px]">
                          {ch.chamberDockPreviewTicker}
                        </p>
                        <span className="shrink-0 font-mono text-[7px] uppercase tracking-widest text-cyan-500/85 sm:text-[8px]">
                          {ch.chamberColumnPreview}
                        </span>
                      </div>
                      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5 sm:flex-row sm:items-stretch sm:gap-3 sm:p-3">
                        <div className="shrink-0 space-y-2.5 rounded-lg border border-cyan-500/35 bg-black/70 px-2.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.08)] sm:px-3 sm:py-3 lg:max-w-[13rem] lg:shrink-0">
                          <div>
                            <p className="text-[12px] font-medium leading-snug text-zinc-100 sm:text-[13px]">
                              {artifactPublicCollectionName}
                            </p>
                            <p className="mt-0.5 font-mono text-[10px] tracking-wide text-zinc-500">
                              #{Math.max(0, Math.floor(phaseId))}
                            </p>
                          </div>
                          <div className="border-b border-cyan-500/20 pb-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[8px] uppercase tracking-wider text-zinc-500 sm:text-[9px]">
                                {ch.artifact.chamberPreviewCollectionAddress}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  playTacticalUiClick()
                                  void copyFreighterCollectibleField(
                                    ch.artifact.chamberPreviewCollectionAddress,
                                    CONTRACT_ID,
                                  ).catch(() => {})
                                }}
                                className="shrink-0 rounded-sm px-2 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-cyan-400/90 transition-colors hover:text-cyan-200 sm:text-[9px]"
                              >
                                {ch.artifact.chamberPreviewCopy}
                              </button>
                            </div>
                            <p className="mt-1 break-all font-mono text-[9px] leading-relaxed text-zinc-100 sm:text-[10px]">
                              {CONTRACT_ID}
                            </p>
                          </div>
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[8px] uppercase tracking-wider text-zinc-500 sm:text-[9px]">
                                {ch.artifact.chamberPreviewTokenId}
                              </span>
                              <button
                                type="button"
                                disabled={!nftNumericTokenIdStr}
                                onClick={() => {
                                  playTacticalUiClick()
                                  void copyFreighterCollectibleField(
                                    ch.artifact.chamberPreviewTokenId,
                                    nftNumericTokenIdStr,
                                  ).catch(() => {})
                                }}
                                className="shrink-0 rounded-sm px-2 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-cyan-400/90 transition-colors hover:text-cyan-200 disabled:opacity-40 sm:text-[9px]"
                              >
                                {ch.artifact.chamberPreviewCopy}
                              </button>
                            </div>
                            <p className="mt-1 font-mono text-[9px] tabular-nums tracking-wide text-zinc-100 sm:text-[10px]">
                              #{nftNumericTokenIdStr || String(Math.max(0, Math.floor(phaseId)))}
                            </p>
                          </div>
                          {issuerCustodyForCollect ? (
                            <button
                              type="button"
                              disabled={claimToWalletBusy}
                              onClick={() =>
                                void (
                                  (address?.trim()
                                    ? handleClaimNftToWallet()
                                    : handleCollectWithWalletKit()
                                  ).catch(() => {})
                                )
                              }
                              className="tactical-interactive-glitch w-full border border-violet-500/55 bg-violet-950/35 py-2 text-[9px] font-bold uppercase tracking-widest text-violet-100 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.12)] transition-colors hover:border-violet-400 hover:bg-violet-900/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                            >
                              {claimToWalletBusy ? ch.rewardsNftCollectSending : ch.chamberPreviewCollectCta}
                            </button>
                          ) : null}
                          <a
                            href={stellarExpertTestnetContractUrl(CONTRACT_ID)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => playTacticalUiClick()}
                            className="block text-center font-mono text-[9px] uppercase tracking-widest text-violet-400/90 underline-offset-2 transition hover:text-violet-200 sm:text-left"
                          >
                            {ch.stellarExpert}
                          </a>
                        </div>
                        <div className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-hidden pt-0.5">
                          <PhaseArtifactVisualizer
                            mode="verified"
                            contractId={CONTRACT_ID}
                            ownerTruncated={
                              onChainTokenOwner ? truncateAddress(onChainTokenOwner) : truncateAddress(address)
                            }
                            serial={phaseId}
                            energyLevelBp={energyLevelBp ?? 10_000}
                            collectionTitle={artifactCollectionTitle}
                            collectionDisplayName={artifactPublicCollectionName}
                            imageUrl={effectiveArtifactImage?.trim() ? effectiveArtifactImage.trim() : undefined}
                            labels={ch.artifact}
                            viewerAddress={address}
                            isOwner={isOwnerOnChain}
                            authenticityPending={authenticityPending}
                            supplyMinted={collectionSupply?.minted ?? null}
                            supplyCap={collectionSupply?.cap ?? null}
                            compact
                            showPublicMetaPanel={false}
                            showPrivateMetaPanel={false}
                            chamberPresentation={isOwnerOnChain || issuerCustodyForCollect}
                            chamberFrameless={isOwnerOnChain || issuerCustodyForCollect}
                            chamberMetaPanelExternal
                            suppressExpandLabel={Boolean(phased && phaseId != null && address)}
                            dockCopyTokenId={nftNumericTokenIdStr}
                            className="h-full w-full min-h-[12rem] min-w-0 max-w-none flex-1"
                            onAccessPrivateMetadata={
                              isOwnerOnChain ? () => void handleAccessPrivateMetadata().catch(() => {}) : undefined
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="ch-chamber-split-info relative flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain rounded-xl p-2 sm:p-2.5">
                    <div className="shrink-0 space-y-1.5">
                      <div className="flex items-start justify-between gap-2 rounded border border-cyan-500/40 bg-cyan-950/30 px-2.5 py-1.5 shadow-[0_0_14px_rgba(34,211,238,0.1)] sm:px-3 sm:py-2">
                        <p className="min-w-0 flex-1 font-mono text-[8px] font-semibold uppercase leading-snug tracking-[0.18em] text-cyan-200/95 sm:text-[9px]">
                          {ch.chamberDockInfoTicker}
                        </p>
                        <span className="shrink-0 pt-0.5 text-right font-mono text-[7px] uppercase tracking-widest text-cyan-500/80 sm:text-[8px]">
                          {ch.chamberColumnInfo}
                        </span>
                      </div>
                      <p className="rounded border border-zinc-700/60 bg-black/40 px-2.5 py-1.5 font-mono text-[7px] uppercase leading-relaxed tracking-[0.14em] text-zinc-500 sm:px-3 sm:text-[8px]">
                        {ch.chamberDockInfoSubline}
                      </p>
                    </div>
                    {isOwnerOnChain ? (
                      <div className="shrink-0 rounded-md border border-violet-500/35 bg-violet-950/20 px-4 py-3 sm:py-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <Link
                            href="/dashboard"
                            onClick={() => playTacticalUiClick()}
                            className="block text-[11px] font-bold uppercase tracking-[0.18em] text-violet-300 transition hover:text-violet-100"
                          >
                            {ch.artifactSecuredLedgerVault}
                          </Link>
                          <a
                            href={stellarExpertTestnetContractUrl(CONTRACT_ID)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => playTacticalUiClick()}
                            className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-violet-400/80 transition hover:text-violet-200"
                          >
                            Stellar Expert ↗
                          </a>
                        </div>
                        <p className="mt-2 font-mono text-[9px] uppercase tracking-wider text-violet-200/60">
                          owner_of(#{Math.max(0, Math.floor(phaseId))}) ≡ wallet ·{" "}
                          {phaseLedgerNftCountDone
                            ? ch.artifactLedgerBalanceContract.replace("{count}", phaseLedgerNftCount ?? "0")
                            : lang === "es"
                              ? "SINCRONIZANDO balance()…"
                              : "SYNCING balance()…"}
                        </p>
                      </div>
                    ) : issuerCustodyForCollect ? (
                      <div className="shrink-0 rounded-lg border border-violet-400/45 bg-violet-950/20 px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.12)] sm:px-4">
                        <p className="text-center text-[9px] leading-snug text-violet-100/85 sm:text-left">
                          {ch.pedestalIssuerCustodyHint}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            playTacticalUiClick()
                            setOperatorModalOpen(true)
                          }}
                          className="tactical-interactive-glitch mt-2 w-full border border-violet-400/55 py-2 text-center text-[10px] font-bold uppercase tracking-widest text-violet-100 hover:border-violet-300 hover:text-white sm:w-auto sm:px-4"
                        >
                          {ch.pedestalIssuerCustodyScrollLink}
                        </button>
                      </div>
                    ) : null}

                    {/* ── Narrative World connection ── */}
                    {worldData && (
                      <div className="shrink-0 border border-cyan-400/20 bg-cyan-950/15 p-3">
                        <Link
                          href={`/world/${collectionId}`}
                          className="mb-1.5 block font-mono text-[9px] uppercase tracking-widest text-cyan-500 transition-colors hover:text-cyan-300"
                        >
                          {`[ MUNDO: ${worldData.world_name} ]`} ↗
                        </Link>
                        {narrativeLoading ? (
                          <p className="animate-pulse font-mono text-[10px] italic text-cyan-400/50">
                            [ NARRADOR: generando conexión... ]
                          </p>
                        ) : narrativeData ? (
                          <p className="text-[11px] leading-relaxed text-cyan-200/80 italic">
                            {narrativeData}
                          </p>
                        ) : null}
                      </div>
                    )}

                    <details className="overflow-hidden rounded-lg border border-violet-500/40 bg-black/70 shadow-[0_0_22px_rgba(139,92,246,0.12)] [&[open]]:border-violet-400/55 [&[open]]:shadow-[0_0_28px_rgba(167,139,250,0.16)] [&_summary::-webkit-details-marker]:hidden">
                      <summary className="cursor-pointer list-none border-b border-violet-500/20 bg-violet-950/10 px-3 py-2.5 text-center font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-100 transition hover:bg-violet-950/25 hover:text-white sm:px-4 sm:py-3 lg:text-left">
                        {ch.chamberTechnicalDetails}
                        <span className="ml-1.5 text-violet-400/90" aria-hidden>
                          ▾
                        </span>
                      </summary>
                      <div className="max-h-[min(50dvh,22rem)] overflow-y-auto overscroll-y-contain border-t border-violet-500/20 px-3 pb-3 pt-3 [scrollbar-gutter:stable] sm:max-h-[min(52dvh,26rem)] sm:px-4 sm:pb-4 sm:pt-3.5 custom-scrollbar">
                    <div className="space-y-4">
                    <div className="w-full rounded-md border border-zinc-800/70 bg-zinc-950/40 p-3 sm:p-3.5">
                      <h3 className="mb-3 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                        {lang === "es" ? "Cadena" : "On-chain"}
                      </h3>
                      <dl className="divide-y divide-zinc-800/80">
                        <div className="space-y-1 py-2.5 first:pt-0">
                          <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.onChainMetaPhaselqSacLabel}</dt>
                          <dd className="hyphens-auto break-all font-mono text-[9px] leading-relaxed text-zinc-300 sm:text-[10px]" title={TOKEN_ADDRESS}>
                            {TOKEN_ADDRESS}
                          </dd>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                          <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{lang === "es" ? "Emisión" : "Supply"}</dt>
                          <dd className="shrink-0 font-mono text-[12px] tabular-nums text-zinc-100">
                            {collectionSupply?.minted ?? "—"} / {collectionSupply?.cap ?? "—"}
                          </dd>
                        </div>
                      </dl>

                      <div className="mt-5 border-t border-zinc-800/90 pt-5">
                        <h4 className="mb-3 text-[9px] font-semibold uppercase tracking-[0.2em] text-zinc-600">
                          {ch.artifact.privateChannelUnlocked}
                        </h4>
                        <dl className="space-y-3">
                          <div className="flex items-baseline justify-between gap-3">
                            <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.artifact.metadataStandard}</dt>
                            <dd className="font-mono text-[12px] text-zinc-200">SEP-41/50</dd>
                          </div>
                          <div className="flex flex-wrap items-baseline justify-between gap-3">
                            <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.artifact.powerLevel}</dt>
                            <dd className="text-right font-mono text-[12px] text-zinc-200">
                              {ch.artifact.stateSolid} · {formatPowerBp(energyLevelBp ?? 10_000)}
                            </dd>
                          </div>
                          <div className="flex flex-wrap items-baseline justify-between gap-3">
                            <dt className="text-[9px] uppercase tracking-wider text-zinc-500">{ch.artifact.holderSignature}</dt>
                            <dd className="max-w-[min(100%,12rem)] truncate font-mono text-[11px] text-zinc-300">
                              {viewerSignatureShort(address)}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </div>

                    {manualAddEnabled ? (
                      <div className="w-full space-y-4 rounded-lg border border-zinc-700/90 bg-zinc-950/40 p-4">
                        <div className="rounded-md bg-violet-950/25 px-3 py-3">
                          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-violet-200">{ch.walletNftVisibilityTitle}</p>
                          <p className="mt-2 whitespace-pre-line text-[11px] leading-relaxed text-violet-100/90">
                            {ch.walletNftVisibilityBody}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Link
                              href="/dashboard"
                              onClick={() => playTacticalUiClick()}
                              className="inline-flex rounded-sm border border-violet-500/40 bg-violet-950/50 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-100 transition-colors hover:border-violet-400 hover:bg-violet-900/40"
                            >
                              {lang === "es" ? "Bóveda PHASE (Dashboard) ↗" : "PHASE vault (Dashboard) ↗"}
                            </Link>
                            <a
                              href={stellarExpertTestnetContractUrl(CONTRACT_ID)}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => playTacticalUiClick()}
                              className="inline-flex rounded-sm border border-violet-500/40 bg-violet-950/50 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-100 transition-colors hover:border-violet-400 hover:bg-violet-900/40"
                            >
                              Stellar Expert ↗
                            </a>
                          </div>
                        </div>

                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">{ch.freighterManualAddTitle}</p>
                          <p className="mt-2 text-[12px] leading-relaxed text-zinc-300">
                            {isOwnerOnChain ? ch.freighterOwnerOnChainAddBody : ch.freighterManualAddBody}
                          </p>
                        </div>

                        {!freighterCollectibleReady ? (
                          <p className="rounded-md bg-violet-950/20 px-3 py-2.5 text-[11px] leading-relaxed text-violet-200/85">
                            {!isOwnerOnChain
                              ? lang === "es"
                                ? "Aun si Freighter da error, ya puedes intentar Add manually con estos datos. Si falla, pulsa SYNC y reintenta en 30-90s."
                                : "Even if Freighter errors, you can already try Add manually using these values. If it fails, press SYNC and retry in 30-90s."
                              : lang === "es"
                                ? "Freighter puede usar su propio backend al añadir coleccionables. Si falla, usá el botón naranja Ping índice (self-transfer); para enviar el NFT a otra persona copiá su G… al portapapeles y usá el botón magenta. Tu lista oficial en PHASE está en el dashboard (bóveda RPC)."
                                : "Freighter may use its own backend when adding collectibles. If it fails, use the amber Ping index button (self-transfer); to send the NFT to someone else copy their G-address to the clipboard, then use the magenta button. Your authoritative PHASE list is the dashboard vault (RPC scan)."}
                          </p>
                        ) : (
                          <p className="rounded-md bg-zinc-900/60 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-400">
                            {ch.freighterManualAddTroubleshoot}
                          </p>
                        )}

                        <p className="text-[10px] leading-relaxed text-zinc-500">{ch.freighterSep50CheckIntro}</p>
                        <button
                          type="button"
                          disabled={!nftNumericTokenIdStr || freighterSep50Busy}
                          onClick={() => {
                            playTacticalUiClick()
                            void handleFreighterSep50Check()
                          }}
                          className="w-full rounded-sm border border-zinc-600 bg-zinc-900/80 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-45"
                        >
                          {freighterSep50Busy ? "…" : ch.freighterSep50CheckButton}
                        </button>
                        {freighterSep50Report ? (
                          <pre className="max-h-48 overflow-auto rounded-md bg-black/60 p-3 font-mono text-[9px] leading-snug text-zinc-400">
                            {freighterSep50Report}
                          </pre>
                        ) : null}

                        <div className="space-y-3 border-t border-zinc-800/90 pt-4">
                          <button
                            type="button"
                            disabled={!nftNumericTokenIdStr}
                            onClick={() => {
                              playTacticalUiClick()
                              void copyFreighterCollectibleBundle(CONTRACT_ID, nftNumericTokenIdStr).catch(() => {})
                            }}
                            className="w-full rounded-sm border border-zinc-600 bg-zinc-900 py-2.5 text-[10px] font-bold uppercase tracking-wide text-zinc-100 transition-colors hover:border-violet-500/50 hover:text-white disabled:opacity-45"
                          >
                            {ch.freighterCopyBundleButton}
                          </button>
                          {phaseId != null && phaseId > 0 && !isOwnerOnChain ? (
                            <button
                              type="button"
                              disabled={claimToWalletBusy}
                              onClick={() => void handleCollectWithWalletKit()}
                              className="w-full rounded-sm border border-violet-600/50 bg-violet-950/40 py-2.5 text-[10px] font-bold uppercase tracking-wide text-violet-100 transition-colors hover:bg-violet-900/35 disabled:opacity-45"
                            >
                              {claimToWalletBusy ? ch.rewardsNftCollectSending : ch.collectToMyWallet}
                            </button>
                          ) : null}

                        </div>
                      </div>
                    ) : null}
                    </div>
                      </div>
                    </details>
                  </div>
                </div>
              ) : collectionLoadState === "loading" && collectionId > 0 ? (
                <p className="text-center text-[10px] uppercase tracking-[0.3em] text-muted-foreground/60">
                  {ch.syncingMeta}
                </p>
              ) : (
                <div className="flex w-full max-h-full min-h-0 flex-col items-center gap-2 overflow-hidden sm:gap-3">
                  {/* Collection image preview — shown pre-mint when imageUri is available */}
                  {effectiveArtifactImage && (
                    <div className="relative w-full max-w-[14rem] overflow-hidden rounded-sm border border-zinc-700/60 bg-black/60 sm:max-w-[16rem]">
                      <IpfsDisplayImg
                        uri={effectiveArtifactImage}
                        className="w-full object-cover opacity-60 blur-[2px] [image-rendering:auto]"
                        loading="lazy"
                      />
                      {/* scanlines */}
                      <div
                        className="pointer-events-none absolute inset-0"
                        style={{ background: "repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.13) 2px,rgba(0,0,0,0.13) 4px)" }}
                        aria-hidden
                      />
                      {/* PREVIEW_ONLY badge */}
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <span className="border border-violet-500/50 bg-violet-950/80 px-2 py-1 font-mono text-[8px] font-bold uppercase tracking-[0.2em] text-violet-200/95 shadow-[0_0_16px_rgba(139,92,246,0.2)]">
                          [ PREVIEW_ONLY ]
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="w-full shrink-0 rounded-sm border border-zinc-700 bg-zinc-950/50 px-3 py-2.5 text-center shadow-[inset_0_0_0_1px_rgba(63,63,70,0.25)]">
                    <p className="text-[8px] uppercase tracking-[0.35em] text-zinc-500">{ch.x402MintPrice}</p>
                    <p className="tactical-phosphor mt-0.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xl tracking-wider text-cyan-200 sm:text-2xl">
                      <span className="tactical-digits-7seg">{stroopsToLiqDisplay(effectivePriceStroops)}</span>
                      <PhaserLiqTokenLink
                        href={expertUrl}
                        symbol={chainTokenSymbol}
                        iconClassName="h-4 w-4 sm:h-5 sm:w-5"
                        className="text-sm sm:text-base"
                      />
                    </p>
                    {collectionId > 0 && collectionInfo && (
                      <p className="mt-2 text-[9px] uppercase tracking-widest text-muted-foreground/80">
                        {ch.collectionLine
                          .replace("{id}", String(collectionId))
                          .replace("{name}", collectionInfo.name || "—")}
                      </p>
                    )}
                    {collectionId === 0 && (
                      <p className="mt-2 text-[9px] uppercase tracking-widest text-muted-foreground/80">
                        {ch.protocolDefaultPool}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
            </div>

            {phased && address && phaseId != null && isOwnerOnChain && !authenticityPending ? null : (
            <div className="relative z-10 shrink-0 border-t border-zinc-800/70 pt-1.5">
          {!(
            phased &&
            address &&
            phaseId != null &&
            isOwnerOnChain &&
            authenticityPending
          ) ? (
          <p className="mb-0.5 shrink-0 text-center text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-500 sm:text-[11px]">
            {ch.theReactor}
          </p>
          ) : null}

          {!phased ? (
            <div
              className={cn(
                "relative z-10 mx-auto flex w-full max-w-[min(52rem,100%)] shrink-0 flex-col items-stretch gap-1.5 px-1 sm:px-2 lg:mx-0 lg:max-w-none",
                genesisLoading && "tactical-reactor-filling",
              )}
            >
              {!canInitializeGenesisSupply && !processing && (
                <p className="mb-1.5 text-center text-[9px] leading-relaxed text-zinc-500 sm:text-left">
                  {ch.paymentGateExplainer.replace("{amount}", stroopsToLiqDisplay(effectivePriceStroops))}
                </p>
              )}
              <button
                type="button"
                disabled={
                  processing ||
                  genesisLoading ||
                  invalidCollection ||
                  collectionLoadState === "loading" ||
                  (canInitializeGenesisSupply && !address)
                }
                onClick={() => {
                  playTacticalUiClick()
                  if (canInitializeGenesisSupply) {
                    void requestGenesisSupply().catch(() => {})
                    return
                  }
                  void initiateX402().catch(() => {})
                }}
                className={cn(
                  chamberChromePrimaryBtn,
                  "tactical-interactive-glitch relative rounded-sm px-2 py-2.5 text-xs tracking-[0.18em] sm:py-3 sm:text-sm",
                  canInitializeGenesisSupply && !address && "cursor-not-allowed opacity-40",
                  processing && x402Tx === "busy" && "motion-safe:animate-pulse",
                )}
              >
                <span className="px-2 text-base font-bold tracking-widest sm:text-lg md:text-xl">
                  {genesisLoading
                    ? `▶▶ ${ch.genesisSupplyLoading}`
                    : processing && x402Tx === "busy"
                      ? `▶▶ ${ch.x402StreamActive}`
                      : canInitializeGenesisSupply
                        ? ch.initializeGenesisSupply
                        : `▣ ${ch.executeSettlement}`}
                </span>
              </button>
            </div>
          ) : (
            <div className="relative z-10 mx-auto flex w-full max-w-[min(52rem,100%)] shrink-0 flex-col items-stretch gap-2 px-1 sm:px-2 lg:mx-0 lg:max-w-none">
              {authenticityPending ? (
                <p className="tactical-phosphor text-center text-[10px] uppercase tracking-[0.2em] text-cyan-500/85">
                  ◌ {ch.verifyingOwner}
                </p>
              ) : !address ? (
                <p className="tactical-phosphor text-center text-[10px] uppercase tracking-[0.2em] text-cyan-500/85">
                  {ch.linkWallet}
                </p>
              ) : issuerCustodyForCollect && phaseId != null ? (
                <button
                  type="button"
                  disabled={claimToWalletBusy}
                  onClick={() => void handleClaimNftToWallet()}
                  className={cn(
                    chamberChromePrimaryBtn,
                    "tactical-interactive-glitch relative rounded-sm px-2 py-2.5 text-xs tracking-[0.18em] sm:py-3 sm:text-sm",
                    claimToWalletBusy && "motion-safe:animate-pulse",
                  )}
                >
                  <span className="px-2 text-base font-bold tracking-widest sm:text-lg md:text-xl">
                    {claimToWalletBusy
                      ? `▶▶ ${ch.rewardsNftCollectSending}`
                      : ch.reactorClaimNftCta}
                  </span>
                </button>
              ) : isOwnerOnChain ? (
                <p className="tactical-phosphor-green text-center text-[10px] uppercase tracking-widest text-[#39ff14]/90">
                  ● {ch.solidStateStandby}
                </p>
              ) : tokenOwnerLookupDone && phaseId != null ? (
                <p className="text-center text-[9px] leading-relaxed uppercase tracking-[0.18em] text-violet-300/80">
                  {ch.reactorClaimUnavailableHint}
                </p>
              ) : (
                <p className="tactical-phosphor-green text-center text-[10px] uppercase tracking-widest text-[#39ff14]/90">
                  ● {ch.solidStateStandby}
                </p>
              )}
            </div>
          )}
            </div>
            )}

          </div>
          </div>

          <div className="relative z-10 mt-2 w-full min-h-0 shrink-0 border-t border-zinc-800/90 pt-2 lg:max-w-none">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-zinc-500">
                {ch.community}
              </p>
              <Link
                href="/dashboard"
                className="shrink-0 rounded-sm border border-zinc-700 bg-zinc-900/60 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-400 transition-colors hover:border-violet-500/50 hover:text-violet-300"
              >
                {ch.fullMarket}
              </Link>
            </div>
            {catalogLoadState === "loading" && (
              <p className="text-[10px] font-medium uppercase tracking-widest text-cyan-400/80">{ch.catalogLoading}</p>
            )}
            {catalogLoadState === "done" && communityCatalog.length === 0 && (
              <p className="mb-3 text-[10px] leading-relaxed text-cyan-200/75">
                {ch.noCommunity}{" "}
                <Link href="/forge" className="font-bold text-cyan-300 underline-offset-2 hover:text-white hover:underline">
                  {ch.forgeCta}
                </Link>
                .
              </p>
            )}
            {catalogLoadState === "done" && (
              <div
                className={cn(
                  "flex w-full min-w-0 max-w-full items-start gap-1.5 overflow-x-auto overflow-y-hidden pb-0.5 [-ms-overflow-style:none] [scrollbar-width:thin]",
                )}
              >
                <Link
                  href="/chamber"
                  className={cn(
                    "flex w-[4.75rem] shrink-0 flex-col border border-zinc-700 bg-zinc-950/80 transition-colors",
                    collectionId === 0
                      ? "border-violet-500/60 shadow-[0_0_14px_rgba(139,92,246,0.22)]"
                      : "opacity-95 hover:border-violet-500/40",
                  )}
                  title={ch.defaultPool}
                >
                  <div
                    className={cn(
                      "flex aspect-square w-full shrink-0 items-center justify-center border-b border-foreground/15 bg-[oklch(0.05_0_0)]",
                    )}
                  >
                    <span className="px-1 text-center text-[8px] font-bold uppercase tracking-widest text-cyan-300/90">
                      #0
                    </span>
                  </div>
                  <div className="min-h-0 px-1.5 py-1.5 text-center">
                    <p className="truncate text-[7px] font-semibold uppercase tracking-tighter text-cyan-200/95">
                      {ch.defaultPool}
                    </p>
                    <p className="truncate text-[6px] font-medium leading-tight text-cyan-400/85">
                      <span className="inline-flex items-center justify-center gap-1">
                        {stroopsToLiqDisplay(REQUIRED_AMOUNT)} <TokenIcon className="h-3 w-3" /> {chainTokenSymbol}
                      </span>
                    </p>
                  </div>
                </Link>
                {communityCatalog
                  .slice()
                  .sort((a, b) => a.collectionId - b.collectionId)
                  .map((c) => {
                    const active = c.collectionId === collectionId
                    const thumbUri = c.imageUri?.trim() ?? ""
                    return (
                      <Link
                        key={c.collectionId}
                        href={`/chamber?collection=${c.collectionId}`}
                        className={cn(
                          "flex w-[4.75rem] shrink-0 flex-col border border-zinc-700 bg-zinc-950/80 transition-colors",
                          active
                            ? "border-violet-500/60 shadow-[0_0_14px_rgba(139,92,246,0.22)]"
                            : "opacity-95 hover:border-violet-500/40",
                        )}
                        title={c.name || `Collection #${c.collectionId}`}
                      >
                        <div
                          className={cn(
                            "flex aspect-square w-full shrink-0 items-center justify-center overflow-hidden border-b border-foreground/15 bg-[oklch(0.08_0.02_220)]",
                          )}
                        >
                          {thumbUri ? (
                            <ChamberCatalogThumb collectionId={c.collectionId} uri={thumbUri} />
                          ) : (
                            <span className="px-1 text-center text-[7px] uppercase leading-tight text-muted-foreground/45">
                              #{c.collectionId}
                            </span>
                          )}
                        </div>
                        <div className="min-h-0 px-1.5 py-1.5 text-center">
                          <p className="truncate text-[7px] uppercase tracking-tighter text-cyan-400/90">#{c.collectionId}</p>
                          {creatorAliasByWallet[c.creator] ? (
                            <p className="truncate text-[6px] uppercase tracking-tighter text-cyan-300/90">
                              @{creatorAliasByWallet[c.creator]}
                            </p>
                          ) : null}
                          <p className="truncate text-[6px] leading-tight text-muted-foreground/70">
                            <span className="inline-flex items-center gap-1">
                              {stroopsToLiqDisplay(c.price)} <TokenIcon className="h-3 w-3" /> {chainTokenSymbol}
                            </span>
                          </p>
                        </div>
                      </Link>
                    )
                  })}
              </div>
            )}
          </div>
          </div>
        </main>

      {address ? (
        <aside
          className={cn(
            "relative z-[102] flex min-h-0 w-full min-w-0 flex-col overflow-hidden md:col-span-2 lg:col-span-1",
            "max-lg:border-t max-lg:border-zinc-800/90 max-lg:pt-3 lg:h-full lg:border-l lg:border-zinc-800/90 lg:pt-0",
          )}
        >
          <div
            id="chamber-log-dock"
            className="tactical-frame-panel flex max-h-[min(32dvh,260px)] min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-emerald-500/35 bg-black/90 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.12)] lg:max-h-none lg:min-h-0 lg:flex-1"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-emerald-500/25 px-3 py-1.5">
              <h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-400/90 sm:text-[11px]">
                {ch.systemLogs}
              </h2>
              <span className="text-[9px] text-emerald-500/90 sm:text-[10px]">● {ch.live}</span>
            </div>
            <div className="custom-scrollbar tactical-log-viewport tactical-log-viewport--analog min-h-0 flex-1 overflow-y-scroll overscroll-y-contain px-3 py-2 pr-2 [scrollbar-gutter:stable]">
              <ChamberLogStream lines={lines} endRef={logEndDockRef} />
            </div>
          </div>
        </aside>
      ) : null}

      </div>

      {operatorModalOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[280] flex items-end justify-center sm:items-center sm:p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="chamber-operator-heading"
            >
              <button
                type="button"
                className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
                aria-label={ch.operatorPanelBackdropClose}
                onClick={() => setOperatorModalOpen(false)}
              />
              <div
                className="relative flex max-h-[min(90dvh,820px)] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-zinc-700 bg-zinc-950 shadow-[0_-12px_48px_rgba(0,0,0,0.55)] sm:rounded-xl sm:shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
                  <h2 id="chamber-operator-heading" className="text-[11px] font-bold uppercase tracking-[0.22em] text-zinc-300">
                    {ch.operatorPanelHeading}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      playTacticalUiClick()
                      setOperatorModalOpen(false)
                    }}
                    className="rounded-sm border border-zinc-600 px-2 py-1 font-mono text-sm leading-none text-zinc-300 transition-colors hover:bg-zinc-900"
                    aria-label={ch.operatorPanelBackdropClose}
                  >
                    ×
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4 sm:pb-5">
                  {address ? (
                    <>
                      <LiquidityFaucetControl
                        address={address}
                        tokenBalance={tokenBalance}
                        onNarrativeLog={appendLog}
                        onRefreshBalance={refreshStatus}
                        compact
                        freighterNftCollect={
                          phased && phaseId != null && tokenOwnerLookupDone ? { tokenId: phaseId } : null
                        }
                        hideInlineMissionToggle={false}
                        omitHeader={false}
                        omitMissionChain={false}
                        omitLiquidityLane={false}
                        omitFreighterNftBlock={Boolean(issuerCustodyForCollect || isOwnerOnChain)}
                        className="border-zinc-800/80 bg-zinc-900/30"
                      />
                      <GatewayHealthDashboard className="mt-3" />
                    </>
                  ) : (
                    <p className="py-8 text-center text-[12px] text-zinc-500">{ch.linkWallet}</p>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {logsOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[140] cursor-default border-0 bg-black/50 p-0 lg:hidden"
            aria-label={ch.logsClose}
            onClick={() => setLogsOpen(false)}
          />
          <div
            id="chamber-logs-panel"
            role="dialog"
            aria-modal="true"
            aria-label={ch.systemLogs}
            className="fixed bottom-3 left-1/2 z-[150] w-[min(20rem,calc(100vw-1.25rem))] max-w-[20rem] -translate-x-1/2 md:left-auto md:right-4 md:translate-x-0 lg:hidden"
          >
            <div
              className={cn(
                "tactical-frame-panel flex max-h-[min(52vh,340px)] min-h-0 flex-col overflow-hidden border-2 border-[#39ff14]/45 bg-black/95 shadow-[0_12px_40px_rgba(0,0,0,0.75)] backdrop-blur-sm",
              )}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-green-500/25 px-3 py-2">
                <h2 className="tactical-phosphor-green text-[10px] uppercase tracking-[0.28em] text-[#39ff14]/85 sm:text-[11px]">
                  ┃ {ch.systemLogs}
                </h2>
                <div className="flex items-center gap-2">
                  <span className="tactical-phosphor-green text-[9px] text-[#39ff14]/85 sm:text-[10px]">● {ch.live}</span>
                  <button
                    type="button"
                    onClick={() => setLogsOpen(false)}
                    className="rounded border border-cyan-500/45 px-2 py-0.5 font-mono text-[11px] leading-none text-cyan-300 hover:bg-cyan-950/60"
                    aria-label={ch.logsClose}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="custom-scrollbar tactical-log-viewport tactical-log-viewport--analog min-h-0 min-h-[8rem] flex-1 overflow-y-auto overscroll-y-contain px-3 py-2.5 pr-2">
                <ChamberLogStream lines={lines} endRef={logEndModalRef} />
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
