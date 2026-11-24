"use client"

import { useWallet } from "@/components/wallet-provider"
import { isAlbedoSelectedInKit } from "@/lib/albedo-intent-client"

export type WalletBadgeProps = {
  className?: string
  showText?: boolean
}

export function WalletBadge({ className = "", showText = true }: WalletBadgeProps) {
  const { isHardwareWallet, isWalletConnect, isXBull, address } = useWallet()

  if (!address) return null

  const isAlbedo = typeof window !== "undefined" && isAlbedoSelectedInKit()

  let label = "Freighter"
  let color = "bg-violet-950/60 text-violet-300 border-violet-700/50"
  let icon = "⬡"

  if (isXBull) {
    label = "xBull"
    color = "bg-amber-950/60 text-amber-300 border-amber-600/50"
    icon = "🐂"
  } else if (isHardwareWallet) {
    label = "Ledger"
    color = "bg-emerald-950/60 text-emerald-300 border-emerald-600/50"
    icon = "🔒"
  } else if (isWalletConnect) {
    label = "WalletConnect"
    color = "bg-indigo-950/60 text-indigo-300 border-indigo-600/50"
    icon = "⚡"
  } else if (isAlbedo) {
    label = "Albedo"
    color = "bg-cyan-950/60 text-cyan-300 border-cyan-600/50"
    icon = "◈"
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[9px] uppercase tracking-wider ${color} ${className}`}
      title={`Connected via ${label}`}
    >
      <span aria-hidden="true">{icon}</span>
      {showText && <span>{label}</span>}
    </span>
  )
}
