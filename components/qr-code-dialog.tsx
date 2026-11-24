"use client"

import { useState, useMemo } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  generateQrSvg,
  qrSvgToDataUrl,
  buildStellarReceiveUri,
  buildReferralShareUri,
} from "@/lib/qr-code"

export type QrCodeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "receive" | "referral" | "claim"
  address?: string | null
  referralCode?: string | null
  offerId?: string | null
  listingId?: string | null
}

export function QrCodeDialog({
  open,
  onOpenChange,
  mode,
  address,
  referralCode,
  offerId,
  listingId,
}: QrCodeDialogProps) {
  const [requestedAmount, setRequestedAmount] = useState("")
  const [copied, setCopied] = useState(false)

  const payload = useMemo(() => {
    if (mode === "receive" && address) {
      return buildStellarReceiveUri({
        address,
        amount: requestedAmount.trim() || undefined,
        assetCode: "PHASELQ",
      })
    }
    if (mode === "referral" && referralCode) {
      return buildReferralShareUri(referralCode)
    }
    if (mode === "claim" && listingId && offerId) {
      return `phase:claim:${listingId}:${offerId}`
    }
    return address || referralCode || ""
  }, [mode, address, referralCode, offerId, listingId, requestedAmount])

  const qrDataUrl = useMemo(() => {
    if (!payload) return ""
    const svg = generateQrSvg(payload, {
      size: 240,
      darkColor: "#c084fc",
      lightColor: "#0a0a0f",
      margin: 2,
    })
    return qrSvgToDataUrl(svg)
  }, [payload])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore
    }
  }

  const title =
    mode === "receive"
      ? "◈ RECEIVE ASSETS"
      : mode === "referral"
      ? "◈ SHARE REFERRAL QR"
      : "◈ CLAIM HANDOFF QR"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="max-w-sm w-full p-0 border border-violet-800/30 bg-[#0d0d14] text-zinc-100 overflow-hidden rounded-none"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>

        <div className="px-5 pt-4 pb-3 border-b border-violet-800/20">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-violet-400">
            {title}
          </p>
        </div>

        <div className="p-6 flex flex-col items-center gap-4 text-center">
          {/* QR Container */}
          <div className="p-3 bg-[#0a0a0f] border border-violet-800/30 rounded-lg shadow-inner">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="QR Code"
                className="w-48 h-48 block"
                width={192}
                height={192}
              />
            ) : (
              <div className="w-48 h-48 flex items-center justify-center font-mono text-xs text-zinc-600">
                No data
              </div>
            )}
          </div>

          {/* Amount customization for receive */}
          {mode === "receive" && (
            <div className="w-full text-left space-y-1">
              <label className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">
                Request Amount (PHASELQ optional)
              </label>
              <input
                type="number"
                min="0"
                step="any"
                value={requestedAmount}
                onChange={(e) => setRequestedAmount(e.target.value)}
                placeholder="0.00"
                className="w-full h-8 border border-zinc-800 bg-zinc-900/80 px-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-violet-600"
              />
            </div>
          )}

          {/* Details / Address / Code display */}
          <div className="w-full bg-zinc-900/40 p-2.5 border border-zinc-800/60 rounded text-left">
            <p className="font-mono text-[8px] uppercase tracking-wider text-zinc-500 mb-0.5">
              {mode === "receive" ? "Your Stellar Address" : mode === "referral" ? "Referral Link" : "Claim Code"}
            </p>
            <p className="font-mono text-[10px] text-zinc-300 break-all select-all">
              {payload}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex w-full gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="flex-1 py-2 font-mono text-[10px] uppercase tracking-widest border border-violet-700/40 bg-violet-950/20 text-violet-300 hover:border-violet-500 hover:bg-violet-950/40 transition-colors"
            >
              {copied ? "[ COPIED! ]" : "[ COPY URI ]"}
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 font-mono text-[10px] uppercase tracking-widest border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
