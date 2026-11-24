"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useEffect, useState } from "react"
import { LangToggle } from "@/components/lang-toggle"
import { useLang } from "@/components/lang-context"
import { ExhibitionHang, type ExhibitionView } from "@/components/exhibition-hang"
import { pickCopy } from "@/lib/phase-copy"

type LoadState = { kind: "loading" } | { kind: "ready"; exhibition: ExhibitionView } | { kind: "error"; code: "disabled" | "notFound" }

export default function ExhibitionPage() {
  const { id } = useParams<{ id: string }>()
  const { lang } = useLang()
  const copy = pickCopy(lang)
  const [state, setState] = useState<LoadState>({ kind: "loading" })

  useEffect(() => {
    let cancelled = false
    setState({ kind: "loading" })
    fetch(`/api/exhibitions/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { exhibition?: ExhibitionView; error?: string }
        if (cancelled) return
        if (res.ok && data.exhibition) setState({ kind: "ready", exhibition: data.exhibition })
        else setState({ kind: "error", code: data.error === "EXHIBITIONS_DISABLED" ? "disabled" : "notFound" })
      })
      .catch(() => !cancelled && setState({ kind: "error", code: "notFound" }))
    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8">
      <nav className="flex items-center justify-between">
        <Link href="/" className="text-[10px] uppercase tracking-widest text-cyan-300 hover:text-white">
          {copy.nav.home}
        </Link>
        <LangToggle />
      </nav>
      {state.kind === "loading" ? <div className="h-40 animate-pulse border-2 border-cyan-500/20 bg-black/40" /> : null}
      {state.kind === "error" ? <p className="text-sm text-cyan-200">{copy.curator.errors[state.code]}</p> : null}
      {state.kind === "ready" ? <ExhibitionHang exhibition={state.exhibition} lang={lang} /> : null}
    </main>
  )
}
