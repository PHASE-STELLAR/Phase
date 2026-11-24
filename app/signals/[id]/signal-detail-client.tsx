"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useWallet } from "@/components/wallet-provider"
import { useLang } from "@/components/lang-context"
import { WalletAvatar } from "@/components/wallet-avatar"
import { signSignalPayload } from "@/lib/viewer-signature"
import type { SignalReply } from "@/lib/signal-store"
import { useSignalCRDT } from "./use-signal-crdt"

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
    conflict: "[ SIGNAL_CHANGED_REFRESH_AND_RETRY ]",
    draft: "COLLABORATIVE LORE DRAFT",
    draftTitlePlaceholder: "Draft title…",
    draftBodyPlaceholder: "Draft body…",
    draftNoWallet: "[ CONNECT_WALLET_TO_EDIT_DRAFT ]",
    draftCommit: "[ COMMIT_REVISION ]",
    draftCommitting: "[ COMMITTING… ]",
    draftCommitted: "[ REVISION_COMMITTED ]",
    draftConflict: "[ SIGNAL_CHANGED_DRAFT_MERGED_RETRY_COMMIT ]",
    draftSyncing: "SYNCING",
    draftSynced: "SYNCED",
    draftOffline: "OFFLINE",
    draftPending: "pending",
    draftContributors: "contributors",
    draftNote:
      "Concurrent edits merge. Committing publishes a new revision with full edit history.",
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
    conflict: "[ SEÑAL_ACTUALIZADA_REFRESCA_Y_REINTENTA ]",
    draft: "BORRADOR DE LORE COLABORATIVO",
    draftTitlePlaceholder: "Título del borrador…",
    draftBodyPlaceholder: "Cuerpo del borrador…",
    draftNoWallet: "[ CONECTAR_WALLET_PARA_EDITAR_BORRADOR ]",
    draftCommit: "[ PUBLICAR_REVISIÓN ]",
    draftCommitting: "[ PUBLICANDO… ]",
    draftCommitted: "[ REVISIÓN_PUBLICADA ]",
    draftConflict: "[ SEÑAL_ACTUALIZADA_BORRADOR_FUSIONADO_REINTENTA ]",
    draftSyncing: "SINCRONIZANDO",
    draftSynced: "SINCRONIZADO",
    draftOffline: "SIN CONEXIÓN",
    draftPending: "pendientes",
    draftContributors: "colaboradores",
    draftNote:
      "Las ediciones concurrentes se fusionan. Publicar crea una nueva revisión con historial completo.",
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
  initialSignalVersion: number
  initialReplies: SignalReply[]
}

type PostReplyResponse = {
  reply?: SignalReply
  error?: string
  current_version?: number
}

export function SignalDetailClient({
  signalId,
  initialSignalVersion,
  initialReplies,
}: Props) {
  const { address } = useWallet()
  const { lang } = useLang()
  const router = useRouter()
  const t = copy[lang] ?? copy.en

  const [replies, setReplies] = useState<SignalReply[]>(initialReplies)
  const [signalVersion, setSignalVersion] = useState(initialSignalVersion)
  const [replyBody, setReplyBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  // phase-141: collaborative lore draft. The hook is inert while the flag is off,
  // so the panel below and the Yjs dependency are both absent by default.
  const draft = useSignalCRDT(signalId, { initialVersion: initialSignalVersion, wallet: address })
  const [committing, setCommitting] = useState(false)
  const [committed, setCommitted] = useState<number | null>(null)
  const [commitError, setCommitError] = useState<string | null>(null)

  const baseInput =
    "w-full bg-transparent border border-[var(--color-border-tertiary)] font-mono text-[12px] text-foreground px-3 py-2 focus:outline-none focus:border-[#7F77DD] transition-colors placeholder:text-muted-foreground/40 resize-none"

  async function handleReply() {
    if (!address || !replyBody.trim()) return
    setError(null)
    setConflict(false)
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
          // TODO: replace provisional signature with Freighter signMessage when available
          signature: address,
          parent_version: signalVersion,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as PostReplyResponse
      if (res.status === 409) {
        if (typeof data.current_version === "number") {
          setSignalVersion(data.current_version)
        }
        setConflict(true)
        return
      }
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

  async function handleCommitDraft() {
    setCommitting(true)
    setCommitError(null)
    try {
      const result = await draft.commit()
      if (result.ok) {
        setCommitted(result.version)
        setSignalVersion(result.version)
        // The title and body are rendered server-side, so the committed revision
        // only appears once the server component re-runs.
        router.refresh()
        return
      }
      if (typeof result.currentVersion === "number") {
        setSignalVersion(result.currentVersion)
      }
      setCommitError(result.error)
    } finally {
      setCommitting(false)
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      {draft.enabled && (
        <div className="border border-[#534AB7]/50 p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#7F77DD]">
              {t.draft}
            </span>
            <span className="ml-auto font-mono text-[8px] uppercase tracking-widest text-muted-foreground/50">
              {draft.status === "synced"
                ? t.draftSynced
                : draft.status === "offline"
                  ? t.draftOffline
                  : t.draftSyncing}
              {draft.pending > 0 ? ` · ${draft.pending} ${t.draftPending}` : ""}
              {draft.contributors.length > 0
                ? ` · ${draft.contributors.length} ${t.draftContributors}`
                : ""}
            </span>
          </div>

          {draft.canEdit ? (
            <div className="flex flex-col gap-2">
              <input
                value={draft.title}
                maxLength={200}
                onChange={(e) => draft.setTitle(e.target.value)}
                placeholder={t.draftTitlePlaceholder}
                className={baseInput}
              />
              <textarea
                rows={6}
                value={draft.body}
                onChange={(e) => draft.setBody(e.target.value)}
                placeholder={t.draftBodyPlaceholder}
                className={baseInput}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
                {draft.body}
              </p>
              <p className="font-mono text-[10px] tracking-widest text-muted-foreground/60">
                {t.draftNoWallet}
              </p>
            </div>
          )}

          {draft.contributors.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {draft.contributors.map((c) => (
                <span key={c.wallet} className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground/60">
                  <WalletAvatar wallet={c.wallet} displayName="" size={16} />
                  {c.wallet.slice(0, 4)}…{c.wallet.slice(-4)} · {c.updates}
                </span>
              ))}
            </div>
          )}

          <p className="font-mono text-[9px] leading-relaxed text-muted-foreground/50">{t.draftNote}</p>

          {(draft.error || commitError) && (
            <p className="font-mono text-[10px] text-destructive">{commitError ?? draft.error}</p>
          )}
          {committed !== null && !commitError && (
            <p className="font-mono text-[10px] text-[#0F6E56]">
              {t.draftCommitted} · v{committed}
            </p>
          )}

          <button
            type="button"
            disabled={!draft.canEdit || committing}
            onClick={handleCommitDraft}
            className="self-end border border-[#534AB7] bg-[#534AB7]/10 px-5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-[#7F77DD] hover:bg-[#534AB7]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {committing ? t.draftCommitting : t.draftCommit}
          </button>
        </div>
      )}

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
            {conflict && (
              <p className="font-mono text-[10px] text-[#7F77DD]">{t.conflict}</p>
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
