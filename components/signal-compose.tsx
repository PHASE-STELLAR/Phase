"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useWallet } from "@/components/wallet-provider"
import { useLang } from "@/components/lang-context"
import { signSignalPayload } from "@/lib/viewer-signature"
import type { Signal } from "@/lib/signal-store"

type ChannelOption = { id: string; label: string; count: number }

type NftItem = {
  tokenId: number
  name: string
  image: string
  collectionId: number | null
}

const copy = {
  en: {
    title: "◈ NEW_SIGNAL",
    channel: "CHANNEL",
    channelPlaceholder: "Select channel",
    titleLabel: "TITLE",
    titlePlaceholder: "Signal title…",
    bodyLabel: "BODY",
    bodyPlaceholder: "What's the signal?",
    attachNft: "ATTACH NFT",
    poll: "COMMUNITY POLL",
    pollOption: "Option",
    addOption: "+ ADD OPTION",
    schedule: "SCHEDULE BROADCAST",
    nftSelect: "Select NFT",
    nftLoading: "Loading NFTs…",
    nftNone: "No NFTs found",
    cta: "[ BROADCAST ]",
    ctaBusy: "[ TRANSMITTING… ]",
    noWallet: "[ CONNECT_WALLET_TO_POST ]",
    errorGeneric: "Broadcast failed. Try again.",
  },
  es: {
    title: "◈ NUEVA_SEÑAL",
    channel: "CANAL",
    channelPlaceholder: "Seleccionar canal",
    titleLabel: "TÍTULO",
    titlePlaceholder: "Título de la señal…",
    bodyLabel: "CUERPO",
    bodyPlaceholder: "¿Cuál es la señal?",
    attachNft: "ADJUNTAR NFT",
    poll: "ENCUESTA COMUNITARIA",
    pollOption: "Opción",
    addOption: "+ AÑADIR OPCIÓN",
    schedule: "PROGRAMAR TRANSMISIÓN",
    nftSelect: "Seleccionar NFT",
    nftLoading: "Cargando NFTs…",
    nftNone: "Sin NFTs",
    cta: "[ TRANSMITIR ]",
    ctaBusy: "[ TRANSMITIENDO… ]",
    noWallet: "[ CONECTAR_WALLET_PARA_PUBLICAR ]",
    errorGeneric: "Error al transmitir. Intentá de nuevo.",
  },
}

type Props = {
  open: boolean
  onOpenChange: (v: boolean) => void
  channels: ChannelOption[]
  onCreated: (signal: Signal) => void
}

