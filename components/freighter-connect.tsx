"use client"

import { useState, type ReactNode } from "react"
import { ProfilePanel } from "@/components/profile-panel"
import { useLang } from "@/components/lang-context"
import { useWallet } from "@/components/wallet-provider"
import { cn } from "@/lib/utils"

function truncateAddress(addr: string) {
  if (!addr || addr.length < 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet-type badge helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Small inline badge indicating which wallet type is active.
 * Only rendered when connected with a hardware wallet or WalletConnect — the
 * default browser-extension wallets don't need an extra label.
 */
function WalletTypeBadge({
  isHardwareWallet,
  isWalletConnect,
}: {
  isHardwareWallet: boolean
  isWalletConnect: boolean
}) {
  if (isHardwareWallet) {
    return (
      <span
        title="Hardware wallet (Ledger) connected"
        className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-amber-300 select-none"
        aria-label="Ledger hardware wallet"
      >
        ⬡ LEDGER
      </span>
    )
  }
  if (isWalletConnect) {
    return (
      <span
        title="WalletConnect session active"
        className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-blue-300 select-none"
        aria-label="WalletConnect session"
      >
        ◈ WC
      </span>
    )
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

type FreighterConnectProps = {
  /** Rendered after wallet control, e.g. language toggle — prefixed with "|". */
  trailing?: ReactNode
}

export function FreighterConnect({ trailing }: FreighterConnectProps) {
  const { lang } = useLang()
  const {
    address,
    connecting,
    hint,
    isHardwareWallet,
    isWalletConnect,
    connect,
    disconnect,
  } = useWallet()
  const [panelOpen, setPanelOpen] = useState(false)

  const t =
    lang === "es"
      ? {
          walletLabel: "PROFILE",
          connecting: "Conectando...",
          connect: "Conectar Wallet",
          ledgerConnecting: "Abriendo Ledger…",
          wcConnecting: "Abriendo QR…",
        }
      : {
          walletLabel: "PROFILE",
          connecting: "Connecting...",
          connect: "Connect Wallet",
          ledgerConnecting: "Opening Ledger…",
          wcConnecting: "Opening QR…",
        }

  // Derive a context-aware connecting label.
  const connectingLabel = (() => {
    if (!connecting) return t.connect
    if (isHardwareWallet) return t.ledgerConnecting
    if (isWalletConnect) return t.wcConnecting
    return t.connecting
  })()

  return (
    <div className="flex flex-col items-end gap-1 pointer-events-auto">
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {address ? (
          <>
            <ProfilePanel
              open={panelOpen}
              onOpenChange={setPanelOpen}
              address={address}
              disconnect={disconnect}
            />

            {/* Wallet-type badge sits outside the profile button to keep it visible */}
            <WalletTypeBadge
              isHardwareWallet={isHardwareWallet}
              isWalletConnect={isWalletConnect}
            />

            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="group flex items-center gap-2 rounded-sm border border-violet-700/40 bg-violet-950/30 px-3 py-1.5 hover:border-violet-500/60 transition-colors"
              title={address}
              aria-label={`Open profile for ${truncateAddress(address)}`}
            >
              {/* Status dot — amber for hardware wallet, blue for WC, violet default */}
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  isHardwareWallet ? "bg-amber-400" : isWalletConnect ? "bg-blue-400" : "bg-violet-400",
                )}
                aria-hidden
              />
              <span className="max-w-[min(100vw-10rem,14rem)] truncate font-mono text-[10px] font-medium uppercase tracking-widest text-violet-300">
                {t.walletLabel} · {address.slice(0, 4)}
              </span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void connect().catch(() => {})}
            disabled={connecting}
            className="border border-border/80 bg-background/75 backdrop-blur-md px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground hover:border-accent transition-colors disabled:opacity-50 shadow-sm"
          >
            {connectingLabel}
          </button>
        )}
        {trailing != null ? (
          <>
            <span className="text-muted-foreground/45 select-none" aria-hidden>
              |
            </span>
            {trailing}
          </>
        ) : null}
      </div>
      {hint ? (
        <p className="max-w-[min(100vw-2rem,18rem)] text-right font-mono text-[9px] text-muted-foreground leading-snug">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

