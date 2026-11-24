"use client"

import type { ReactNode } from "react"
import { useEffect } from "react"
import { Toaster } from "sonner"
import { LangProvider } from "@/components/lang-context"
import { WalletProvider } from "@/components/wallet-provider"
import { FaucetModal } from "@/components/faucet-modal"
import { FloatingHeader } from "@/components/floating-header"
import { NotificationsModal } from "@/components/notifications-modal"
import { LinkPrefetchProvider } from "@/components/link-prefetch-provider"

/**
 * Respaldo si el `Script` beforeInteractive del layout no aplicó (p. ej. orden de listeners).
 * Next 16+ ya habrá mostrado el overlay en muchos casos; el arreglo principal es layout + `stopImmediatePropagation`.
 */
function SwallowEmptyUnhandledRejections() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const r = event.reason
      if (r !== undefined && r !== null && r !== "") return
      event.preventDefault()
      try {
        event.stopImmediatePropagation()
      } catch {
        /* ignore */
      }
      if (process.env.NODE_ENV === "development") {
        console.warn("[PHASE] Ignored promise rejection with empty reason (often wallet extension).")
      }
    }
    window.addEventListener("unhandledrejection", onRejection)
    return () => window.removeEventListener("unhandledrejection", onRejection)
  }, [])
  return null
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <LangProvider>
      <WalletProvider>
        <LinkPrefetchProvider>
          <SwallowEmptyUnhandledRejections />
          <FloatingHeader />
          {children}
          <FaucetModal />
          <NotificationsModal />
          <Toaster
            theme="dark"
            position="top-center"
            richColors
            toastOptions={{
              className: "font-mono text-xs",
              duration: 4500,
            }}
          />
        </LinkPrefetchProvider>
      </WalletProvider>
    </LangProvider>
  )
}
