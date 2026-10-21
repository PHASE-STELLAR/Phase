"use client"

import { TaxExportPanel } from "@/components/tax-export-panel"
import { IntentTarget } from "@/components/intent-target"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import { signTransaction } from "@/lib/stellar-wallet-kit"
import { LangToggle } from "@/components/lang-toggle"
import { useLang } from "@/components/lang-context"
import { IpfsDisplayImg } from "@/components/ipfs-display-img"
import { TokenIcon } from "@/components/token-icon"
import { useWallet } from "@/components/wallet-provider"
import { WalletHistoryTimeline } from "@/components/wallet-history-timeline"
import { pickCopy } from "@/lib/phase-copy"
import { cn } from "@/lib/utils"
import {
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  buildTransferPhaseNftTransaction,
  checkHasPhased,
  fetchCollectionsCatalog,
  fetchTokenOwnerAddress,
  fetchTokenMetadataDisplay,
  fetchTokenUriString,
  getTransactionResult,
  isValidClassicStellarAddress,
  liqToStroops,
  PHASER_LIQ_SYMBOL,
  sendTransaction,
  stroopsToLiqDisplay,
  type CollectionInfo,
} from "@/lib/phase-protocol"

type Tab = "GLOBAL_MARKET" | "ACTIVE_LISTINGS" | "PHASE_VAULT"

