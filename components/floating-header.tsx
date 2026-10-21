"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { useIsMobile } from "@/hooks/use-mobile"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { AlbedoSunsetBanner } from "@/components/albedo-sunset-banner"
import { FreighterConnect } from "@/components/freighter-connect"
import { LangToggle } from "@/components/lang-toggle"
import { useWallet } from "@/components/wallet-provider"
import { useNotifUnreadCount } from "@/components/notifications-modal"

// Height of the SystemTicker in px (~2.25rem)
const TICKER_PX = 36

function BellButton() {
  const { address } = useWallet()
  const unread = useNotifUnreadCount(address ?? null)

  if (!address) return null

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent("open-notifications"))}
      className="relative flex items-center justify-center text-zinc-500 hover:text-violet-400 transition-colors"
      style={{ fontSize: "14px", lineHeight: 1 }}
      aria-label="Notifications"
    >
      ◉
      {unread > 0 && (
        <span
          className="absolute -top-1.5 -right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full font-mono text-[7px] font-bold"
          style={{ background: "#ef4444", color: "#fff" }}
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  )
}

export function FloatingHeader() {
  const [scrolled, setScrolled] = useState(false)
  const pathname = usePathname()
  const mobile = useIsMobile()

  useEffect(() => {
    const check = () => setScrolled(window.scrollY > TICKER_PX)
    check()
    window.addEventListener("scroll", check, { passive: true })
    return () => window.removeEventListener("scroll", check)
  }, [])

  if (mobile && isFeatureEnabled("phase-174") && (pathname === "/forge" || pathname === "/chamber")) return null
  return (
    <div
      style={{
        position: "fixed",
        right: "1.25rem",
        top: scrolled ? "1rem" : "3.5rem",
        zIndex: 50,
        transition: "top 0.25s ease",
        maxWidth: "calc(100vw - 1.5rem)",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <BellButton />
      <FreighterConnect trailing={<LangToggle />} />
      {/* Spike 626: renders a fixed bottom banner only when phase-170 is on and Albedo is selected. */}
      <AlbedoSunsetBanner />
    </div>
  )
}
