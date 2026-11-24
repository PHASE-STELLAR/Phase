"use client"

import { useEffect, useState } from "react"
import { useLang } from "@/components/lang-context"
import { useWallet } from "@/components/wallet-provider"
import { isAlbedoSelectedInKit } from "@/lib/albedo-intent-client"
import {
  getAlbedoSunsetMode,
  isAlbedoSunset221Enabled,
  type AlbedoSunsetMode,
} from "@/lib/albedo-sunset"
import { pickCopy } from "@/lib/phase-copy"
import { cn } from "@/lib/utils"

/**
 * phase-221 — replaces the legacy implicit-tx banner once the sunset program
 * is active. Renders nothing with the flag off (zero regression).
 */
export function AlbedoSunsetBanner() {
  const { lang } = useLang()
  const copy = pickCopy(lang).integrations.albedo
  const { openWalletPicker } = useWallet()
  const [mode, setMode] = useState<AlbedoSunsetMode | null>(null)
  const [albedoSelected, setAlbedoSelected] = useState(false)

  useEffect(() => {
    if (!isAlbedoSunset221Enabled() || typeof window === "undefined") {
      setMode(null)
      return
    }
    setMode(getAlbedoSunsetMode())
    setAlbedoSelected(isAlbedoSelectedInKit())
    const onFocus = () => setAlbedoSelected(isAlbedoSelectedInKit())
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])

  if (!mode || !albedoSelected) return null
  const retired = mode === "retired"

  return (
    <div
      role="status"
      style={{ paddingBottom: "calc(0.75rem + var(--phase-keyboard-inset, 0px))" }}
      className={cn(
        "pointer-events-auto fixed bottom-0 left-0 right-0 z-[290] border-t border-amber-500/40",
        "bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur-sm",
      )}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-foreground">
          <strong>Albedo:</strong>{" "}
          <span className="text-foreground/80">{retired ? copy.retired : copy.parityFreeze}</span>
        </p>
        {retired ? (
          <button
            type="button"
            className="shrink-0 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-1.5 font-mono text-xs font-semibold text-amber-200 hover:bg-amber-500/20"
            onClick={() => void openWalletPicker().catch(() => null)}
          >
            {copy.changeWallet}
          </button>
        ) : null}
      </div>
    </div>
  )
}
