"use client"

import { useEffect, useState } from "react"
import { useLang } from "@/components/lang-context"
import {
  applyMobileViewportFit,
  consumePendingReturnFlow,
  currentMobileEnvironment,
  freighterMobileSupport,
  hasFreighterInjection,
  installKeyboardAvoidance,
  isFreighterMobile171Enabled,
  setPendingReturnFlow,
} from "@/lib/freighter-mobile"
import type { FreighterMobileSupport } from "@/lib/types/freighter-mobile"

/**
 * Freighter mobile guidance (spike 627 / issue #490).
 *
 * On mobile browsers without Freighter injection it explains the two viable
 * paths (WalletConnect, or opening the site inside the Freighter app) and
 * records a return-flow marker so an interrupted connect/sign can resume when
 * the user comes back. Applies viewport-fit/theme-color and keyboard
 * avoidance inside the Freighter in-app browser. Renders nothing on desktop
 * or while the phase-171 flag is off (zero regression).
 */
export function FreighterMobileNotice() {
  const { lang } = useLang()
  const [support, setSupport] = useState<FreighterMobileSupport | null>(null)

  useEffect(() => {
    if (!isFreighterMobile171Enabled() || typeof window === "undefined") {
      setSupport(null)
      return
    }
    const env = currentMobileEnvironment()
    if (!env || !env.isMobileBrowser) {
      setSupport(null)
      return
    }

    if (env.isFreighterInAppBrowser) {
      // In-app browser: adapt chrome (viewport-fit, theme-color) and keep
      // fixed banners above the soft keyboard.
      applyMobileViewportFit()
      const stop = installKeyboardAvoidance()
      return () => stop()
    }

    const next = freighterMobileSupport(env, hasFreighterInjection())
    setSupport(next)
    if (!next.supported) {
      // Remember the interrupted flow so returning from the Freighter app can
      // resume it (consumed on focus by the wallet layer).
      setPendingReturnFlow("connect", window.location.pathname)
    }
    return
  }, [])

  if (!support || support.supported) return null

  return (
    <p className="max-w-[min(100vw-2rem,18rem)] text-right font-mono text-[9px] leading-snug text-amber-400/90">
      {lang === "es"
        ? "Freighter no está disponible en este navegador móvil. Conectá por WalletConnect o abrí este sitio dentro de la app de Freighter. / Open this site inside the Freighter app."
        : "Freighter is not available in this mobile browser. Connect via WalletConnect or open this site inside the Freighter app."}
    </p>
  )
}
