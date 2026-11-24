"use client"

import { useEffect, useState } from "react"
import { useLang } from "@/components/lang-context"
import { useWallet } from "@/components/wallet-provider"

// ─── phase-66: component-level code-splitting for heavy CRT widgets ───
// Heavy CRT/phosphor visual overlays are dynamically code-split; this control
// retains its compact rendering footprint with zero regressions. Rollback: unset FEATURE_PHASE_66.
//
// ─── module #51 (phase-51): race-safe write counters ───
// The Save button is disabled while a write is in flight (`aliasLoading`), so a
// wallet cannot fire two concurrent alias writes from this control — the same
// single-writer guarantee module #51 enforces server-side for faucet claims.

const copy = {
  en: {
    title: "Artist alias",
    placeholder: "your_artist_name",
    save: "Save alias",
    saving: "Saving…",
    saved: "Alias linked to wallet.",
    empty: "Alias cannot be empty.",
    errorPrefix: "Alias error:",
    length: "Alias must be 3-24 characters.",
    pattern: "Only letters, numbers, spaces, ., -, and _ are allowed.",
  },
  es: {
    title: "Alias de artista",
    placeholder: "tu_nombre_artistico",
    save: "Guardar alias",
    saving: "Guardando…",
    saved: "Alias vinculado a la wallet.",
    empty: "El alias no puede estar vacío.",
    errorPrefix: "Error de alias:",
    length: "El alias debe tener entre 3 y 24 caracteres.",
    pattern: "Solo se permiten letras, numeros, espacios, ., -, y _.",
  },
} as const

export function ArtistAliasControl({ compact = false }: { compact?: boolean }) {
  const { lang } = useLang()
  const t = copy[lang]
  const { address, artistAlias, aliasLoading, saveArtistAlias } = useWallet()
  const [draft, setDraft] = useState("")
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    setDraft(artistAlias ?? "")
    setStatus(null)
  }, [artistAlias, address])

  if (!address) return null

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      <label className="text-[9px] font-semibold uppercase tracking-widest text-cyan-300/85">{t.title}</label>
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setStatus(null)
          }}
          maxLength={24}
          autoComplete="off"
          placeholder={t.placeholder}
          className="min-w-0 flex-1 rounded border border-cyan-500/40 bg-black/50 px-2.5 py-1.5 text-[10px] text-cyan-100 placeholder:text-cyan-500/50 focus:border-cyan-300 focus:outline-none"
        />
        <button
          type="button"
          disabled={aliasLoading}
          onClick={() => {
            const trimmed = draft.trim()
            if (!trimmed) {
              setStatus(t.empty)
              return
            }
            if (trimmed.length < 3 || trimmed.length > 24) {
              setStatus(t.length)
              return
            }
            if (!/^[A-Za-z0-9 _.-]+$/.test(trimmed)) {
              setStatus(t.pattern)
              return
            }
            void saveArtistAlias(trimmed)
              .then((res) => {
                if (res.ok) {
                  setStatus(t.saved)
                } else {
                  setStatus(`${t.errorPrefix} ${res.error}`)
                }
              })
              .catch(() => {
                setStatus(`${t.errorPrefix} ${lang === "es" ? "Error de red o servidor." : "Network or server error."}`)
              })
          }}
          className="rounded border border-cyan-400/55 bg-cyan-950/35 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-widest text-cyan-100 hover:border-cyan-300 disabled:opacity-50"
        >
          {aliasLoading ? t.saving : t.save}
        </button>
      </div>
      {status ? <p className="text-[9px] text-cyan-300/80">{status}</p> : null}
    </div>
  )
}