export function SignalCompose({ open, onOpenChange, channels, onCreated }: Props) {
  const { address } = useWallet()
  const { lang } = useLang()
  const t = copy[lang] ?? copy.en

  const [channel, setChannel] = useState("general")
  const [titleVal, setTitleVal] = useState("")
  const [bodyVal, setBodyVal] = useState("")
  const [attachNft, setAttachNft] = useState(false)
  const [nfts, setNfts] = useState<NftItem[]>([])
  const [nftsLoading, setNftsLoading] = useState(false)
  const [selectedNft, setSelectedNft] = useState<NftItem | null>(null)
  const [signalType, setSignalType] = useState<"post" | "poll">("post")
  const [pollOptions, setPollOptions] = useState(["", ""])
  const [scheduledFor, setScheduledFor] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setTitleVal("")
      setBodyVal("")
      setAttachNft(false)
      setSelectedNft(null)
      setError(null)
      setSignalType("post")
      setPollOptions(["", ""])
      setScheduledFor("")
    }
  }, [open])

  useEffect(() => {
    if (!attachNft || !address) return
    setNftsLoading(true)
    fetch(`/api/wallet/phase-nfts?address=${encodeURIComponent(address)}`)
      .then((r) => r.json())
      .then((data: { items?: NftItem[] }) => {
        setNfts(
          (data.items ?? []).map((item) => ({
            tokenId: item.tokenId,
            name: item.name,
            image: item.image,
            collectionId: item.collectionId,
          })),
        )
      })
      .catch(() => setNfts([]))
      .finally(() => setNftsLoading(false))
  }, [attachNft, address])

  async function handleBroadcast() {
    if (!address) return
    setError(null)
    setBusy(true)
    try {
      const timestamp = Date.now()
      const signature = await signSignalPayload(
        { title: titleVal.trim(), body: bodyVal.trim(), timestamp },
        address,
      )
      const body: Record<string, unknown> = {
        title: titleVal,
        body: bodyVal,
        channel,
        wallet: address,
        signature,
        timestamp,
        type: signalType,
      }
      if (signalType === "poll") body.poll_options = pollOptions
      if (scheduledFor) body.scheduled_for = new Date(scheduledFor).toISOString()
      if (attachNft && selectedNft) {
        body.nft_token_id = selectedNft.tokenId
        body.nft_collection_id = selectedNft.collectionId
        body.nft_name = selectedNft.name
        body.nft_image = selectedNft.image
      }
      const res = await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { signal?: Signal; error?: string }
      if (!res.ok || !data.signal) {
        setError(data.error ?? t.errorGeneric)
        return
      }
      onCreated(data.signal)
      onOpenChange(false)
    } catch {
      setError(t.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  const baseInput =
    "w-full bg-transparent border border-[var(--color-border-tertiary)] font-mono text-[12px] text-foreground px-3 py-2 focus:outline-none focus:border-[#7F77DD] transition-colors placeholder:text-muted-foreground/40"

  const worldChannels = channels.filter((c) => c.id !== "all" && c.id !== "general" && c.id !== "showcase")
  const pollsEnabled = ["1", "true", "yes", "on"].includes(
    (process.env.NEXT_PUBLIC_FEATURE_PHASE_90 ?? "").trim().toLowerCase(),
  )
  const schedulingEnabled = ["1", "true", "yes", "on"].includes(
    (process.env.NEXT_PUBLIC_FEATURE_PHASE_89 ?? "").trim().toLowerCase(),
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg border border-[var(--color-border-tertiary)] bg-[var(--color-background-primary)] p-0 gap-0"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <DialogHeader className="border-b border-[var(--color-border-tertiary)] px-5 py-4">
          <DialogTitle className="font-mono text-[11px] uppercase tracking-[0.15em] text-[#7F77DD]">
            {t.title}
          </DialogTitle>
        </DialogHeader>

        {!address ? (
          <div className="px-5 py-10 text-center font-mono text-[11px] tracking-widest text-muted-foreground">
            {t.noWallet}
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-5 py-5">
            {/* Channel */}
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                {t.channel}
              </label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className={baseInput}
              >
                <option value="general">General</option>
                <option value="showcase">NFT Showcase</option>
                {worldChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Title */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  {t.titleLabel}
                </label>
                <span className="font-mono text-[9px] text-muted-foreground/50">
                  {titleVal.length}/120
                </span>
              </div>
              <input
                type="text"
                maxLength={120}
                value={titleVal}
                onChange={(e) => setTitleVal(e.target.value)}
                placeholder={t.titlePlaceholder}
                className={baseInput}
              />
            </div>

            {/* Body */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  {t.bodyLabel}
                </label>
                <span className="font-mono text-[9px] text-muted-foreground/50">
                  {bodyVal.length}/1000
                </span>
              </div>
              <textarea
                maxLength={1000}
                rows={4}
                value={bodyVal}
                onChange={(e) => setBodyVal(e.target.value)}
                placeholder={t.bodyPlaceholder}
                className={`${baseInput} resize-none`}
              />
            </div>

            {pollsEnabled && (
              <div className="flex flex-col gap-2 border-y border-[var(--color-border-tertiary)] py-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={signalType === "poll"}
                    onChange={(event) => setSignalType(event.target.checked ? "poll" : "post")}
                    className="accent-[#7F77DD]"
                  />
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">{t.poll}</span>
                </label>
                {signalType === "poll" && pollOptions.map((option, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      value={option}
                      maxLength={80}
                      aria-label={`${t.pollOption} ${index + 1}`}
                      placeholder={`${t.pollOption} ${index + 1}`}
                      onChange={(event) => setPollOptions((current) => current.map((value, i) => i === index ? event.target.value : value))}
                      className={baseInput}
                    />
                    {pollOptions.length > 2 && (
                      <button
                        type="button"
                        aria-label={`Remove ${t.pollOption.toLowerCase()} ${index + 1}`}
                        onClick={() => setPollOptions((current) => current.filter((_, i) => i !== index))}
                        className="px-2 py-2 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#7F77DD]"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {signalType === "poll" && pollOptions.length < 6 && (
                  <button
                    type="button"
                    onClick={() => setPollOptions((current) => [...current, ""])}
                    className="self-start font-mono text-[9px] text-[#7F77DD] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#7F77DD]"
                  >
                    {t.addOption}
                  </button>
                )}
              </div>
            )}

            {schedulingEnabled && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="signal-scheduled-for" className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  {t.schedule}
                </label>
                <input
                  id="signal-scheduled-for"
                  type="datetime-local"
                  value={scheduledFor}
                  min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                  onChange={(event) => setScheduledFor(event.target.value)}
                  className={baseInput}
                />
              </div>
            )}

            {/* Attach NFT */}
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={attachNft}
                onChange={(e) => {
                  setAttachNft(e.target.checked)
                  if (!e.target.checked) setSelectedNft(null)
                }}
                className="accent-[#7F77DD]"
              />
              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                {t.attachNft}
              </span>
            </label>

            {attachNft && (
              <div className="flex flex-col gap-2">
                {nftsLoading ? (
                  <span className="font-mono text-[10px] text-muted-foreground">{t.nftLoading}</span>
                ) : nfts.length === 0 ? (
                  <span className="font-mono text-[10px] text-muted-foreground">{t.nftNone}</span>
                ) : (
                  <select
                    value={selectedNft?.tokenId ?? ""}
                    onChange={(e) => {
                      const nft = nfts.find((n) => String(n.tokenId) === e.target.value) ?? null
                      setSelectedNft(nft)
                    }}
                    className={baseInput}
                  >
                    <option value="">{t.nftSelect}</option>
                    {nfts.map((n) => (
                      <option key={n.tokenId} value={n.tokenId}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                )}
                {selectedNft?.image && (
                  <div className="flex items-center gap-3 border border-[var(--color-border-tertiary)] p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={selectedNft.image}
                      alt={selectedNft.name}
                      className="h-10 w-10 object-cover"
                    />
                    <span className="font-mono text-[10px] text-foreground/80">{selectedNft.name}</span>
                    <span className="ml-auto font-mono text-[8px] tracking-widest px-1.5 py-0.5"
                      style={{ background: "#E1F5EE", color: "#0F6E56" }}>
                      ✓ ON-CHAIN
                    </span>
                  </div>
                )}
              </div>
            )}

            {error && (
              <p className="font-mono text-[10px] text-destructive">{error}</p>
            )}

            <button
              type="button"
              disabled={busy || titleVal.trim().length === 0 || bodyVal.trim().length === 0 || (signalType === "poll" && pollOptions.some((option) => option.trim().length === 0))}
              onClick={handleBroadcast}
              className="mt-1 w-full border border-[#534AB7] bg-[#534AB7]/10 py-2.5 font-mono text-[11px] uppercase tracking-[0.15em] text-[#7F77DD] transition-colors hover:bg-[#534AB7]/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? t.ctaBusy : t.cta}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
