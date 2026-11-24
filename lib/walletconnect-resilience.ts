/**
 * WalletConnect v2 mobile session resilience with reconnect and chain-switch.
 *
 * Feature flag: phase-167 (Spike 623 / Issue #486).
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_167 / FEATURE_PHASE_167. Zero persistent migration.
 */

import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { recordSecurityCounter } from "@/lib/security-counters"

export function isWcResilienceEnabled(): boolean {
  return isFeatureEnabled("phase-167")
}

export function wcResilienceRollbackNote(): string {
  return flagRollbackNote("phase-167")
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_WC_RELAY_URL = "wss://relay.walletconnect.org"
export const FALLBACK_WC_RELAY_URL = "wss://relay.walletconnect.com"

export const LS_WC_SESSION_METADATA = "@PHASE/wc_session_metadata"
export const LS_WC_DEEPLINK_RETURN = "@PHASE/wc_deeplink_return"

export const STELLAR_CHAIN_TESTNET = "stellar:testnet"
export const STELLAR_CHAIN_PUBNET = "stellar:pubnet"

export type WcSessionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "EXPIRED"
  | "CHAIN_MISMATCH"

export type WcSessionMetadata = {
  topic: string
  peerName?: string
  peerIcon?: string
  peerUrl?: string
  chain: string
  expiry: number
  connectedAt: number
  lastActiveAt: number
}

// ── Relay and Chain Resolution ───────────────────────────────────────────────

/**
 * Resolves the primary WalletConnect relay websocket endpoint.
 */
export function getWalletConnectRelayUrl(): string {
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_WALLETCONNECT_RELAY_URL) {
    return process.env.NEXT_PUBLIC_WALLETCONNECT_RELAY_URL.trim()
  }
  return DEFAULT_WC_RELAY_URL
}

/**
 * Resolves allowed target chains based on network configuration.
 */
export function resolveAllowedChains(stellarNetwork?: string): string[] {
  const isMainnet = stellarNetwork?.toLowerCase() === "mainnet" || stellarNetwork?.toLowerCase() === "pubnet"
  if (isMainnet) {
    return [STELLAR_CHAIN_PUBNET, STELLAR_CHAIN_TESTNET]
  }
  return [STELLAR_CHAIN_TESTNET, STELLAR_CHAIN_PUBNET]
}

// ── Session Persistence ──────────────────────────────────────────────────────

export function saveWcSessionMetadata(meta: WcSessionMetadata): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LS_WC_SESSION_METADATA, JSON.stringify(meta))
  } catch {
    // localStorage unavailable
  }
}

export function getWcSessionMetadata(): WcSessionMetadata | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(LS_WC_SESSION_METADATA)
    if (!raw) return null
    return JSON.parse(raw) as WcSessionMetadata
  } catch {
    return null
  }
}

export function clearWcSessionMetadata(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(LS_WC_SESSION_METADATA)
  } catch {
    // ignore
  }
}

export function isWcSessionExpired(meta?: WcSessionMetadata | null): boolean {
  const m = meta ?? getWcSessionMetadata()
  if (!m || !m.expiry) return true
  // expiry is seconds since epoch (WalletConnect standard) or milliseconds
  const expiryMs = m.expiry < 1e11 ? m.expiry * 1000 : m.expiry
  return Date.now() >= expiryMs
}

// ── Chain-Switch Guard ───────────────────────────────────────────────────────

/**
 * Validates that active WalletConnect namespace matches the expected Stellar network.
 */
export function validateWcChain(
  sessionChain: string,
  expectedNetwork: string,
): { valid: boolean; error?: string } {
  const normExpected = expectedNetwork.toLowerCase().includes("main") ? "pubnet" : "testnet"
  const normSession = sessionChain.toLowerCase().includes("pubnet") || sessionChain.toLowerCase().includes("mainnet")
    ? "pubnet"
    : sessionChain.toLowerCase().includes("testnet")
    ? "testnet"
    : "unknown"

  if (normSession !== normExpected) {
    recordSecurityCounter("wc_chain_mismatch_blocked")
    return {
      valid: false,
      error: `WalletConnect chain mismatch: wallet is connected to ${sessionChain}, but application requires Stellar ${normExpected}. Please switch chains in your mobile wallet.`,
    }
  }

  return { valid: true }
}

// ── Mobile Deep-Link & Return Flow ───────────────────────────────────────────

export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent)
}

export function recordMobileDeepLinkReturn(returnUrl?: string): void {
  if (typeof window === "undefined") return
  try {
    const target = returnUrl || window.location.href
    window.localStorage.setItem(LS_WC_DEEPLINK_RETURN, target)
  } catch {
    // ignore
  }
}

export function getMobileDeepLinkReturn(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(LS_WC_DEEPLINK_RETURN)
  } catch {
    return null
  }
}

export function clearMobileDeepLinkReturn(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(LS_WC_DEEPLINK_RETURN)
  } catch {
    // ignore
  }
}

/**
 * Builds standard universal link or deep link to return to mobile wallet for signing.
 */
export function buildMobileWalletDeepLink(peerName?: string, universalLink?: string): string | null {
  if (universalLink && universalLink.startsWith("http")) {
    return universalLink
  }
  const name = (peerName ?? "").toLowerCase()
  if (name.includes("lobstr")) {
    return "lobstr://wc"
  }
  if (name.includes("xbull")) {
    return "xbull://wc"
  }
  return null
}

// ── Reconnection State Machine & Backoff ─────────────────────────────────────

export function calculateReconnectBackoff(attempt: number): number {
  const baseMs = 1500
  const maxMs = 30000
  const delay = Math.min(baseMs * Math.pow(1.8, Math.max(0, attempt - 1)), maxMs)
  // Add 15% jitter
  return Math.round(delay * (0.85 + Math.random() * 0.3))
}
