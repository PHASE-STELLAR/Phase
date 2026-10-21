"use client"

import { useState } from "react"
import { useLang } from "@/components/lang-context"
import { useWallet } from "@/components/wallet-provider"
import { pickCopy } from "@/lib/phase-copy"
import { signSignalPayload } from "@/lib/viewer-signature"

/**
 * phase-146: shown in place of a held signal. The author can appeal once; the
 * appeal is signed like a post, over `appeal:<queue id>` + reason.
 */
export function ModerationHoldNotice({
  queueId,
  appealable,
  authorWallet,
}: {
  queueId: string
  appealable: boolean
  authorWallet: string
}) {
  const { lang } = useLang()
  const { address } = useWallet()
  const copy = pickCopy(lang).moderationQueue
  const [reason, setReason] = useState("")
  const [state, setState] = useState<"idle" | "busy" | "sent" | "failed">("idle")
  const isAuthor = Boolean(address) && address!.toUpperCase() === authorWallet.toUpperCase()

  async function submit() {
    if (!address || !reason.trim()) return
    setState("busy")
    try {
      const timestamp = Date.now()
      const signature = await signSignalPayload({ title: `appeal:${queueId}`, body: reason.trim(), timestamp }, address)
      const res = await fetch(`/api/moderation/queue/${encodeURIComponent(queueId)}/appeal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, signature, timestamp, reason: reason.trim() }),
      })
      setState(res.ok ? "sent" : "failed")
    } catch {
      setState("failed")
    }
  }

  return (
    <div className="flex flex-col gap-3 border-2 border-amber-500/40 bg-amber-950/20 p-4 text-sm text-amber-100">
      <p className="font-semibold uppercase tracking-widest text-[11px]">{copy.holdReason}</p>
      <p>{copy.heldNotice}</p>
      {isAuthor && appealable && state !== "sent" ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
            placeholder={copy.appealPlaceholder}
            className="min-h-[80px] border border-amber-500/40 bg-black/40 p-2 text-xs text-amber-50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={state === "busy" || !reason.trim()}
            className="self-start border-2 border-amber-400/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest disabled:opacity-50"
          >
            {copy.appealCta}
          </button>
          {state === "failed" ? <p className="text-xs text-red-300">{copy.appealFailed}</p> : null}
        </div>
      ) : null}
      {state === "sent" ? <p className="text-xs">{copy.appealSubmitted}</p> : null}
    </div>
  )
}
