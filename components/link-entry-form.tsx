"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { useLang } from "@/components/lang-context"
import { pickCopy } from "@/lib/phase-copy"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { parsePhaseLink, intentPath } from "@/lib/deep-links"

export function LinkEntryForm() {
  const [raw, setRaw] = useState("")
  const [failed, setFailed] = useState(false)
  const { lang } = useLang(), router = useRouter()
  const c = pickCopy(lang).integrations
  if (!isFeatureEnabled("phase-175")) return null
  return <main className="mx-auto max-w-xl px-4 py-24">
    <h1 className="text-lg">{c.reviewLink}</h1><p className="my-4">{c.reviewLinkHint}</p>
    <form onSubmit={event => { event.preventDefault(); try { const intent = parsePhaseLink(raw, window.location.origin); window.location.assign(intentPath(intent)) } catch { setFailed(true) } }}>
      <label htmlFor="phase-link">{c.destination}</label><input id="phase-link" className="my-3 block min-h-11 w-full rounded border p-3" value={raw} onChange={e => setRaw(e.target.value)} />
      <button className="min-h-11 rounded border p-3" type="submit">{c.continue}</button>
      <button className="ml-3 min-h-11 rounded border p-3" type="button" onClick={() => router.push("/dashboard")}>{c.cancel}</button>
    </form>{failed && <p role="alert">{c.linkError}</p>}
  </main>
}
