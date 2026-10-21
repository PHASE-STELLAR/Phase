"use client"

import { useEffect, useState } from "react"
import { useLang } from "@/components/lang-context"
import { useWallet } from "@/components/wallet-provider"
import { isAlbedoSelectedInKit } from "@/lib/albedo-intent-client"
import {
  albedoParityFreezeNotice,
  albedoRetiredMessage,
  getAlbedoSunsetMode,
  isAlbedoSunset170Enabled,
} from "@/lib/albedo-sunset"

/**
 * Albedo sunset notice (spike 626 / issue #489).
 *
 * Replaces the legacy implicit-tx banner once the retirement program is
 * active: parity-freeze warns that no new Albedo integrations will land,
 * retired guides the user to reconnect with a supported wallet. Renders
 * nothing while the phase-170 flag is off (zero regression).
 */
export function AlbedoSunsetBanner() {
  const { lang } = useLang()
  const { openWalletPicker } = useWallet()
  const [mode, setMode] = useState<"parity-freeze" | "retired" | null>(null)
  const [albedoSelected, setAlbedoSelected] = useState(false)

  useEffect(() => {
    if (!isAlbedoSunset170Enabled() || typeof window === "undefined") {
      setMode(null)
      return
    }
    setMode(getAlbedoSunsetMode())
    setAlbedoSelected(isAlbedoSelectedInKit())
    // Re-evaluate when the tab regains focus — the user may switch wallets in
    // another tab, which changes whether the sunset applies to this session.
    const onFocus = () => setAlbedoSelected(isAlbedoSelectedInKit())
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])

  if (!mode || !albedoSelected) return null

  const retired = mode === "retired"

  return (
    <div
      role="status"
      /* Spike 627: fixed banners clear the soft keyboard via the visualViewport inset. */
      style={{ paddingBottom: "calc(0.75rem + var(--phase-keyboard-inset, 0px))" }}
      className="pointer-events-auto fixed bottom-0 left-0 right-0 z-[290] border-t border-amber-500/40 bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-foreground">
          <strong>Albedo:</strong>{" "}
          <span className="text-foreground/80">
            {lang === "es"
              ? retired
                ? albedoRetiredMessage("es")
                : albedoParityFreezeNotice("es")
              : retired
                ? albedoRetiredMessage("en")
                : albedoParityFreezeNotice("en")}
          </span>
        </p>
        {retired ? (
          <button
            type="button"
            className="shrink-0 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-1.5 font-mono text-xs font-semibold text-amber-200 hover:bg-amber-500/20"
            onClick={() => void openWalletPicker().catch(() => null)}
          >
            {lang === "es" ? "Cambiar wallet / Change wallet" : "Change wallet"}
          </button>
        ) : null}
      </div>
    </div>
  )
}
