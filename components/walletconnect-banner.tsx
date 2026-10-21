"use client"

import { useState, useEffect } from "react"
import { useWallet } from "@/components/wallet-provider"
import {
  isWcResilienceEnabled,
  getWcSessionMetadata,
  isMobileBrowser,
  buildMobileWalletDeepLink,
  type WcSessionMetadata,
} from "@/lib/walletconnect-resilience"

export function WalletConnectBanner() {
  const { isWalletConnect, address, connect, refresh } = useWallet()
  const [sessionMeta, setSessionMeta] = useState<WcSessionMetadata | null>(null)
  const [reconnecting, setReconnecting] = useState(false)

  useEffect(() => {
    if (!isWalletConnect || !isWcResilienceEnabled()) {
      setSessionMeta(null)
      return
    }
    setSessionMeta(getWcSessionMetadata())
  }, [isWalletConnect, address])

  if (!isWalletConnect || !isWcResilienceEnabled()) {
    return null
  }

  const isMobile = isMobileBrowser()
  const peerName = sessionMeta?.peerName || "Mobile Wallet"
  const deepLink = buildMobileWalletDeepLink(peerName, sessionMeta?.peerUrl)

  async function handleReconnect() {
    setReconnecting(true)
    try {
      await connect()
      await refresh()
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 z-[250] bg-[#0d0d14]/95 border-b border-indigo-500/30 px-4 py-2 text-xs shadow-md backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-4xl flex-col sm:flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" aria-hidden />
          <span className="font-mono text-indigo-300 font-semibold tracking-wide">
            WalletConnect v2
          </span>
          <span className="text-zinc-400 truncate">
            Connected via <strong className="text-zinc-200">{peerName}</strong>
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isMobile && deepLink && (
            <a
              href={deepLink}
              className="px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider rounded border border-indigo-500/40 bg-indigo-950/30 text-indigo-200 hover:border-indigo-400 hover:bg-indigo-900/40 transition-colors"
            >
              Open {peerName}
            </a>
          )}
          <button
            type="button"
            disabled={reconnecting}
            onClick={() => void handleReconnect()}
            className="px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors disabled:opacity-50"
          >
            {reconnecting ? "Reconnecting…" : "Reconnect Relay"}
          </button>
        </div>
      </div>
    </div>
  )
}
