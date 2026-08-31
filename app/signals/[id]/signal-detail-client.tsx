"use client"

import { useState } from "react"
import { useWallet } from "@/components/wallet-provider"
import { useLang } from "@/components/lang-context"
import { WalletAvatar } from "@/components/wallet-avatar"
import { signSignalPayload } from "@/lib/viewer-signature"
import type { SignalReply } from "@/lib/signal-store"

const copy = {
  en: {
    replies: "REPLIES",
    noReplies: "[ NO_REPLIES_YET ]",
    placeholder: "Write a reply…",
    cta: "[ REPLY ]",
    ctaBusy: "[ SENDING… ]",
    noWallet: "[ CONNECT_WALLET_TO_REPLY ]",
    walletBadge: "✓ WALLET",
    verifiedBadge: "✓ VERIFIED",
    legacyBadge: "LEGACY",
  },
  es: {
    replies: "RESPUESTAS",
    noReplies: "[ SIN_RESPUESTAS ]",
    placeholder: "Escribe una respuesta…",
    cta: "[ RESPONDER ]",
    ctaBusy: "[ ENVIANDO… ]",
    noWallet: "[ CONECTAR_WALLET_PARA_RESPONDER ]",
    walletBadge: "✓ WALLET",
    verifiedBadge: "✓ VERIFICADO",
    legacyBadge: "LEGADO",
  },
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  return `${m}m ago`
}

type Props = {
  signalId: string
  initialReplies: SignalReply[]
}

export function SignalDetailClient({ signalId, initialReplies }: Props) {
  const { address } = useWallet()
  const { lang } = useLang()
  const t = copy[lang] ?? copy.en

  const [replies, setReplies] = useState<SignalReply[]>(initialReplies)
  const [replyBody, setReplyBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const baseInput =
    "w-full bg-transparent border border-[var(--color-border-tertiary)] font-mono text-[12px] text-foreground px-3 py-2 focus:outline-none focus:border-[#7F77DD] transition-colors placeholder:text-muted-foreground/40 resize-none"

  async function handleReply() {
    if (!address || !replyBody.trim()) return
    setError(null)
    setBusy(true)
    try {
      const timestamp = Date.now()
      const replyBodyTrimmed = replyBody.trim()
      const signature = await signSignalPayload(
        { title: "", body: replyBodyTrimmed, timestamp },
        address,
      )
      const res = await fetch(`/api/signals/${signalId}/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: replyBodyTrimmed,
          wallet: address,
          signature,
          timestamp,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { reply?: SignalReply; error?: string }
      if (!res.ok || !data.reply) {
        setError(data.error ?? "Reply failed")
        return
      }
      setReplies((prev) => [...prev, data.reply!])
      setReplyBody("")
    } catch {
      setError("Reply failed. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60">
        {t.replies} ({replies.length})
      </div>

      {replies.length === 0 ? (
        <div className="py-4 text-center font-mono text-[11px] text-muted-foreground/50">
          {t.noReplies}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {replies.map((r) => (
            <div
              key={r.id}
              className="border border-[var(--color-border-tertiary)] p-4 flex flex-col gap-2"
              style={{ background: "var(--color-background-primary)" }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <WalletAvatar
                  wallet={r.author_wallet}
                  displayName={r.author_display}
                  size={24}
                />
                <span className="font-mono text-[10px] font-medium text-foreground">
                  {r.author_display}
                </span>
                <span
                  className="font-mono text-[8px] px-1 py-0.5"
                  style={
                    r.signature_verified
                      ? { background: "#E1F5EE", color: "#0F6E56" }
                      : { background: "#EEEDFE", color: "#534AB7" }
                  }
                >
                  {r.signature_verified ? t.verifiedBadge : t.walletBadge}
                </span>
                <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">
                  {timeAgo(r.created_at)}
                </span>
              </div>
              <p className="font-mono text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {r.body}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Reply form */}
      <div className="mt-2 border-t border-[var(--color-border-tertiary)] pt-4">
        {!address ? (
          <div className="py-4 text-center font-mono text-[10px] tracking-widest text-muted-foreground">
            {t.noWallet}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <textarea
              rows={3}
              maxLength={500}
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              placeholder={t.placeholder}
              className={baseInput}
            />
            {error && (
              <p className="font-mono text-[10px] text-destructive">{error}</p>
            )}
            <button
              type="button"
              disabled={busy || replyBody.trim().length === 0}
              onClick={handleReply}
              className="self-end border border-[#534AB7] bg-[#534AB7]/10 px-5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-[#7F77DD] hover:bg-[#534AB7]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? t.ctaBusy : t.cta}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
