"use client"

import Link from "next/link"
import dynamic from "next/dynamic"
import { createPortal } from "react-dom"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { signTransaction } from "@/lib/stellar-wallet-kit"
import { FeeBumpTransaction, Transaction, TransactionBuilder, Networks } from "@stellar/stellar-sdk"
import { LangToggle } from "@/components/lang-toggle"
import { useLang } from "@/components/lang-context"
import { TokenIcon } from "@/components/token-icon"
const TrustlineButton = dynamic(
  () => import("@/components/trustline-button").then((m) => ({ default: m.TrustlineButton })),
  {
    ssr: false,
    loading: () => (
      <section
        className="mt-2 shrink-0 border border-zinc-800/60 bg-black/25 px-2.5 py-2"
        aria-busy="true"
        aria-label="Trustline"
      >
        <div className="h-2.5 w-40 max-w-full rounded bg-zinc-800/60" />
        <div className="mt-2 h-9 w-full rounded border border-zinc-800 bg-zinc-900/40" />
      </section>
    ),
  },
)
import { useWallet } from "@/components/wallet-provider"
import { pickCopy } from "@/lib/phase-copy"
import { humanizePhaseHostErrorMessage } from "@/lib/phase-host-error"
import { composeImageWithPhaseForgeSeal } from "@/lib/forge-seal-image"
import { isIpfsUploadConfigured, uploadToIPFS } from "@/lib/ipfs-upload"
import { cn } from "@/lib/utils"
import { playTacticalUiClick } from "@/lib/tactical-ui-click"
import { IpfsDisplayImg } from "@/components/ipfs-display-img"
import { LiquidityFaucetControl } from "@/components/liquidity-faucet-control"
import { TacticalCornerSigil } from "@/components/tactical-corner-sigil"
import {
  NETWORK_PASSPHRASE,
  REQUIRED_AMOUNT,
  buildCreateCollectionTransaction,
  buildSettleTransaction,
  fetchCreatorCollectionIds,
  fetchUserPhaseArtifact,
  getTokenBalance,
  getTransactionResult,
  liqToStroops,
  sendTransaction,
  stroopsToLiqDisplay,
  PHASER_LIQ_STELLAR_EXPERT_DEFAULT,
  PHASER_LIQ_SYMBOL,
  stellarExpertPhaserLiqUrl,
  validateFinalContractImageUri,
} from "@/lib/phase-protocol"
import { parseSignedTxXdr } from "@/lib/classic-liq"
import { freighterTestnetMismatchLabel } from "@/lib/freighter-testnet"
import { toast } from "sonner"

/** Fallos típicos cuando el RPC público de testnet devuelve 502/503/504 o el proxy agota reintentos. */
function isSorobanRpcCongestionError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : err &&
          typeof err === "object" &&
          typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err)
  const m = msg.toLowerCase()
  return (
    /\b503\b/.test(m) ||
    /\b502\b/.test(m) ||
    /\b504\b/.test(m) ||
    /status code 50[234]/.test(m) ||
    /service unavailable|bad gateway|gateway timeout/.test(m) ||
    /soroban rpc no disponible|no disponible tras reintentos/.test(m) ||
    /el rpc soroban no respondió|el proxy soroban devolvió/.test(m)
  )
}

const SOROBAN_CONGESTED_CODE = "SOROBAN_TESTNET_CONGESTED"

/** Comprueba que el XDR sea una transacción testnet firmable por Freighter (no envía nada a red). */
function assertValidUnsignedSettleXdr(xdr: string): void {
  const trimmed = xdr?.trim() ?? ""
  if (trimmed.length < 48) {
    throw new Error("XDR inválido: demasiado corto para ser una transacción Stellar.")
  }
  try {
    const parsed = TransactionBuilder.fromXDR(trimmed, Networks.TESTNET)
    if (parsed instanceof FeeBumpTransaction) {
      const inner = parsed.innerTransaction
      if (!inner || !(inner instanceof Transaction)) {
        throw new Error("Fee bump sin transacción interna esperada.")
      }
      return
    }
    if (!(parsed instanceof Transaction)) {
      throw new Error("El XDR no decodifica a una transacción estándar.")
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("XDR")) throw e
    if (e instanceof Error && e.message.startsWith("Fee bump")) throw e
    if (e instanceof Error && e.message.startsWith("El XDR")) throw e
    throw new Error(`XDR de settle no válido para testnet: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function truncateAddress(addr: string) {
  if (!addr || addr.length < 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Convierte errores técnicos del flujo Oracle/mint en copy localizada o mensaje legible. */
function mapFusionChamberError(
  err: unknown,
  errors: ReturnType<typeof pickCopy>["forge"]["errors"],
): string {
  const msg =
    err instanceof Error
      ? err.message
      : err &&
          typeof err === "object" &&
          typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err)
  switch (msg) {
    case SOROBAN_CONGESTED_CODE:
      return errors.sorobanTestnetCongested
    case "FUSION_ABORTED_BY_USER":
      return errors.userAbortedFreighter
    case "ORACLE_OFFLINE_ENERGY_CONSUMED":
      return errors.oracleOfflineAfterPayment
    case "SIGN_FAIL":
    case "NO_SIGNED_XDR":
      return errors.agentPay
    default:
      break
  }
  const hostMsg = humanizePhaseHostErrorMessage(
    msg,
    errors.phaseHostContractErrors,
    errors.phaseHostContractUnknown,
  )
  if (hostMsg) return hostMsg
  if (msg && (/\s/.test(msg) || /[a-z]/.test(msg))) {
    return msg.length > 450 ? `${msg.slice(0, 450)}…` : msg
  }
  return errors.fusionChamberHalted
}

/**
 * Enlace Stellar Expert: primer render = URL default fija (SSR + hidratación iguales).
 * Tras montar, aplica `stellarExpertPhaserLiqUrl()` (NEXT_PUBLIC_*) para evitar mismatch
 * cuando el servidor ve .env completo y el chunk cliente no inlina igual el emisor.
 */
function PhaserLiqExpertLink({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  const [href, setHref] = useState(PHASER_LIQ_STELLAR_EXPERT_DEFAULT)
  useEffect(() => {
    setHref(stellarExpertPhaserLiqUrl())
  }, [])
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${PHASER_LIQ_SYMBOL} — Stellar Expert (testnet)`}
      className={cn(
        "inline-flex items-center gap-1 font-semibold text-cyan-100 underline decoration-cyan-400/55 underline-offset-[3px] transition-colors hover:text-white hover:decoration-cyan-200",
        className,
      )}
    >
      {children ?? PHASER_LIQ_SYMBOL}
      <span className="text-[0.65em] font-normal opacity-80" aria-hidden>
        ↗
      </span>
    </a>
  )
}

function textWithPhaserLiqLinks(text: string): React.ReactNode {
  if (!text.includes(PHASER_LIQ_SYMBOL)) return text
  const parts = text.split(PHASER_LIQ_SYMBOL)
  return parts.map((part, i) => (
    <span key={`frag-${i}`}>
      {part}
      {i < parts.length - 1 ? <PhaserLiqExpertLink key={`liq-${i}`} /> : null}
    </span>
  ))
}

const forgeNavBtn =
  "inline-flex min-h-[36px] items-center rounded-sm border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-400 transition-colors hover:border-violet-500/50 hover:text-violet-300"

type AgentState =
  | "IDLE"
  | "AWAITING_PAYMENT"
  | "ARMING_SETTLEMENT"
  | "PROCESSING_PAYMENT"
  | "FORGING_MATTER"
  | "COMPLETE"
type ForgeMode = "ORACLE" | "MANUAL"
type OracleImageStyleMode = "adaptive" | "cyber"

type FaucetQuestBrief = {
  questOverview?: { completed: number; total: number; progressPct: number }
}

