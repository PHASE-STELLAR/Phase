"use client"
import { useEffect, useState } from "react"
import { useWallet } from "@/components/wallet-provider"
import { useLang } from "@/components/lang-context"
import { pickCopy } from "@/lib/phase-copy"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { INTENT_KEY, intentPath, parsePhaseLink, restoreIntent, type PhaseIntent } from "@/lib/deep-links"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"

export function InboundLinkReview() {
  const { address, connect, connecting } = useWallet()
  const { lang } = useLang()
  const copy = pickCopy(lang).integrations
  const [intent, setIntent] = useState<PhaseIntent | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const enabled = isFeatureEnabled("phase-175")
  useEffect(() => {
    if (!enabled) return
    try {
      const url = new URL(window.location.href)
      // Rewrites preserve the browser's /link/... URL; internal query parameters
      // are only visible to Next's server router, not window.location.
      const raw = url.pathname.startsWith("/link/") ? url.pathname + url.search : url.searchParams.get("phase_link")
      const next = raw ? parsePhaseLink(raw, url.origin) : restoreIntent(sessionStorage.getItem(INTENT_KEY), url.origin)
      if (next) sessionStorage.setItem(INTENT_KEY, JSON.stringify(next))
      else sessionStorage.removeItem(INTENT_KEY)
      setIntent(next)
    } catch { setError(true) }
  }, [enabled])
  function dismiss() {
    try { sessionStorage.removeItem(INTENT_KEY) } catch { /* private browsing */ }
    setIntent(null)
    setError(false)
    const url = new URL(window.location.href)
    url.searchParams.delete("phase_link")
    if (url.pathname.startsWith("/link/")) {
      url.pathname = intent?.kind === "collection" ? "/chamber" : intent?.kind === "quest" ? "/forge" : "/dashboard"
      url.search = intent?.kind === "collection" ? `?collection=${intent.id}` : ""
    }
    window.history.replaceState(null, "", url.pathname + url.search)
  }
  async function resume() {
    if (!intent || busy) return
    if (!address) { await connect(); return }
    if (!restoreIntent(JSON.stringify(intent), window.location.origin)) { setError(true); return }
    setBusy(true)
    try {
      const response = await fetch(`/api/links/resolve?link=${encodeURIComponent(intentPath(intent))}`, { cache: "no-store" })
      if (!response.ok) throw new Error("UNAVAILABLE")
      const result = await response.json() as { href: string }
      if (!/^\/(chamber|dashboard|forge)\?/.test(result.href)) throw new Error("INVALID_TARGET")
      dismiss()
      window.location.assign(result.href)
    } catch { setError(true) } finally { setBusy(false) }
  }
  if (!enabled) return null
  return <Sheet open={!!intent || error} onOpenChange={open => { if (!open) dismiss() }}>
    <SheetContent layer={600} side="bottom" className="z-[600] max-h-[85dvh] overflow-y-auto p-6 pb-[max(24px,env(safe-area-inset-bottom))]" closeLabel={copy.cancel}>
      <SheetTitle>{copy.reviewLink}</SheetTitle>
      <SheetDescription>{copy.reviewLinkHint}</SheetDescription>
      {intent && <dl className="space-y-2 break-all text-sm"><dt>{copy.destination}</dt><dd>{intent.kind === "quest" ? copy.quest : intent.kind === "offer" ? copy.offer : pickCopy(lang).chamber.collectionId} / {intent.id} {intent.offerId}</dd>
        {intent.recipient && <><dt>{copy.recipient}</dt><dd>{intent.recipient}</dd></>}
        {intent.ref && <><dt>{copy.referral}</dt><dd>{intent.ref}</dd></>}
        <dt>{copy.signingWallet}</dt><dd>{address ?? copy.connect}</dd></dl>}
      {error && <p role="alert">{copy.linkError}</p>}
      <button disabled={busy || connecting || !intent || error} onClick={() => void resume()} className="min-h-11 rounded border p-3">{address ? copy.continue : copy.connect}</button>
      <button className="min-h-11 rounded border p-3" onClick={dismiss}>{copy.cancel}</button>
    </SheetContent>
  </Sheet>
}
