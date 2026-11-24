"use client"

import { useEffect, useState } from "react"
import { useLang } from "@/components/lang-context"
import { useWallet } from "@/components/wallet-provider"
import { pickCopy } from "@/lib/phase-copy"
import {
  buildMobileWalletDeepLink,
  getWcSessionMetadata,
  isMobileBrowser,
  isWcResilienceEnabled,
  STELLAR_CHAIN_TESTNET,
  type WcSessionMetadata,
} from "@/lib/walletconnect-resilience"

/**
 * phase-167 — WalletConnect session banner.
 * Hidden entirely when the flag is off (default kit behavior preserved).
 */
export function WalletConnectBanner() {
  const { lang } = useLang()
  const copy = pickCopy(lang).gatedIntegrations.walletconnect
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

  if (!isWalletConnect || !isWcResilienceEnabled()) return null

  const chainMismatch = Boolean(sessionMeta?.chain && sessionMeta.chain !== STELLAR_CHAIN_TESTNET)
  const peerName = sessionMeta?.peerName || "Mobile Wallet"
  const deepLink = buildMobileWalletDeepLink(peerName, sessionMeta?.peerUrl)
  const isMobile = isMobileBrowser()

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
      className="fixed left-0 right-0 top-0 z-[250] border-b border-indigo-500/30 bg-[#0d0d14]/95 px-4 py-2 text-xs shadow-md backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-4xl flex-col items-center justify-between gap-2 sm:flex-row">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" aria-hidden />
          <span className="font-mono font-semibold tracking-wide text-indigo-300">{copy.title}</span>
          <span className="truncate text-zinc-400">
            {chainMismatch ? copy.chainMismatch : copy.connectedVia.replace("{peer}", peerName)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isMobile && deepLink ? (
            <a
              href={deepLink}
              className="rounded border border-indigo-500/40 bg-indigo-950/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-indigo-200 transition-colors hover:border-indigo-400 hover:bg-indigo-900/40"
            >
              {copy.openWallet.replace("{peer}", peerName)}
            </a>
          ) : null}
          <button
            type="button"
            disabled={reconnecting}
            onClick={() => void handleReconnect()}
            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-50"
          >
            {reconnecting ? copy.reconnecting : copy.reconnect}
          </button>
        </div>
      </div>
    </div>
  )
}