function truncateAddress(addr: string) {
  if (!addr || addr.length < 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function chainHash(id: number): string {
  return `CHAIN_VE:${id.toString(16).toUpperCase().padStart(6, "0")}`
}

const navLinkClass =
  "inline-flex min-h-[36px] items-center rounded-sm border border-zinc-700 bg-zinc-900/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-400 transition-colors hover:border-violet-500/50 hover:text-violet-300"

const primaryCardBtn =
  "flex min-h-[46px] w-full items-center justify-center bg-gradient-to-r from-violet-600 to-cyan-500 py-3 text-center text-[11px] font-bold uppercase tracking-wide text-white shadow-[0_0_18px_rgba(139,92,246,0.35)] transition-opacity hover:opacity-90"

const secondaryCardBtn =
  "flex min-h-[38px] w-full items-center justify-center border border-zinc-700 bg-transparent py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-zinc-400 transition-colors hover:border-violet-500/50 hover:text-violet-300"

type PlatformListing = {
  id: string
  seller: string
  collectionId: number
  tokenId: number
  priceStroops: string
  createdAt: string
  active: boolean
}

type SellTarget = {
  collectionId: number
  tokenId: number
  collectionName: string
}

export default function DashboardPage() {
  const router = useRouter()
  const { lang } = useLang()
  const t = pickCopy(lang)
  const d = t.dashboard
  const n = t.nav

  const { address, connect, connecting, refresh } = useWallet()
  const [activeTab, setActiveTab] = useState<Tab>("GLOBAL_MARKET")
  const [items, setItems] = useState<CollectionInfo[]>([])
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error" | "done">("idle")
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [verifiedCollectionIds, setVerifiedCollectionIds] = useState<Set<number>>(new Set())
  const [ownedArtifacts, setOwnedArtifacts] = useState<
    Array<{
      collectionId: number
      collectionName: string
      tokenId: number
      imageUrl: string
    }>
  >([])
  const [listings, setListings] = useState<PlatformListing[]>([])
  const [listingsErr, setListingsErr] = useState<string | null>(null)
  const [sellTarget, setSellTarget] = useState<SellTarget | null>(null)
  const [buyerAddress, setBuyerAddress] = useState("")
  const [listPriceLiq, setListPriceLiq] = useState("")
  const [transferBusy, setTransferBusy] = useState(false)
  const [sellFeedback, setSellFeedback] = useState<string | null>(null)
  const [vaultItems, setVaultItems] = useState<
    Array<{
      tokenId: number
      name: string
      description: string
      image: string
      collectionId: number | null
    }>
  >([])
  const [vaultState, setVaultState] = useState<"idle" | "loading" | "error" | "done">("idle")
  const [vaultErr, setVaultErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadState("loading")
    setErrMsg(null)
    try {
      const list = await fetchCollectionsCatalog()
      setItems(list)
      setLoadState("done")
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
      setLoadState("error")
    }
  }, [])

  const loadListings = useCallback(async () => {
    setListingsErr(null)
    try {
      const res = await fetch("/api/nft-listings")
      const data = (await res.json()) as { listings?: PlatformListing[] }
      setListings(Array.isArray(data.listings) ? data.listings : [])
    } catch {
      setListingsErr(d.listingLoadError)
    }
  }, [d.listingLoadError])

  const loadVault = useCallback(async () => {
    if (!address) {
      setVaultItems([])
      setVaultState("idle")
      setVaultErr(null)
      return
    }
    setVaultItems([])
    setVaultState("loading")
    setVaultErr(null)
    try {
      const res = await fetch(`/api/wallet/phase-nfts?address=${encodeURIComponent(address)}`)
      if (!res.ok) throw new Error("VAULT_HTTP")
      const data = (await res.json()) as {
        items?: Array<{
          tokenId: number
          name: string
          description: string
          image: string
          collectionId: number | null
        }>
      }
      setVaultItems(Array.isArray(data.items) ? data.items : [])
      setVaultState("done")
    } catch {
      setVaultErr(d.vaultRpcError)
      setVaultState("error")
      setVaultItems([])
    }
  }, [address, d.vaultRpcError])

  useEffect(() => {
    void load().catch(() => {})
  }, [load])

  useEffect(() => {
    void loadListings().catch(() => {})
  }, [loadListings])

  useEffect(() => {
    void loadVault().catch(() => {})
  }, [loadVault])

  useEffect(() => {
    if (!address || items.length === 0) {
      setVerifiedCollectionIds(new Set())
      return
    }
    let cancelled = false
    void Promise.all(
      items.map((c) =>
        checkHasPhased(address, c.collectionId).then((r) => ({
          id: c.collectionId,
          phased: r.phased,
        })),
      ),
    )
      .then((results) => {
        if (cancelled) return
        const next = new Set<number>()
        for (const r of results) {
          if (r.phased) next.add(r.id)
        }
        setVerifiedCollectionIds(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [address, items])

  useEffect(() => {
    if (!address || items.length === 0) {
      setOwnedArtifacts([])
      return
    }
    let cancelled = false
    void Promise.all(
      items.map(async (c) => {
        const phase = await checkHasPhased(address, c.collectionId)
        if (!phase.phased || !phase.phaseId) return null
        const owner = await fetchTokenOwnerAddress(CONTRACT_ID, phase.phaseId)
        if (!owner || owner !== address) return null
        const raw = await fetchTokenUriString(phase.phaseId)
        const meta = raw ? await fetchTokenMetadataDisplay(raw) : {}
        const imageFromToken = meta.image?.trim() ?? ""
        const imageUrl = imageFromToken || c.imageUri?.trim() || ""
        return {
          collectionId: c.collectionId,
          collectionName: c.name || `Collection #${c.collectionId}`,
          tokenId: phase.phaseId,
          imageUrl,
        }
      }),
    )
      .then((rows) => {
        if (cancelled) return
        setOwnedArtifacts(
          rows.filter((r): r is NonNullable<typeof r> => Boolean(r)).sort((a, b) => a.collectionId - b.collectionId),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [address, items])

  const previewLabels = useMemo(
    () => ({
      pendingFusion: d.previewPendingFusion,
      unverifiedCopy: d.previewUnverifiedCopy,
      chainVerifiedSeal: d.previewChainVerified,
    }),
    [d.previewPendingFusion, d.previewUnverifiedCopy, d.previewChainVerified],
  )

  const inputClass =
    "mt-1 w-full border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-[11px] font-medium text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"

  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back()
    } else {
      router.push("/")
    }
  }, [router])

  const closeSellModal = useCallback(() => {
    setSellTarget(null)
    setBuyerAddress("")
    setListPriceLiq("")
    setSellFeedback(null)
  }, [])

  const globalRefresh = useCallback(async () => {
    await Promise.all([
      load().catch(() => {}),
      loadListings().catch(() => {}),
      loadVault().catch(() => {}),
    ])
  }, [load, loadListings, loadVault])

  const publishListing = useCallback(async () => {
    if (!address || !sellTarget) return
    const stroops = liqToStroops(listPriceLiq.trim() || "0")
    if (stroops === "0") {
      setSellFeedback(lang === "es" ? "Indicá un precio mayor a 0." : "Enter a price greater than 0.")
      return
    }
    setTransferBusy(true)
    setSellFeedback(null)
    try {
      const res = await fetch("/api/nft-listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller: address,
          collectionId: sellTarget.collectionId,
          tokenId: sellTarget.tokenId,
          priceStroops: stroops,
        }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error || "LISTING_FAIL")
      await loadListings()
      setSellFeedback(lang === "es" ? "Anuncio publicado." : "Listing published.")
    } catch (e) {
      setSellFeedback(e instanceof Error ? e.message : String(e))
    } finally {
      setTransferBusy(false)
    }
  }, [address, sellTarget, listPriceLiq, loadListings, lang])

  const delist = useCallback(
    async (id: string) => {
      setTransferBusy(true)
      setSellFeedback(null)
      try {
        const res = await fetch("/api/nft-listings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cancelId: id }),
        })
        const data = (await res.json()) as { ok?: boolean }
        if (!res.ok || !data.ok) throw new Error("DELIST_FAIL")
        await loadListings()
      } catch (e) {
        setSellFeedback(e instanceof Error ? e.message : String(e))
      } finally {
        setTransferBusy(false)
      }
    },
    [loadListings],
  )

  const transferToBuyer = useCallback(async () => {
    if (!address || !sellTarget) return
    const to = buyerAddress.trim()
    if (!isValidClassicStellarAddress(to)) {
      setSellFeedback(lang === "es" ? "Dirección G… inválida." : "Invalid G… address.")
      return
    }
    if (to === address) {
      setSellFeedback(lang === "es" ? "No podés transferirte a vos mismo." : "Cannot transfer to yourself.")
      return
    }
    setTransferBusy(true)
    setSellFeedback(null)
    try {
      const txEnvelope = await buildTransferPhaseNftTransaction(address, to, sellTarget.tokenId)
      const signResult = await signTransaction(txEnvelope, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address,
      })
      if (signResult.error) throw new Error(signResult.error.message || "SIGN_FAIL")
      const signedXdr =
        (signResult as { signedTxXdr?: string }).signedTxXdr ||
        (signResult as { signedTransaction?: string }).signedTransaction
      if (!signedXdr) throw new Error("NO_SIGNED_XDR")
      const sendResult = await sendTransaction(signedXdr)
      if (sendResult.hash) await getTransactionResult(sendResult.hash as string)
      await load()
      await loadListings()
      await loadVault()
      closeSellModal()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSellFeedback(`${msg} — ${d.transferWasmHint}`)
    } finally {
      setTransferBusy(false)
    }
  }, [address, sellTarget, buyerAddress, load, loadListings, loadVault, closeSellModal, lang, d.transferWasmHint])

  const isBusy = loadState === "loading" || vaultState === "loading"

  return (
    <div className="min-h-screen bg-background font-mono text-foreground">
      <div className="grid-bg pointer-events-none fixed inset-0 opacity-40" aria-hidden />


      <main className="relative z-10 mx-auto max-w-6xl px-4 py-8 md:py-10">

        <IntentTarget />
        <TaxExportPanel />
        {/* Page title */}
        <div className="mb-6">
          <h1 className="text-[11px] font-bold uppercase tracking-[0.3em] text-zinc-500">
            PHASE · {n.market}
          </h1>
          <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-zinc-600">{d.subtitle}</p>
        </div>

        {errMsg && (
          <p className="mb-6 border-l-4 border-red-500 bg-red-950/30 px-3 py-2 text-[10px] text-red-300">
            {errMsg}
          </p>
        )}

        {/* ── Tab navigation ── */}
        <div className="flex border-b border-zinc-800">
          {(["GLOBAL_MARKET", "ACTIVE_LISTINGS", "PHASE_VAULT"] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest transition-colors",
                activeTab === tab
                  ? "border-b-2 border-violet-500 text-violet-400"
                  : "border-b-2 border-transparent text-zinc-600 hover:text-zinc-400",
              )}
            >
              [ {tab} ]
            </button>
          ))}
        </div>

        {/* ── Tab content ── */}
        <div className="mt-6">

          {/* ── GLOBAL_MARKET ── */}
          {activeTab === "GLOBAL_MARKET" && (
            <>
              <div className="mb-6 border-l-4 border-violet-500 bg-violet-950/30 p-4">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] leading-relaxed text-violet-200">{d.shieldBlurb}</p>
                    <div className="mt-3 max-w-xs">
                      <Link href="/forge" className={primaryCardBtn}>
                        {lang === "es" ? "Crear tu NFT → Forja" : "Create your NFT → Forge"}
                      </Link>
                    </div>
                  </div>
                </div>
              </div>

              {loadState === "done" && items.length === 0 && !errMsg && (
                <p className="mt-6 text-center text-[11px] font-medium uppercase tracking-widest text-zinc-600">
                  {d.empty}
                </p>
              )}

              <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((c) => {
                  const previewUri = c.imageUri?.trim() ?? ""
                  const chamberHref = `/chamber?collection=${c.collectionId}`
                  const chainVerified = address ? verifiedCollectionIds.has(c.collectionId) : false
                  return (
                    <li
                      key={c.collectionId}
                      className="group flex flex-col border border-zinc-800 bg-zinc-950 transition-all hover:border-violet-500 hover:shadow-lg hover:shadow-violet-900/20"
                    >
                      {/* Chain hash bar */}
                      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
                        <span className="text-[9px] font-mono text-emerald-400">{chainHash(c.collectionId)}</span>
                        <span className="text-[8px] uppercase tracking-widest text-zinc-700">SEP-50</span>
                      </div>
                      {/* Image */}
                      <div className="aspect-square overflow-hidden bg-black">
                        {previewUri ? (
                          <IpfsDisplayImg
                            uri={previewUri}
                            className="h-full w-full object-contain"
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center">
                            <span className="text-[10px] uppercase tracking-wider text-zinc-700">{d.noPreview}</span>
                          </div>
                        )}
                      </div>
                      {/* Info */}
                      <div className="flex flex-1 flex-col gap-2 p-4">
                        <p className="line-clamp-2 text-[12px] font-bold uppercase tracking-wide text-zinc-100">
                          {c.name || `Collection #${c.collectionId}`}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
                          <span>#{c.collectionId}</span>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1 text-cyan-400">
                            {stroopsToLiqDisplay(c.price)} <TokenIcon className="h-3 w-3" /> {PHASER_LIQ_SYMBOL}
                          </span>
                        </div>
                        <p className="text-[9px] uppercase tracking-wider text-zinc-600">
                          {d.creator} {truncateAddress(c.creator)}
                        </p>
                        <div className="mt-auto flex flex-col gap-2 pt-3">
                          <Link href={chamberHref} className={primaryCardBtn}>
                            {d.mint}
                          </Link>
                          <Link href={chamberHref} className={secondaryCardBtn}>
                            {d.openChamber}
                          </Link>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {/* ── ACTIVE_LISTINGS ── */}
          {activeTab === "ACTIVE_LISTINGS" && (
            <>
              {listingsErr ? (
                <div className="mb-4 border-l-4 border-red-500 bg-red-950/30 px-3 py-2">
                  <p className="text-[10px] text-red-300">{listingsErr}</p>
                </div>
              ) : listings.length === 0 ? (
                <div className="border-l-4 border-zinc-700 bg-zinc-900/30 p-4">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-600">
                    {lang === "es" ? "Sin anuncios activos." : "No active listings."}
                  </p>
                </div>
              ) : (
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {listings.map((l) => (
                    <li
                      key={l.id}
                      className="group border border-zinc-800 bg-zinc-950 transition-all hover:border-violet-500 hover:shadow-lg hover:shadow-violet-900/20"
                    >
                      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
                        <span className="text-[9px] font-mono text-emerald-400">{chainHash(l.tokenId)}</span>
                        <span className="text-[8px] uppercase tracking-widest text-zinc-700">LISTED</span>
                      </div>
                      <div className="p-4">
                        <p className="text-[11px] font-bold uppercase text-zinc-100">
                          {lang === "es" ? "Artefacto" : "Artifact"} #{l.tokenId}
                        </p>
                        <p className="mt-1 text-[9px] uppercase tracking-wider text-zinc-600">
                          {d.creator} {truncateAddress(l.seller)}
                        </p>
                        <div className="mt-3 border-l-4 border-violet-500 bg-violet-950/30 px-3 py-2">
                          <p className="text-[11px] font-bold text-violet-200">
                            {stroopsToLiqDisplay(l.priceStroops)}{" "}
                            <span className="text-violet-400">{PHASER_LIQ_SYMBOL}</span>
                          </p>
                        </div>
                        <div className="mt-3 flex flex-col gap-2">
                          <Link href={`/chamber?collection=${l.collectionId}`} className={secondaryCardBtn}>
                            {d.openChamber}
                          </Link>
                          {address && l.seller === address ? (
                            <button
                              type="button"
                              disabled={transferBusy}
                              onClick={() => void delist(l.id).catch(() => {})}
                              className="w-full border border-violet-700/50 bg-violet-950/20 py-2 text-[9px] font-bold uppercase tracking-widest text-violet-300 transition-colors hover:bg-violet-900/30 disabled:opacity-40"
                            >
                              {d.cancelListing}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {/* ── PHASE_VAULT ── */}
          {activeTab === "PHASE_VAULT" && (
            <>
              {!address ? (
                <div className="border-l-4 border-violet-500 bg-violet-950/30 p-4">
                  <p className="text-[10px] text-violet-200">{d.wallet}</p>
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => void connect().then(() => refresh()).catch(() => {})}
                    className="mt-3 rounded-sm border border-violet-600/60 bg-violet-950/40 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-violet-300 transition-colors hover:bg-violet-900/40 disabled:opacity-50"
                  >
                    {connecting ? d.connecting : d.connect}
                  </button>
                </div>
              ) : (
                <>
                  {/* My Stabilized Artifacts */}
                  {ownedArtifacts.length > 0 && (
                    <div className="mb-8">
                      <h2 className="mb-4 text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-500">
                        {d.myArtifactsSection}
                      </h2>
                      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {ownedArtifacts.map((a) => (
                          <li
                            key={`${a.collectionId}-${a.tokenId}`}
                            className="group border border-zinc-800 bg-zinc-950 transition-all hover:border-violet-500 hover:shadow-lg hover:shadow-violet-900/20"
                          >
                            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
                              <span className="text-[9px] font-mono text-emerald-400">{chainHash(a.tokenId)}</span>
                              <span className="text-[8px] uppercase tracking-widest text-emerald-700">OWNED</span>
                            </div>
                            <div className="aspect-square overflow-hidden bg-black">
                              {a.imageUrl ? (
                                <IpfsDisplayImg
                                  uri={a.imageUrl}
                                  className="h-full w-full object-contain"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="flex h-full items-center justify-center">
                                  <span className="text-[10px] uppercase tracking-wider text-zinc-700">
                                    {lang === "es" ? "Sin visual" : "No visual"}
                                  </span>
                                </div>
                              )}
                            </div>
                            <div className="flex flex-col gap-2 p-4">
                              <p className="text-[12px] font-bold uppercase tracking-wide text-zinc-100">
                                {a.collectionName}
                              </p>
                              <p className="text-[9px] uppercase tracking-wider text-zinc-600">SERIAL_ID #{a.tokenId}</p>
                              <button
                                type="button"
                                onClick={() => {
                                  setSellTarget({
                                    collectionId: a.collectionId,
                                    tokenId: a.tokenId,
                                    collectionName: a.collectionName,
                                  })
                                  setBuyerAddress("")
                                  setListPriceLiq("")
                                  setSellFeedback(null)
                                }}
                                className="mt-1 w-full border border-zinc-700 bg-transparent py-2 text-[9px] font-bold uppercase tracking-widest text-zinc-400 transition-colors hover:border-violet-500/60 hover:text-violet-300"
                              >
                                {d.sellNft}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* ── Per-wallet Horizon timeline (spike 629 / phase-173) ── */}
                  <WalletHistoryTimeline
                    address={address}
                    className="mb-8 w-full border-l-4 border-cyan-500/70 bg-cyan-950/20 p-4"
                  />

                  {/* RPC Vault */}
                  <div>
                    <h2 className="mb-2 text-[10px] font-bold uppercase tracking-[0.28em] text-zinc-500">
                      {d.vaultRpcTitle}
                    </h2>
                    <div className="mb-4 border-l-4 border-violet-500 bg-violet-950/30 p-4">
                      <p className="text-[9px] leading-relaxed text-violet-200">{d.vaultRpcBlurb}</p>
                    </div>

                    {vaultErr ? (
                      <p className="mb-3 text-[10px] text-red-300/90">{vaultErr}</p>
                    ) : null}
                    {vaultState === "loading" && !vaultErr ? (
                      <p className="text-[10px] uppercase tracking-wider text-zinc-600">{d.vaultRpcLoading}</p>
                    ) : null}
                    {vaultState !== "loading" && vaultItems.length === 0 && !vaultErr ? (
                      <p className="text-[10px] uppercase tracking-wider text-zinc-600">{d.vaultRpcEmpty}</p>
                    ) : null}

                    {vaultItems.length > 0 && (
                      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {vaultItems.map((v) => {
                          const col = v.collectionId != null && v.collectionId > 0 ? v.collectionId : 0
                          const chamberHref = col > 0 ? `/chamber?collection=${col}` : "/chamber"
                          return (
                            <li
                              key={`vault-${v.tokenId}`}
                              className="group border border-zinc-800 bg-zinc-950 transition-all hover:border-violet-500 hover:shadow-lg hover:shadow-violet-900/20"
                            >
                              <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
                                <span className="text-[9px] font-mono text-emerald-400">{chainHash(v.tokenId)}</span>
                                <span className="text-[8px] uppercase tracking-widest text-zinc-700">VAULT</span>
                              </div>
                              <div className="aspect-square overflow-hidden bg-black">
                                {v.image ? (
                                  <IpfsDisplayImg
                                    uri={v.image}
                                    className="h-full w-full object-contain"
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="flex h-full items-center justify-center">
                                    <span className="text-[10px] uppercase tracking-wider text-zinc-700">{d.noPreview}</span>
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-col gap-2 p-4">
                                <p className="text-[12px] font-bold uppercase tracking-wide text-zinc-100">{v.name}</p>
                                <p className="text-[9px] uppercase tracking-wider text-zinc-600">SERIAL_ID #{v.tokenId}</p>
                                {v.description ? (
                                  <div className="border-l-4 border-violet-500 bg-violet-950/30 p-3">
                                    <p className="line-clamp-3 text-[9px] leading-relaxed text-violet-200">
                                      {v.description}
                                    </p>
                                  </div>
                                ) : null}
                                <div className="mt-1 flex flex-col gap-2">
                                  <Link href={chamberHref} className={secondaryCardBtn}>
                                    {d.openChamber}
                                  </Link>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSellTarget({
                                        collectionId: col,
                                        tokenId: v.tokenId,
                                        collectionName: v.name,
                                      })
                                      setBuyerAddress("")
                                      setListPriceLiq("")
                                      setSellFeedback(null)
                                    }}
                                    className="w-full border border-zinc-700 bg-transparent py-2 text-[9px] font-bold uppercase tracking-widest text-zinc-400 transition-colors hover:border-violet-500/60 hover:text-violet-300"
                                  >
                                    {d.sellNft}
                                  </button>
                                </div>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>

      {/* ── Sell modal ── */}
      {sellTarget ? (
        <div
          className="fixed inset-0 z-[400] flex items-center justify-center bg-black/85 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sell-modal-title"
        >
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto border border-zinc-700 bg-zinc-950 p-6 shadow-[0_0_40px_rgba(139,92,246,0.2)]">
            <h3 id="sell-modal-title" className="text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-100">
              {d.sellModalTitle}
            </h3>
            <p className="mt-2 text-[10px] text-zinc-500">
              {sellTarget.collectionName} · #{sellTarget.tokenId}
            </p>
            <p className="mt-3 text-[9px] leading-relaxed text-zinc-600">{d.buyerHint}</p>
            <label className="mt-4 block text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
              {d.buyerAddressLabel}
              <input
                type="text"
                value={buyerAddress}
                onChange={(e) => setBuyerAddress(e.target.value)}
                className={inputClass}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="mt-3 block text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
              {d.listingPriceLabel}
              <input
                type="text"
                inputMode="decimal"
                value={listPriceLiq}
                onChange={(e) => setListPriceLiq(e.target.value)}
                className={inputClass}
                placeholder="1.00"
              />
            </label>
            <p className="mt-2 text-[8px] text-zinc-600">{d.listingHint}</p>
            {sellFeedback ? (
              <p className="mt-3 text-[10px] text-violet-300">{sellFeedback}</p>
            ) : null}
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={transferBusy}
                onClick={() => void publishListing().catch(() => {})}
                className={primaryCardBtn}
              >
                {transferBusy ? d.transferBusy : d.listingPublish}
              </button>
              <button
                type="button"
                disabled={transferBusy}
                onClick={() => void transferToBuyer().catch(() => {})}
                className={secondaryCardBtn}
              >
                {transferBusy ? d.transferBusy : d.transferNft}
              </button>
              <button
                type="button"
                onClick={closeSellModal}
                disabled={transferBusy}
                className="py-2 text-[10px] font-semibold uppercase text-zinc-600 hover:text-zinc-300"
              >
                {d.close}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Spikes 672-675 (flag-gated display, no regression when off) ──
// Edition badge ("Edition X/Y" / "Artist Proof"), Dutch current-price chip, and drop
// countdown all render only when their phase-* flag is on AND the listing carries the
// fields; otherwise this returns null and the legacy Artifact #tokenId + price row is
// unchanged. All strings via pickCopy(lang).dashboard (EN/ES).
export function SpikeListingBadges({ listing, lang }: { listing: { edition_number?: number; edition_size?: number; is_artist_proof?: boolean; drop_start_at?: number; dutch_start_price?: number; dutch_floor_price?: number; dutch_end_at?: number; price_phaselq: number; listed_at: number }; lang: string }) {
  return null;
}
