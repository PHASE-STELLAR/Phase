"use client"
import { useEffect, useState } from "react"
import { useWallet } from "@/components/wallet-provider"
import { useLang } from "@/components/lang-context"
import { pickCopy } from "@/lib/phase-copy"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { signSignalPayload } from "@/lib/viewer-signature"

type Target = { path: string; listing?: string; offer?: string; quest?: string }
export function IntentTarget() {
  const { address, connect } = useWallet()
  const { lang } = useLang()
  const c = pickCopy(lang).integrations
  const [target, setTarget] = useState<Target | null>(null)
  const [context, setContext] = useState<{ seller?: string; buyer?: string; amount?: number } | null>(null)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [retryIn, setRetryIn] = useState(0)
  useEffect(() => {
    if (retryIn <= 0) return
    const timer = window.setTimeout(() => setRetryIn(n => n - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [retryIn])
  const enabled = isFeatureEnabled("phase-175")
  useEffect(() => {
    if (!enabled) return
    const params = new URLSearchParams(window.location.search)
    const listing = params.get("listing"), offer = params.get("offer"), quest = params.get("quest")
    if (listing && offer) setTarget({ listing, offer, path: `/link/offer/${encodeURIComponent(listing)}/${encodeURIComponent(offer)}` })
    else if (quest) setTarget({ quest, path: `/link/quest/${encodeURIComponent(quest)}` })
  }, [enabled])
  useEffect(() => {
    if (!target) return
    const controller = new AbortController()
    void fetch(`/api/links/resolve?link=${encodeURIComponent(target.path)}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("UNAVAILABLE")
      const body = await response.json() as { context: typeof context }
      setContext(body.context)
    }).catch(() => { if (!controller.signal.aborted) setMessage(c.linkError) })
    return () => controller.abort()
  }, [target, c.linkError])
  async function act(action: "accept" | "reject" | "claim") {
    if (!target || busy || done || retryIn > 0 || !context) return
    if (!address) { await connect(); return }
    setBusy(true); setMessage("")
    try {
      let response: Response
      if (target.quest) response = await fetch("/api/faucet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletAddress: address, reward: target.quest }) })
      else {
        const timestamp = Date.now()
        const signature = await signSignalPayload({ title: `market:${target.listing}:${target.offer}:${action}`, body: address, timestamp }, address)
        response = await fetch(`/api/market/${encodeURIComponent(target.listing!)}/offers/${encodeURIComponent(target.offer!)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: address, action, timestamp, signature }) })
      }
      const result = await response.json() as { code?: string; pending?: boolean }
      if (!response.ok) {
        const retry = Number(response.headers.get("retry-after"))
        if (Number.isFinite(retry) && retry > 0) setRetryIn(Math.min(3600, Math.ceil(retry)))
        setMessage(result.code === "KYC_REQUIRED" ? c.kycRequired : result.code === "SANCTIONS_BLOCKED" ? c.sanctionsBlocked : result.code === "SCREENING_UNAVAILABLE" ? c.screeningUnavailable : response.status === 409 ? c.actionConflict : response.status === 412 ? c.requirementsNotMet : response.status === 429 ? c.rateLimited : c.actionFailed)
      } else if (result.pending) setMessage(c.pending)
      else { setDone(true); setMessage(c.completed) }
    } catch { setMessage(c.actionFailed) } finally { setBusy(false) }
  }
  if (!enabled || !target) return null
  return <section className="relative z-[110] m-3 rounded border border-cyan-700 bg-zinc-950 p-4 text-sm" aria-label={c.destination}>
    <h2>{target.quest ? c.quest : c.offer}</h2><p className="break-all">{target.quest ?? `${target.listing} / ${target.offer}`}</p>
    {context?.amount != null && <p>{context.amount} PHASELQ</p>}
    {context?.buyer && <p className="break-all">{c.buyer}: {context.buyer}</p>}
    {context?.seller && <p className="break-all">{c.seller}: {context.seller}</p>}
    {!target.quest && <p className="my-2 text-zinc-400">{c.offerHint}</p>}
    <div className="mt-3 flex flex-wrap gap-3">
      {!address ? <button className="min-h-11 rounded border p-3" onClick={() => void connect()}>{c.connect}</button> : target.quest ?
        <button disabled={busy || done || retryIn > 0 || !context} className="min-h-11 rounded border p-3" onClick={() => void act("claim")}>{c.claim}</button> : context?.seller === address ? <>
          <button disabled={busy || done || retryIn > 0} className="min-h-11 rounded border p-3" onClick={() => void act("accept")}>{c.accept}</button>
          <button disabled={busy || done || retryIn > 0} className="min-h-11 rounded border p-3" onClick={() => void act("reject")}>{c.reject}</button>
        </> : null}
    </div>
    {message && <p role="status" className="mt-3">{message}</p>}
  </section>
}