export default function ForgePage() {
  const { lang } = useLang()
  const copy = pickCopy(lang)
  const f = copy.forge
  const n = copy.nav
  const ch = copy.chamber

  const { address, connect, disconnect, connecting, refresh } = useWallet()

  const [name, setName] = useState("")
  const [priceLiq, setPriceLiq] = useState("1")
  const [anomalyDescription, setAnomalyDescription] = useState("")
  const [oracleImageStyleMode, setOracleImageStyleMode] = useState<OracleImageStyleMode>("adaptive")
  const [forgeMode, setForgeMode] = useState<ForgeMode>("ORACLE")
  const [manualFile, setManualFile] = useState<File | null>(null)
  const [manualImageUrl, setManualImageUrl] = useState("")
  const [manualLoreDraft, setManualLoreDraft] = useState("")
  const [manualPreviewObjectUrl, setManualPreviewObjectUrl] = useState<string | null>(null)
  const [manualDropActive, setManualDropActive] = useState(false)
  const manualFileInputRef = useRef<HTMLInputElement>(null)

  const [agentState, setAgentState] = useState<AgentState>("IDLE")
  const [isMintingCollection, setIsMintingCollection] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<number | null>(null)
  /** Token id del NFT PHASE (`get_user_phase`), no el id de colección — necesario para COLLECT en el panel lateral. */
  const [collectionPhaseTokenId, setCollectionPhaseTokenId] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [tickerIdx, setTickerIdx] = useState(0)
  const [agentTickerIdx, setAgentTickerIdx] = useState(0)
  const [ipfsConfigured, setIpfsConfigured] = useState<boolean | null>(null)
  const [tokenBalance, setTokenBalance] = useState("0")
  const [protocolReady, setProtocolReady] = useState(false)

  const [agentImageUrl, setAgentImageUrl] = useState<string | null>(null)
  const [lore, setLore] = useState<string | null>(null)

  type ForgeOverlay = null | "rewards" | "protocol" | "lore" | "collection"
  const [forgeOverlay, setForgeOverlay] = useState<ForgeOverlay>(null)
  const [faucetBrief, setFaucetBrief] = useState<FaucetQuestBrief | null>(null)
  const prevForgeOverlay = useRef<ForgeOverlay>(null)

  const agentFlowBusy =
    agentState === "AWAITING_PAYMENT" ||
    agentState === "ARMING_SETTLEMENT" ||
    agentState === "PROCESSING_PAYMENT" ||
    agentState === "FORGING_MATTER"

  const busy = isMintingCollection || agentFlowBusy
  const actionLockedByProtocol = Boolean(address && !protocolReady)

  const anomalyFieldLocked = agentFlowBusy || agentState === "COMPLETE"
  /** Tras el Oráculo en COMPLETE el usuario aún debe poder editar nombre/precio antes del mint; no bloquear aquí. */
  const namePriceLocked = (forgeMode === "ORACLE" && agentFlowBusy) || isMintingCollection

  const tabSwitchLocked = agentFlowBusy || isMintingCollection

  // On wallet connect, load the most-recently created collection (last in list) for the
  // "Collection Live" panel. Multiple collections are now supported; we show the last one
  // as the active context without blocking the form.
  useEffect(() => {
    const g = address?.trim()
    setCreatedId(null)
    setShareUrl(null)
    if (!g) return
    let cancelled = false
    void fetchCreatorCollectionIds(g).then((ids) => {
      if (cancelled || ids.length === 0) return
      const last = ids[ids.length - 1]
      setCreatedId(last)
      if (typeof window !== "undefined") {
        setShareUrl(`${window.location.origin}/chamber?collection=${last}`)
      }
    })
    return () => {
      cancelled = true
    }
  }, [address])

  useEffect(() => {
    if (!manualFile) {
      setManualPreviewObjectUrl(null)
      return
    }
    const url = URL.createObjectURL(manualFile)
    setManualPreviewObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [manualFile])

  const selectForgeMode = useCallback(
    (next: ForgeMode) => {
      if (next === forgeMode || tabSwitchLocked) return
      playTacticalUiClick()
      setError(null)
      if (next === "MANUAL") {
        setAgentState("IDLE")
        setAgentImageUrl(null)
        setLore(null)
      } else {
        setManualFile(null)
        setManualImageUrl("")
        setManualLoreDraft("")
      }
      setForgeMode(next)
    },
    [forgeMode, tabSwitchLocked],
  )

  useEffect(() => {
    void isIpfsUploadConfigured()
      .then(setIpfsConfigured)
      .catch(() => setIpfsConfigured(false))
  }, [])

  const refreshLiqBalance = useCallback(async () => {
    const addr = address ?? (await refresh())
    if (!addr) {
      setTokenBalance("0")
      return
    }
    try {
      const bal = await getTokenBalance(addr)
      setTokenBalance(bal)
    } catch {
      setTokenBalance("0")
    }
  }, [address, refresh])

  useEffect(() => {
    const g = address?.trim()
    if (!g || createdId == null || createdId <= 0) {
      setCollectionPhaseTokenId(null)
      return
    }
    if (isMintingCollection) {
      setCollectionPhaseTokenId(null)
      return
    }
    let cancelled = false
    void fetchUserPhaseArtifact(g, createdId).then((art) => {
      if (cancelled) return
      const tid = art?.tokenId
      setCollectionPhaseTokenId(typeof tid === "number" && Number.isFinite(tid) && tid > 0 ? Math.floor(tid) : null)
    })
    return () => {
      cancelled = true
    }
  }, [address, createdId, isMintingCollection])

  const onTrustlineRequestConnect = useCallback(async () => {
    await connect()
    return refresh()
  }, [connect, refresh])

  const onTrustlineReady = useCallback(async () => {
    setProtocolReady(true)
    await refreshLiqBalance()
  }, [refreshLiqBalance])

  useEffect(() => {
    void refreshLiqBalance().catch(() => {})
  }, [refreshLiqBalance])

  const refetchFaucetBrief = useCallback(() => {
    const g = address?.trim()
    if (!g) {
      setFaucetBrief(null)
      return
    }
    void fetch(`/api/faucet?walletAddress=${encodeURIComponent(g)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setFaucetBrief(data as FaucetQuestBrief))
      .catch(() => setFaucetBrief(null))
  }, [address])

  useEffect(() => {
    refetchFaucetBrief()
  }, [refetchFaucetBrief])

  useEffect(() => {
    const prev = prevForgeOverlay.current
    if (prev === "rewards" && forgeOverlay === null) {
      void refetchFaucetBrief()
    }
    prevForgeOverlay.current = forgeOverlay
  }, [forgeOverlay, refetchFaucetBrief])

  useEffect(() => {
    if (!forgeOverlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setForgeOverlay(null)
    }
    window.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [forgeOverlay])

  useEffect(() => {
    if (!isMintingCollection) return
    const tickers = f.deployTickers
    const id = window.setInterval(() => {
      setTickerIdx((i) => (i + 1) % tickers.length)
    }, 900)
    return () => window.clearInterval(id)
  }, [isMintingCollection, f.deployTickers])

  useEffect(() => {
    if (agentState !== "FORGING_MATTER") return
    const tickers = pickCopy(lang).forge.forgeAgentForgingTickers
    const id = window.setInterval(() => {
      setAgentTickerIdx((i) => (i + 1) % tickers.length)
    }, 700)
    return () => window.clearInterval(id)
  }, [agentState, lang])

  const previewSrc = useMemo(() => {
    if (forgeMode === "MANUAL") {
      if (manualPreviewObjectUrl) return manualPreviewObjectUrl
      return manualImageUrl.trim()
    }
    return agentImageUrl?.trim() ?? ""
  }, [forgeMode, manualPreviewObjectUrl, manualImageUrl, agentImageUrl])

  const previewLoreText = forgeMode === "MANUAL" ? manualLoreDraft.trim() : (lore ?? "")

  const resolveImageUriForMint = useCallback(
    async (openAiImageUrl: string): Promise<string> => {
      const ivm = pickCopy(lang).imageValidation
      let res: Response
      try {
        res = await fetch(openAiImageUrl)
      } catch {
        throw new Error(pickCopy(lang).forge.errors.fetchAgentImage)
      }
      if (!res.ok) throw new Error(pickCopy(lang).forge.errors.fetchAgentImage)
      const blob = await res.blob()
      const sealed = await composeImageWithPhaseForgeSeal(blob)

      const configured = await isIpfsUploadConfigured().catch(() => false)
      if (configured) {
        const uri = await uploadToIPFS(sealed)
        const v = validateFinalContractImageUri(uri, ivm)
        if (!v.ok) throw new Error(v.message)
        return v.value
      }

      const vOpen = validateFinalContractImageUri(openAiImageUrl.trim(), ivm)
      if (vOpen.ok) return vOpen.value
      throw new Error(pickCopy(lang).forge.errors.finalUri)
    },
    [lang],
  )

  const resolveManualFileForMint = useCallback(
    async (file: File): Promise<string> => {
      const ivm = pickCopy(lang).imageValidation
      const sealed = await composeImageWithPhaseForgeSeal(file)
      const configured = await isIpfsUploadConfigured().catch(() => false)
      if (configured) {
        const uri = await uploadToIPFS(sealed)
        const v = validateFinalContractImageUri(uri, ivm)
        if (!v.ok) throw new Error(v.message)
        return v.value
      }
      throw new Error(pickCopy(lang).forge.errors.finalUri)
    },
    [lang],
  )

  const runCreateCollectionTransaction = useCallback(
    async (
      finalUri: string,
      opts: { restoreOracleOnFail: boolean; clearManualOnSuccess: boolean },
    ) => {
      const ff = pickCopy(lang).forge
      const addr = address ?? (await refresh())
      if (!addr) {
        setError(ff.errors.connectWallet)
        return
      }
      const wrongNet = await freighterTestnetMismatchLabel()
      if (wrongNet) {
        setError(ff.errors.freighterWrongNetwork.replace("{network}", wrongNet))
        return
      }
      const trimmedName = name.trim()
      if (trimmedName.length < 2) {
        setError(ff.errors.nameShort)
        return
      }
      const stroops = liqToStroops(priceLiq)
      if (stroops === "0") {
        setError(ff.errors.priceInvalid)
        return
      }

      setIsMintingCollection(true)
      setTickerIdx(0)

      try {
        const txEnvelopeCreate = await buildCreateCollectionTransaction(addr, trimmedName, stroops, finalUri)
        const signCreate = await signTransaction(txEnvelopeCreate, {
          networkPassphrase: NETWORK_PASSPHRASE,
          address: addr,
        })
        if (signCreate.error) throw new Error(signCreate.error.message || "SIGN_FAIL")
        const signedCreate =
          (signCreate as { signedTxXdr?: string }).signedTxXdr ||
          (signCreate as { signedTransaction?: string }).signedTransaction
        if (!signedCreate) throw new Error("NO_SIGNED_XDR")
        const sendCreate = await sendTransaction(signedCreate)
        await getTransactionResult(sendCreate.hash as string)

        const ids = await fetchCreatorCollectionIds(addr)
        const id = ids.length > 0 ? ids[ids.length - 1] : null
        if (id == null) throw new Error(ff.errors.collectionIdRead)
        setCreatedId(id)
        if (typeof window !== "undefined") {
          const path = `/chamber?collection=${id}`
          setShareUrl(`${window.location.origin}${path}`)
        }
        // Cada artefacto forjado debe materializarse como NFT: auto-mint en la colección recién creada.
        try {
          const invoiceId = Math.floor(Math.random() * 1_000_000)
          const txEnvelopeMint = await buildSettleTransaction(addr, stroops, invoiceId, id)
          const signMint = await signTransaction(txEnvelopeMint, {
            networkPassphrase: NETWORK_PASSPHRASE,
            address: addr,
          })
          if (signMint.error) throw new Error(signMint.error.message || "SIGN_FAIL")
          const signedMint =
            (signMint as { signedTxXdr?: string }).signedTxXdr ||
            (signMint as { signedTransaction?: string }).signedTransaction
          if (!signedMint) throw new Error("NO_SIGNED_XDR")
          const sendMint = await sendTransaction(signedMint)
          await getTransactionResult(sendMint.hash as string)
        } catch (mintErr) {
          const fallback =
            lang === "es"
              ? "La colección se creó, pero el auto-mint del NFT falló. Abrí Chamber para mintear manualmente."
              : "Collection created, but NFT auto-mint failed. Open Chamber to mint manually."
          const friendly = mapFusionChamberError(mintErr, ff.errors)
          setError(`${fallback} ${friendly}`)
        }

        setAgentState("IDLE")
        if (opts.clearManualOnSuccess) {
          setManualFile(null)
          setManualImageUrl("")
          setManualLoreDraft("")
        }
      } catch (e) {
        if (opts.restoreOracleOnFail) setAgentState("COMPLETE")
        setError(mapFusionChamberError(e, ff.errors))
      } finally {
        setIsMintingCollection(false)
      }
    },
    [address, lang, name, priceLiq, refresh],
  )

  const initiateAgentForge = useCallback(
    async (
      userPrompt: string,
      payerAddress: string,
      imageStyleMode: OracleImageStyleMode,
      collectionId?: number | null,
    ): Promise<{ imageUrl: string; lore: string }> => {
      const ff = pickCopy(lang).forge
      // AWAITING_PAYMENT ya lo fija handleForgeAgent tras validar el prompt.

      const invoiceId = Math.floor(Math.random() * 1_000_000)
      // Mientras llega el 402, armamos en paralelo el settle con el monto cliente (coincide con el challenge en despliegues normales).
      type SpecBuild = { ok: true; xdr: string } | { ok: false; error: unknown }
      const specBuildPromise: Promise<SpecBuild> = buildSettleTransaction(
        payerAddress,
        String(REQUIRED_AMOUNT),
        invoiceId,
        0,
      )
        .then((xdr) => ({ ok: true as const, xdr }))
        .catch((error: unknown) => ({ ok: false as const, error }))

      // 1) Primer POST: solo prompt → el backend responde 402 + challenge x402
      const first = await fetch("/api/forge-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: userPrompt, imageStyleMode, lang }),
      })

      if (first.status !== 402) {
        void specBuildPromise.catch(() => {})
        const errText = await first.text().catch(() => "")
        console.error("[forge-agent] expected 402 Payment Required, got", first.status, errText)
        if (first.ok) throw new Error(ff.errors.agentNot402)
        throw new Error(errText || ff.errors.agentRequest)
      }

      let paymentRequiredJson: {
        challenge?: { amount?: number | string }
        message?: string
        priceDisplay?: string
      }
      try {
        paymentRequiredJson = (await first.json()) as typeof paymentRequiredJson
      } catch (e) {
        void specBuildPromise.catch(() => {})
        console.error("[forge-agent] 402 response body is not valid JSON", e)
        throw new Error(ff.errors.agentRequest)
      }

      const challenge = paymentRequiredJson.challenge
      if (challenge) {
        console.log("[forge-agent] x402 challenge", challenge)
      }

      const requiredStroops = String(challenge?.amount ?? REQUIRED_AMOUNT)

      // 2) Pago on-chain: invoke `settle` en el contrato PHASE (PHASELQ), no transfer de NFT
      setAgentState("ARMING_SETTLEMENT")
      let unsignedXdr: string
      let settleInvoiceId = invoiceId

      try {
        if (requiredStroops !== String(REQUIRED_AMOUNT)) {
          void specBuildPromise.catch(() => {})
          settleInvoiceId = Math.floor(Math.random() * 1_000_000)
          unsignedXdr = await buildSettleTransaction(payerAddress, requiredStroops, settleInvoiceId, 0)
        } else {
          const spec = await specBuildPromise
          if (spec.ok) {
            unsignedXdr = spec.xdr
          } else {
            // eslint-disable-next-line no-console
            console.warn("[forge-agent] build settle especulativo falló, reconstruyendo", spec.error)
            unsignedXdr = await buildSettleTransaction(
              payerAddress,
              requiredStroops,
              settleInvoiceId,
              0,
            )
          }
        }
      } catch (armErr) {
        console.error("[forge-agent] buildSettleTransaction failed (RPC / simulación / contrato)", armErr)
        setAgentState("IDLE")
        if (isSorobanRpcCongestionError(armErr)) {
          const line = pickCopy(lang).forge.errors.sorobanTestnetCongested
          toast.error(line)
          throw new Error(SOROBAN_CONGESTED_CODE)
        }
        throw armErr
      }

      try {
        assertValidUnsignedSettleXdr(unsignedXdr)
      } catch (xdrErr) {
        console.error("[forge-agent] XDR de settle inválido tras buildSettleTransaction", xdrErr)
        setAgentState("IDLE")
        throw xdrErr
      }

      setAgentState("PROCESSING_PAYMENT")
      const tx = {
        kind: "settle_unsigned_xdr",
        xdrLength: unsignedXdr.length,
        xdrPrefix: unsignedXdr.slice(0, 72),
        invoiceId: settleInvoiceId,
        requiredStroops,
        payerPreview: `${payerAddress.slice(0, 6)}…${payerAddress.slice(-4)}`,
      }
      console.log("Transacción armada, solicitando firma en la wallet...", tx)

      const signResult = await signTransaction(unsignedXdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: payerAddress,
      })
      if (signResult.error) {
        console.error("[forge-agent] La wallet rechazó la firma del settle", signResult.error)
        setAgentState("IDLE")
        throw new Error("FUSION_ABORTED_BY_USER")
      }
      const signedXdr =
        parseSignedTxXdr(signResult) ||
        (signResult as { signedTxXdr?: string }).signedTxXdr ||
        (signResult as { signedTransaction?: string }).signedTransaction
      if (!signedXdr) {
        console.error("[forge-agent] No signed XDR returned from wallet", signResult)
        setAgentState("IDLE")
        throw new Error("NO_SIGNED_XDR")
      }

      const sendResult = await sendTransaction(signedXdr)
      const txHash = sendResult.hash as string
      if (!txHash) {
        console.error("[forge-agent] sendTransaction returned no hash", sendResult)
        throw new Error(ff.errors.agentPay)
      }
      await getTransactionResult(txHash)
      await refreshLiqBalance().catch(() => {})

      setAgentState("FORGING_MATTER")
      setAgentTickerIdx(0)

      // 3) Segundo POST: prueba en body + header `x402` (base64 JSON) como en app/api/forge-agent/route.ts
      const secondBody = {
        prompt: userPrompt,
        settlementTxHash: txHash,
        payerAddress,
        imageStyleMode,
        lang,
        ...(collectionId != null && collectionId > 0 ? { collection_id: collectionId } : {}),
      }
      const phaseProofB64 = btoa(
        JSON.stringify({ settlementTxHash: txHash, payerAddress }),
      )
      const paid = await fetch("/api/forge-agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `x402 ${phaseProofB64}`,
        },
        body: JSON.stringify(secondBody),
      })

      const paidRaw = await paid.text().catch(() => "")
      if (paid.status >= 500) {
        console.error("[forge-agent] second POST server error", paid.status, paidRaw)
        let serverMessage = ""
        try {
          const j = JSON.parse(paidRaw) as { error?: unknown; detail?: unknown }
          const errStr = typeof j.error === "string" ? j.error.trim() : ""
          const detailStr = typeof j.detail === "string" ? j.detail.trim() : ""
          if (errStr) serverMessage = detailStr ? `${errStr} — ${detailStr}` : errStr
          else if (detailStr) serverMessage = detailStr
        } catch {
          serverMessage = paidRaw
        }
        throw new Error(serverMessage || "ORACLE_OFFLINE_ENERGY_CONSUMED")
      }
      if (!paid.ok) {
        console.error("[forge-agent] second POST failed after payment", paid.status, paidRaw)
        let failMsg = paidRaw.trim() || ff.errors.agentRequest
        try {
          const j = JSON.parse(paidRaw) as { error?: string; message?: string }
          if (typeof j.error === "string" && j.error.trim()) failMsg = j.error.trim()
          else if (typeof j.message === "string" && j.message.trim()) failMsg = j.message.trim()
        } catch {
          /* cuerpo no JSON */
        }
        throw new Error(failMsg)
      }

      let data: {
        success?: boolean
        async?: boolean
        jobId?: string
        txHash?: string
        status?: string
        imageUrl?: string
        lore?: string
        description?: string
      }
      try {
        data = JSON.parse(paidRaw) as typeof data
      } catch (e) {
        console.error("[forge-agent] second POST success body is not JSON", e, paidRaw)
        throw new Error(ff.errors.agentRequest)
      }

      // ── Async job mode: poll /api/jobs/[txHash] until completed ───────────────
      if (data.async && txHash) {
        const pollTxHash = data.txHash ?? txHash
        console.log("[forge-agent] async mode — polling job for txHash:", pollTxHash)

        const POLL_INTERVAL_MS = 3500
        const POLL_TIMEOUT_MS = 4 * 60 * 1000 // 4 minutes
        const deadline = Date.now() + POLL_TIMEOUT_MS

        while (Date.now() < deadline) {
          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))

          let pollRes: Response
          try {
            pollRes = await fetch(`/api/jobs/${encodeURIComponent(pollTxHash)}`, { cache: "no-store" })
          } catch {
            continue
          }

          if (!pollRes.ok && pollRes.status !== 404) {
            console.warn("[forge-agent] poll returned non-ok status", pollRes.status)
            continue
          }

          let pollData: {
            found?: boolean
            job?: {
              status?: string
              imageUrl?: string
              error?: string
              result?: {
                imageUrl?: string
                lore?: string
              }
            }
          }
          try {
            pollData = (await pollRes.json()) as typeof pollData
          } catch {
            continue
          }

          if (!pollData.found || !pollData.job) continue

          const { status: jobStatus, result, error: jobError } = pollData.job

          if (jobStatus === "completed" && result?.imageUrl) {
            const imgUrl = result.imageUrl
            const loreText = result.lore ?? ""
            setAgentImageUrl(imgUrl)
            setLore(loreText)
            setAgentState("COMPLETE")
            return { imageUrl: imgUrl, lore: loreText }
          }

          if (jobStatus === "failed") {
            throw new Error(jobError ?? "ORACLE_OFFLINE_ENERGY_CONSUMED")
          }

          // Still pending / processing / webhook_received — keep polling
          console.log("[forge-agent] job still in progress:", jobStatus)
        }

        // Polling timeout
        throw new Error("ORACLE_OFFLINE_ENERGY_CONSUMED")
      }

      // ── Synchronous mode: result available immediately ────────────────────────
      if (!data.imageUrl) {
        console.error("[forge-agent] success payload missing imageUrl", data)
        throw new Error(ff.errors.agentRequest)
      }

      const loreText = data.lore ?? data.description ?? ""
      setAgentImageUrl(data.imageUrl)
      setLore(loreText)
      setAgentState("COMPLETE")
      return { imageUrl: data.imageUrl, lore: loreText }
    },
    [lang, refreshLiqBalance],
  )

  const handleForgeAgent = useCallback(async () => {
    const ff = pickCopy(lang).forge
    setError(null)
    setShareUrl(null)
    setCreatedId(null)
    setCopied(false)
    setAgentImageUrl(null)
    setLore(null)
    setAgentState("IDLE")

    const addr = address ?? (await refresh())
    if (!protocolReady) {
      setError(ff.oracle_blocked_msg)
      return
    }

    if (!addr) {
      setError(ff.errors.connectWallet)
      return
    }

    const prompt = anomalyDescription.trim()
    if (prompt.length < 4) {
      setError(ff.errors.anomalyShort)
      return
    }

    // Feedback inmediato: el usuario ve actividad mientras RPC + Freighter API corren en paralelo.
    setAgentState("AWAITING_PAYMENT")

    try {
      const [wrongNet, bal] = await Promise.all([
        freighterTestnetMismatchLabel(),
        getTokenBalance(addr),
      ])
      if (wrongNet) {
        setAgentState("IDLE")
        setError(ff.errors.freighterWrongNetwork.replace("{network}", wrongNet))
        return
      }
      if (BigInt(bal) < BigInt(REQUIRED_AMOUNT)) {
        setAgentState("IDLE")
        setError(ff.errors.lowEnergyAgent)
        return
      }
    } catch (e) {
      setAgentState("IDLE")
      const msg = e instanceof Error ? e.message : String(e)
      if (
        /503|502|504|429|timeout|timed out|RPC|proxy|Soroban|disponible|status code|network|ECONNRESET|fetch failed/i.test(
          msg,
        )
      ) {
        setError(ff.errors.rpcBalanceCheckFailed)
      } else {
        setError(ff.errors.lowEnergyAgent)
      }
      return
    }

    try {
      await initiateAgentForge(prompt, addr, oracleImageStyleMode, createdId)
    } catch (e) {
      console.error("[forge] Oracle / x402 flow failed", e)
      setAgentState("IDLE")
      setAgentImageUrl(null)
      setLore(null)
      setError(mapFusionChamberError(e, ff.errors))
    }
  }, [address, anomalyDescription, initiateAgentForge, lang, oracleImageStyleMode, protocolReady, refresh])

  const handleMintArtifact = useCallback(async () => {
    const ff = pickCopy(lang).forge
    if (agentState !== "COMPLETE" || !agentImageUrl) return
    setError(null)
    try {
      const finalUri = await resolveImageUriForMint(agentImageUrl)
      await runCreateCollectionTransaction(finalUri, {
        restoreOracleOnFail: true,
        clearManualOnSuccess: false,
      })
    } catch (e) {
      setError(mapFusionChamberError(e, ff.errors))
    }
  }, [agentImageUrl, agentState, lang, resolveImageUriForMint, runCreateCollectionTransaction])

  const handleManualUploadAndMint = useCallback(async () => {
    const ff = pickCopy(lang).forge
    if (!protocolReady) {
      setError(ff.mint_blocked_msg)
      return
    }

    const wrongNetManual = await freighterTestnetMismatchLabel()
    if (wrongNetManual) {
      setError(ff.errors.freighterWrongNetwork.replace("{network}", wrongNetManual))
      return
    }

    if (forgeMode !== "MANUAL") return
    setError(null)
    let finalUri: string
    try {
      if (manualFile) {
        finalUri = await resolveManualFileForMint(manualFile)
      } else if (manualImageUrl.trim()) {
        finalUri = await resolveImageUriForMint(manualImageUrl.trim())
      } else {
        setError(ff.errors.manualNoImage)
        return
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg ? mapFusionChamberError(e, ff.errors) : ff.errors.fusionChamberHalted)
      return
    }
    await runCreateCollectionTransaction(finalUri, {
      restoreOracleOnFail: false,
      clearManualOnSuccess: true,
    })
  }, [
    forgeMode,
    lang,
    manualFile,
    manualImageUrl,
    resolveImageUriForMint,
    resolveManualFileForMint,
    runCreateCollectionTransaction,
    protocolReady,
  ])

  useEffect(() => {
    setProtocolReady(false)
  }, [address])

  const copyShare = useCallback(async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      setError(pickCopy(lang).forge.errors.clipboard)
    }
  }, [shareUrl, lang])

  const inputClass =
    "w-full border border-zinc-700 bg-zinc-900/80 px-3 py-2.5 text-[14px] leading-snug text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none focus:ring-1 focus:ring-violet-500/20"

  const textareaClass = cn(
    inputClass,
    "min-h-[7rem] resize-y font-mono text-[13px] leading-relaxed sm:min-h-[8rem]",
  )
  const oraclePromptTextareaClass = cn(
    inputClass,
    "min-h-[4.75rem] resize-y font-mono text-[13px] leading-relaxed sm:min-h-[5.25rem]",
  )

  const inputLabelClass =
    "text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500"

  const priceReadout = stroopsToLiqDisplay(liqToStroops(priceLiq))

  const forgingTerminalLines = f.forgeAgentForgingTickers

  const statusStripActive =
    forgeMode === "ORACLE" ? agentFlowBusy || isMintingCollection : isMintingCollection

  const statusLine = isMintingCollection
    ? f.deployTickers[tickerIdx % f.deployTickers.length]
    : agentState === "PROCESSING_PAYMENT"
      ? f.forgeCtaGenerateSigning
      : agentState === "ARMING_SETTLEMENT"
        ? f.forgeCtaGenerateArming
        : agentState === "FORGING_MATTER"
          ? forgingTerminalLines[agentTickerIdx % forgingTerminalLines.length]
          : agentState === "AWAITING_PAYMENT"
            ? f.forgeCtaGenerateContacting
            : ""

  const initiatePrimaryLabel =
    agentState === "IDLE"
      ? f.forgeCtaGenerateIdle
      : agentState === "AWAITING_PAYMENT"
        ? f.forgeCtaGenerateContacting
        : agentState === "ARMING_SETTLEMENT"
          ? f.forgeCtaGenerateArming
          : agentState === "PROCESSING_PAYMENT"
            ? f.forgeCtaGenerateSigning
            : agentState === "FORGING_MATTER"
              ? forgingTerminalLines[agentTickerIdx % forgingTerminalLines.length]
              : f.forgeCtaGenerateIdle

  const showCollectionLivePanel = shareUrl != null && createdId != null

  const forgeUx = useMemo(() => {
    const hasManualAsset = Boolean(manualFile || manualImageUrl.trim())
    const oracle = forgeMode === "ORACLE"
    const manual = forgeMode === "MANUAL"
    const muteRings = isMintingCollection

    const oracleStep1 = oracle && agentState === "IDLE" && !isMintingCollection
    const oracleStep2 = oracle && agentState === "COMPLETE" && !isMintingCollection
    const oraclePipelineBusy =
      oracle &&
      (agentState === "AWAITING_PAYMENT" ||
        agentState === "ARMING_SETTLEMENT" ||
        agentState === "PROCESSING_PAYMENT" ||
        agentState === "FORGING_MATTER")

    const manualStep1 = manual && !hasManualAsset && !isMintingCollection && !namePriceLocked
    const manualStep2 = manual && hasManualAsset && !isMintingCollection && !namePriceLocked

    const railCurrent: 1 | 2 =
      oracle
        ? agentState === "COMPLETE" || isMintingCollection
          ? 2
          : 1
        : hasManualAsset || isMintingCollection
          ? 2
          : 1

    const railStepAClass = cn(
      "forge-ux-rail__step",
      railCurrent === 2 && "forge-ux-rail__step--done",
      railCurrent === 1 && oraclePipelineBusy && "forge-ux-rail__step--processing",
      railCurrent === 1 && !oraclePipelineBusy && "forge-ux-rail__step--current",
    )
    const railStepBClass = cn("forge-ux-rail__step", railCurrent === 2 && "forge-ux-rail__step--current")

    const oracleSourceRing = cn(
      "forge-field-ring",
      !muteRings && oracleStep1 && "forge-field-ring--active",
      (muteRings || !oracleStep1) && "forge-field-ring--dim",
    )
    const manualSourceRing = cn(
      "forge-field-ring",
      !muteRings && manualStep1 && "forge-field-ring--active",
      (muteRings || !manualStep1) && "forge-field-ring--dim",
    )
    const collectionRing = cn(
      "forge-field-ring mt-1",
      !muteRings && (oracleStep2 || manualStep2) && "forge-field-ring--active",
      ((!muteRings && (oracleStep1 || manualStep1)) || muteRings) && "forge-field-ring--dim",
    )

    const initiateGlow =
      oracle && agentState === "IDLE" && !isMintingCollection && anomalyDescription.trim().length >= 4
    const mintOracleGlow = oracle && agentState === "COMPLETE" && !isMintingCollection
    const mintManualGlow = manual && hasManualAsset && !isMintingCollection

    return {
      hasManualAsset,
      oracleStep1,
      oracleStep2,
      oraclePipelineBusy,
      manualStep1,
      manualStep2,
      railCurrent,
      railStepAClass,
      railStepBClass,
      oracleSourceRing,
      manualSourceRing,
      collectionRing,
      initiateGlow,
      mintOracleGlow,
      mintManualGlow,
    }
  }, [
    forgeMode,
    agentState,
    isMintingCollection,
    manualFile,
    manualImageUrl,
    namePriceLocked,
    anomalyDescription,
  ])

  return (
    <div className="tactical-command-root tactical-command-root--chamber tactical-command-root--cockpit tactical-command-root--stable relative flex h-screen max-h-[100dvh] flex-col overflow-x-hidden overflow-y-hidden font-mono text-foreground antialiased">
      <div className="tactical-film-grain" aria-hidden />
      <div className="tactical-crt-veil" aria-hidden />
      <div className="tactical-crt-fine opacity-50" aria-hidden />
      <TacticalCornerSigil className="pointer-events-none fixed bottom-2 left-2 z-50 hidden opacity-40 sm:block" />

      <header className="relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 bg-black/60 px-3 py-2 backdrop-blur-sm md:px-5">
        <Link href="/" className={forgeNavBtn} onClick={() => playTacticalUiClick()}>
          {f.exit}
        </Link>
        <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-zinc-300 sm:text-sm">
          {f.title}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <LangToggle variant="phosphor" />
          <Link href="/world" className={forgeNavBtn} onClick={() => playTacticalUiClick()}>
            {lang === "es" ? "Mundos" : "World"}
          </Link>
          <Link href="/dashboard" className={forgeNavBtn} onClick={() => playTacticalUiClick()}>
            {n.market}
          </Link>
          <Link href="/chamber" className={forgeNavBtn} onClick={() => playTacticalUiClick()}>
            {n.chamber}
          </Link>
        </div>
      </header>

      <main
        className={cn(
          "custom-scrollbar relative z-10 flex min-h-0 flex-1 flex-col overflow-x-hidden px-3 py-2 md:px-5 md:py-3",
          "overflow-y-auto [-webkit-overflow-scrolling:touch] lg:overflow-hidden",
        )}
      >

        {/* Status strip */}
        {statusStripActive && (
          <div className="mb-2 flex shrink-0 items-center gap-2.5 border border-violet-500/30 bg-violet-950/20 px-3 py-1.5">
            <span className="forge-status-led inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
            <p
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.16em] text-violet-300/90",
                agentState === "PROCESSING_PAYMENT" && "forge-x402-blink",
                agentState === "FORGING_MATTER" && "forge-forge-glitch",
              )}
            >
              {statusLine}
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-2 shrink-0 border border-red-900/50 bg-red-950/20 px-3 py-1.5" role="alert">
            <p className="text-[10px] font-bold uppercase tracking-wider text-red-400">{error}</p>
          </div>
        )}

        {/* Collection live — compact; details in modal */}
        {showCollectionLivePanel && (
          <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2 border border-violet-500/35 bg-violet-950/15 px-2.5 py-1.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-violet-300">
              {f.collectionLive} ·{" "}
              <span className="font-mono text-violet-200/90">
                {f.collectionIdLabel} #{createdId}
              </span>
            </p>
            <button
              type="button"
              onClick={() => {
                playTacticalUiClick()
                setForgeOverlay("collection")
              }}
              className="shrink-0 rounded-sm border border-violet-500/45 bg-violet-950/40 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-violet-200 transition-colors hover:border-violet-400 hover:text-white"
            >
              {f.collectionLiveDetails}
            </button>
          </div>
        )}

        {/* Main grid */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:grid lg:grid-cols-12 lg:items-stretch lg:gap-4">

          {/* ── Left column: form ── */}
          <div className="custom-scrollbar flex min-h-0 flex-col gap-2.5 overflow-x-hidden overflow-y-visible overscroll-contain lg:col-span-7 lg:max-h-full lg:overflow-y-auto lg:pr-1">

            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-zinc-800 pb-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-500">◈ {f.registerTitle}</p>
              {!statusStripActive ? (
                <button
                  type="button"
                  onClick={() => {
                    playTacticalUiClick()
                    setForgeOverlay("protocol")
                  }}
                  className="shrink-0 rounded-sm border border-zinc-700 bg-zinc-900/70 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-zinc-500 transition-colors hover:border-violet-500/45 hover:text-violet-300"
                >
                  {f.protocolBriefButton}
                </button>
              ) : null}
            </div>

            {/* Mode tabs */}
            <div className="flex border border-zinc-800 bg-black/40" role="tablist" aria-label={f.forgeTablistAria}>
              <button
                type="button"
                role="tab"
                aria-selected={forgeMode === "ORACLE"}
                disabled={tabSwitchLocked}
                onClick={() => selectForgeMode("ORACLE")}
                className={cn(
                  "flex-1 py-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors",
                  forgeMode === "ORACLE"
                    ? "border-b-2 border-violet-500 bg-violet-950/25 text-violet-300"
                    : "text-zinc-600 hover:text-zinc-400",
                  tabSwitchLocked && "cursor-not-allowed opacity-40",
                )}
              >
                {f.tabOracle}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={forgeMode === "MANUAL"}
                disabled={tabSwitchLocked}
                onClick={() => selectForgeMode("MANUAL")}
                className={cn(
                  "flex-1 border-l border-zinc-800 py-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors",
                  forgeMode === "MANUAL"
                    ? "border-b-2 border-violet-500 bg-violet-950/25 text-violet-300"
                    : "text-zinc-600 hover:text-zinc-400",
                  tabSwitchLocked && "cursor-not-allowed opacity-40",
                )}
              >
                {f.tabManual}
              </button>
            </div>

            {/* IPFS hint */}
            {ipfsConfigured === false && (
              <div className="border border-violet-500/20 bg-violet-950/10 px-2.5 py-2 text-[10px] text-violet-400/80">
                {f.ipfsOracleHint}
              </div>
            )}

            <TrustlineButton
              address={address}
              onRequestConnect={onTrustlineRequestConnect}
              onReady={onTrustlineReady}
              hero
            />

            {/* Oracle source fields */}
            {forgeMode === "ORACLE" ? (
              <div className="space-y-2">
                <div>
                  <label htmlFor="forge-anomaly" className={inputLabelClass}>
                    {f.anomalyLabel}
                  </label>
                  <textarea
                    id="forge-anomaly"
                    value={anomalyDescription}
                    onChange={(e) => setAnomalyDescription(e.target.value)}
                    disabled={anomalyFieldLocked}
                    placeholder={f.placeholders.anomaly}
                    rows={3}
                    className={cn(oraclePromptTextareaClass, "mt-1")}
                    autoComplete="off"
                    spellCheck={lang === "es"}
                  />
                  <p className="mt-1 text-[10px] leading-snug text-zinc-600">{f.oracleHint}</p>
                </div>
                <div>
                  <label htmlFor="forge-style-mode" className={inputLabelClass}>
                    {f.oracleStyleLabel}
                  </label>
                  <select
                    id="forge-style-mode"
                    value={oracleImageStyleMode}
                    onChange={(e) => setOracleImageStyleMode(e.target.value as OracleImageStyleMode)}
                    disabled={anomalyFieldLocked}
                    className={cn(inputClass, "mt-1")}
                  >
                    <option value="adaptive">{f.oracleStyleAdaptive}</option>
                    <option value="cyber">{f.oracleStyleCyber}</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  ref={manualFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  aria-hidden
                  tabIndex={-1}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file?.type.startsWith("image/")) setManualFile(file)
                    e.target.value = ""
                  }}
                />
                <div>
                  <p className={inputLabelClass}>{f.manualDropLabel}</p>
                  <button
                    type="button"
                    disabled={namePriceLocked}
                    onClick={() => manualFileInputRef.current?.click()}
                    onDragEnter={(e) => { e.preventDefault(); setManualDropActive(true) }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy" }}
                    onDragLeave={(e) => { e.preventDefault(); setManualDropActive(false) }}
                    onDrop={(e) => {
                      e.preventDefault()
                      setManualDropActive(false)
                      const file = e.dataTransfer.files?.[0]
                      if (file?.type.startsWith("image/")) setManualFile(file)
                    }}
                    className={cn(
                      "mt-1 flex min-h-[5rem] w-full flex-col items-center justify-center border border-dashed px-3 py-3 text-center transition-colors",
                      manualDropActive
                        ? "border-violet-500/50 bg-violet-950/15"
                        : "border-zinc-800 bg-black/30 hover:border-zinc-700",
                      namePriceLocked && "pointer-events-none opacity-40",
                    )}
                  >
                    <span className="text-[11px] font-semibold text-zinc-400">
                      {manualFile ? manualFile.name : f.manualAwaitingHint}
                    </span>
                    <span className="mt-1 text-[9px] text-zinc-600">{f.manualDropHint}</span>
                  </button>
                  {manualFile ? (
                    <button
                      type="button"
                      disabled={namePriceLocked}
                      onClick={() => setManualFile(null)}
                      className="mt-1 text-[10px] font-medium text-zinc-500 underline-offset-2 hover:text-zinc-300"
                    >
                      {f.manualClearFile}
                    </button>
                  ) : null}
                </div>
                <div>
                  <label htmlFor="forge-manual-url" className={inputLabelClass}>
                    {f.manualUrlLabel}
                  </label>
                  <input
                    id="forge-manual-url"
                    value={manualImageUrl}
                    onChange={(e) => setManualImageUrl(e.target.value)}
                    disabled={namePriceLocked}
                    placeholder={f.placeholders.manualImageUrl}
                    className={cn(inputClass, "mt-1")}
                    autoComplete="off"
                  />
                </div>
              </div>
            )}

            {/* Action buttons — arriba del resto para generar sin scroll */}
            <div className="space-y-2 border-t border-zinc-800/60 pt-2.5">
              {!address ? (
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => {
                    playTacticalUiClick()
                    void connect().then(() => refresh()).catch(() => {})
                  }}
                  className="flex min-h-[46px] w-full items-center justify-center bg-gradient-to-r from-violet-600 to-cyan-500 py-3 text-center text-[12px] font-semibold tracking-tight text-white shadow-[0_0_18px_rgba(139,92,246,0.35)] transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {connecting ? f.linking : f.linkWallet}
                </button>
              ) : (
                <>
                  {forgeMode === "MANUAL" ? (
                    <button
                      type="button"
                      disabled={isMintingCollection || actionLockedByProtocol}
                      onClick={() => {
                        playTacticalUiClick()
                        void handleManualUploadAndMint().catch(() => {})
                      }}
                      className={cn(
                        "flex min-h-[46px] w-full items-center justify-center bg-gradient-to-r from-violet-600 to-cyan-500 py-3 text-center text-[12px] font-semibold tracking-tight text-white shadow-[0_0_18px_rgba(139,92,246,0.35)] transition-opacity hover:opacity-90 disabled:opacity-40",
                        isMintingCollection && "forge-forge-glitch",
                      )}
                    >
                      {isMintingCollection ? statusLine || f.deploying : f.manualUploadMint}
                    </button>
                  ) : agentState === "COMPLETE" ? (
                    <button
                      type="button"
                      disabled={isMintingCollection || actionLockedByProtocol}
                      onClick={() => {
                        playTacticalUiClick()
                        void handleMintArtifact().catch(() => {})
                      }}
                      className={cn(
                        "flex min-h-[46px] w-full items-center justify-center bg-gradient-to-r from-violet-600 to-cyan-500 py-3 text-center text-[12px] font-semibold tracking-tight text-white shadow-[0_0_18px_rgba(139,92,246,0.35)] transition-opacity hover:opacity-90 disabled:opacity-40",
                        isMintingCollection && "forge-forge-glitch",
                      )}
                    >
                      {isMintingCollection ? statusLine || f.deploying : f.forgeCtaMintArtifact}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || actionLockedByProtocol}
                      onClick={() => {
                        playTacticalUiClick()
                        void handleForgeAgent().catch(() => {})
                      }}
                      className={cn(
                        "flex min-h-[46px] w-full items-center justify-center bg-gradient-to-r from-violet-600 to-cyan-500 py-3 text-center text-[12px] font-semibold tracking-tight text-white shadow-[0_0_18px_rgba(139,92,246,0.35)] transition-opacity hover:opacity-90 disabled:opacity-40",
                        agentState === "PROCESSING_PAYMENT" && "forge-x402-blink",
                        agentState === "FORGING_MATTER" && "forge-forge-glitch",
                      )}
                    >
                      {initiatePrimaryLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      playTacticalUiClick()
                      disconnect()
                      void refresh().catch(() => {})
                    }}
                    className="flex w-full items-center justify-center border border-zinc-800 py-1.5 text-[10px] uppercase tracking-widest text-zinc-700 transition-colors hover:border-red-900/60 hover:text-red-500"
                  >
                    {f.disconnect}
                  </button>
                </>
              )}
            </div>

            {forgeMode === "MANUAL" ? (
              <div className="space-y-1.5 pt-1">
                <label htmlFor="forge-manual-lore" className={inputLabelClass}>
                  {f.manualLoreLabel}
                </label>
                <textarea
                  id="forge-manual-lore"
                  value={manualLoreDraft}
                  onChange={(e) => setManualLoreDraft(e.target.value)}
                  disabled={namePriceLocked}
                  placeholder={f.manualLorePlaceholder}
                  rows={2}
                  className={cn(oraclePromptTextareaClass, "mt-1")}
                  autoComplete="off"
                  spellCheck={lang === "es"}
                />
              </div>
            ) : null}

            <div className="mt-2 space-y-2 border-t border-zinc-800/70 pt-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                {f.forgeSectionLaterOptions}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="forge-name" className={inputLabelClass}>
                    {f.collectionName}
                  </label>
                  <input
                    id="forge-name"
                    value={name}
                    onChange={(e) => {
                      const v = e.target.value
                      setName(v)
                      if (error === f.errors.nameShort && v.trim().length >= 2) setError(null)
                    }}
                    maxLength={64}
                    disabled={namePriceLocked}
                    placeholder={f.placeholders.collectionName}
                    className={cn(inputClass, "mt-1")}
                  />
                </div>
                <div>
                  <label htmlFor="forge-price" className={inputLabelClass}>
                    {textWithPhaserLiqLinks(f.fusionPrice)}
                  </label>
                  <input
                    id="forge-price"
                    value={priceLiq}
                    onChange={(e) => setPriceLiq(e.target.value)}
                    inputMode="decimal"
                    disabled={namePriceLocked}
                    placeholder={f.placeholders.price}
                    className={cn(inputClass, "mt-1")}
                  />
                </div>
              </div>
              <p className="font-mono text-[10px] tabular-nums text-zinc-600">
                <span>{f.readout}</span>
                <span className="mx-1.5 select-none text-zinc-800" aria-hidden>
                  →
                </span>
                <span className="text-zinc-300">{priceReadout}</span>
                <span className="ml-1.5 inline-flex items-center">
                  <PhaserLiqExpertLink>
                    <TokenIcon className="h-3.5 w-3.5 shrink-0" />
                    {PHASER_LIQ_SYMBOL}
                  </PhaserLiqExpertLink>
                </span>
              </p>
            </div>

            {address ? (
              <div className="space-y-1.5 border-t border-zinc-800/60 pt-2 text-[11px]">
                <p className="text-zinc-500">
                  {f.walletLabel}: <span className="text-zinc-300">{truncateAddress(address)}</span>
                </p>
                <p className="font-mono tabular-nums text-zinc-600">
                  {ch.liqBalance}: <span className="text-zinc-300">{stroopsToLiqDisplay(tokenBalance)} </span>
                  <PhaserLiqExpertLink />
                </p>
              </div>
            ) : null}
          </div>

          {/* ── Right column: preview + rewards launcher ── */}
          <div className="flex min-h-0 flex-1 flex-col gap-2 lg:col-span-5">
            <p className="shrink-0 border-b border-zinc-800 pb-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-500">
              {f.artPreview}
            </p>

            <div
              className={cn(
                "flex min-h-0 flex-1 items-center justify-center border border-zinc-800/60 bg-black/25",
                showCollectionLivePanel
                  ? "min-h-[min(100px,18vh)] lg:min-h-0"
                  : "min-h-[min(160px,26vh)] lg:min-h-0",
              )}
            >
              {previewSrc ? (
                <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 p-2 sm:p-3">
                  <IpfsDisplayImg
                    uri={previewSrc}
                    className={cn(
                      "max-w-full object-contain",
                      showCollectionLivePanel
                        ? "max-h-[min(22vh,180px)] lg:max-h-[min(32vh,260px)]"
                        : "max-h-[min(38vh,320px)] lg:max-h-[min(48vh,380px)]",
                    )}
                    loading="lazy"
                  />
                  {previewLoreText ? (
                    <button
                      type="button"
                      onClick={() => {
                        playTacticalUiClick()
                        setForgeOverlay("lore")
                      }}
                      className="custom-scrollbar max-h-16 w-full max-w-lg overflow-hidden border border-zinc-700/80 bg-black/45 px-2 py-1.5 text-left transition-colors hover:border-violet-500/40 hover:bg-violet-950/15"
                      aria-label={f.loreExpandHint}
                    >
                      <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-600">{f.lorePreview}</p>
                      <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap font-mono text-[10px] leading-snug text-zinc-300">
                        {previewLoreText}
                      </p>
                      <p className="mt-1 text-[8px] uppercase tracking-widest text-zinc-600">{f.loreExpandHint}</p>
                    </button>
                  ) : null}
                </div>
              ) : (
                <span className="px-4 text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.2em] text-zinc-800">
                  {forgeMode === "MANUAL" ? f.manualAwaiting : f.awaitingFeed}
                </span>
              )}
            </div>

            {address ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border border-zinc-800/60 bg-black/30 px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="h-1 overflow-hidden rounded bg-cyan-950/70">
                    <div
                      className="h-full bg-cyan-300/75 transition-[width]"
                      style={{ width: `${faucetBrief?.questOverview?.progressPct ?? 0}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-[8px] uppercase tracking-[0.16em] text-zinc-600">
                    {ch.rewardsQuestProgress}{" "}
                    <span className="tabular-nums text-zinc-400">
                      {faucetBrief?.questOverview
                        ? `${faucetBrief.questOverview.completed}/${faucetBrief.questOverview.total}`
                        : "—/—"}
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    playTacticalUiClick()
                    setForgeOverlay("rewards")
                  }}
                  className="shrink-0 rounded-sm border border-cyan-500/45 bg-cyan-950/35 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-200 transition-colors hover:border-cyan-300 hover:text-white"
                >
                  {f.rewardsPanelButton}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </main>

      {forgeOverlay && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[260] flex items-end justify-center sm:items-center sm:p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="forge-overlay-title"
            >
              <button
                type="button"
                className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
                aria-label={ch.operatorPanelBackdropClose}
                onClick={() => setForgeOverlay(null)}
              />
              <div
                className="relative flex max-h-[min(90dvh,820px)] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-zinc-700 bg-zinc-950 shadow-[0_-12px_48px_rgba(0,0,0,0.55)] sm:rounded-xl sm:shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2.5 sm:px-4">
                  <h2
                    id="forge-overlay-title"
                    className="text-left text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-300"
                  >
                    {forgeOverlay === "rewards"
                      ? f.rewardsPanelTitle
                      : forgeOverlay === "protocol"
                        ? forgeMode === "ORACLE"
                          ? f.protocolBriefTitleOracle
                          : f.protocolBriefTitleManual
                        : forgeOverlay === "lore"
                          ? f.lorePreview
                          : f.collectionLive}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      playTacticalUiClick()
                      setForgeOverlay(null)
                    }}
                    className="rounded-sm border border-zinc-600 px-2 py-1 font-mono text-sm leading-none text-zinc-300 transition-colors hover:bg-zinc-900"
                    aria-label={f.rewardsPanelClose}
                  >
                    ×
                  </button>
                </div>
                <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4 sm:pb-4">
                  {forgeOverlay === "rewards" && address ? (
                    <LiquidityFaucetControl
                      address={address}
                      tokenBalance={tokenBalance}
                      compact
                      onRefreshBalance={refreshLiqBalance}
                      className="border-zinc-800/80 bg-zinc-900/30"
                      freighterNftCollect={
                        collectionPhaseTokenId != null ? { tokenId: collectionPhaseTokenId } : null
                      }
                    />
                  ) : null}
                  {forgeOverlay === "protocol" ? (
                    <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-400">
                      {forgeMode === "ORACLE" ? f.intro : f.manualIntro}
                    </p>
                  ) : null}
                  {forgeOverlay === "lore" && previewLoreText ? (
                    <p className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-zinc-300">
                      {previewLoreText}
                    </p>
                  ) : null}
                  {forgeOverlay === "collection" && showCollectionLivePanel ? (
                    <div className="space-y-3">
                      <p className="font-mono text-[11px] text-zinc-400">
                        {f.collectionIdLabel} <span className="text-violet-300">#{createdId}</span>
                      </p>
                      <a
                        href={shareUrl ?? undefined}
                        className="block break-all text-[10px] text-violet-400/90 underline-offset-2 hover:text-violet-300"
                      >
                        {shareUrl}
                      </a>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void copyShare().catch(() => {})}
                          className="inline-flex items-center border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-[10px] uppercase tracking-widest text-zinc-400 transition-colors hover:border-violet-500/50 hover:text-violet-300"
                        >
                          {copied ? f.copied : f.copy}
                        </button>
                        <Link
                          href={`/chamber?collection=${createdId}`}
                          className="inline-flex items-center border border-violet-600/50 bg-violet-950/40 px-3 py-1.5 text-[10px] uppercase tracking-widest text-violet-300 transition-colors hover:bg-violet-950/60"
                        >
                          {f.openChamber}
                        </Link>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
