"use client"
import { useState } from "react"
import { useWallet } from "@/components/wallet-provider"
import { useLang } from "@/components/lang-context"
import { pickCopy } from "@/lib/phase-copy"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { taxExportMessage } from "@/lib/tax-export-proof"

export function TaxExportPanel() {
  const { address } = useWallet()
  const { lang } = useLang()
  const copy = pickCopy(lang).integrations
  const [from, setFrom] = useState(`${new Date().getUTCFullYear()}-01-01`)
  const [to, setTo] = useState(`${new Date().getUTCFullYear() + 1}-01-01`)
  const [policy, setPolicy] = useState<"FIFO" | "HIFO">("FIFO")
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!isFeatureEnabled("phase-177") || !address) return null
  async function download() {
    if (!address || busy || !from || !to || from >= to) return
    setBusy(true); setFailed(false)
    try {
      const claims = { wallet: address, from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T00:00:00Z`).toISOString(), policy, exp: Math.floor(Date.now() / 1000) + 240, nonce: crypto.randomUUID() }
      const { kit } = await import("@/lib/stellar-wallet-kit")
      const signed = await kit.signMessage(taxExportMessage(claims, "Test SDF Network ; September 2015"), { address }) as { signedMessage?: string }
      if (!signed.signedMessage) throw new Error("NO_SIGNATURE")
      const response = await fetch("/api/tax/export", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claims, signature: signed.signedMessage }) })
      if (!response.ok) throw new Error("EXPORT_FAILED")
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement("a")
      anchor.href = url; anchor.download = `phase-testnet-${address}-${from}-${policy}.csv`
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <section className="my-6 rounded border border-zinc-700 p-4 text-sm" aria-label={copy.taxTitle}>
    <h2>{copy.taxTitle}</h2><p className="my-3 text-zinc-400">{copy.taxHint}</p>
    <div className="flex flex-wrap gap-3">
      <label>{copy.startDate}<input className="block min-h-11 rounded border p-2" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>{copy.endDate}<input className="block min-h-11 rounded border p-2" type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      <label>{copy.policy}<select className="block min-h-11 rounded border p-2" value={policy} onChange={e => setPolicy(e.target.value as "FIFO" | "HIFO")}><option>FIFO</option><option>HIFO</option></select></label>
      <button className="min-h-11 rounded border px-4 disabled:opacity-50" disabled={busy || !from || !to || from >= to} onClick={() => void download()} aria-busy={busy}>{copy.taxDownload}</button>
    </div>
    {failed && <p role="alert" className="mt-3 text-red-300">{copy.taxError}</p>}
  </section>
}
