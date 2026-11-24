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
    const target = normalizeDeepLinkReturnPath(returnUrl) ?? `${window.location.pathname}${window.location.search}${window.location.hash}`
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

// ── Relay failover, cross-session resume, closed counters (phase-167) ────────

/** Ordered relay candidates: env override first, then the documented fallback. */
export function resolveRelayUrls(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string[] {
  const primary = env.NEXT_PUBLIC_WALLETCONNECT_RELAY_URL?.trim() || getWalletConnectRelayUrl()
  const candidates = [primary, FALLBACK_WC_RELAY_URL]
  return [...new Set(candidates)]
}

/**
 * Runs a relay-bound operation against each candidate in order. The caller
 * supplies the actual transport, so this stays deterministic and testable.
 * A failover is recorded whenever a relay throws.
 */
export async function withRelayFailover<T>(
  operation: (relayUrl: string) => Promise<T>,
  opts: { relays?: string[] } = {},
): Promise<{ ok: true; value: T; relayUrl: string; failovers: number } | { ok: false; error: string }> {
  const relays = opts.relays ?? resolveRelayUrls()
  let failovers = 0
  for (const relayUrl of relays) {
    try {
      const value = await operation(relayUrl)
      return { ok: true, value, relayUrl, failovers }
    } catch (e) {
      failovers++
      recordSecurityCounter("relay_failover")
    }
  }
  return { ok: false, error: "All WalletConnect relays failed." }
}

export type WcRestoreResult =
  | { restored: true; session: WcSessionMetadata }
  | { restored: false; reason: "disabled" | "missing" | "expired" | "chain_mismatch" }

/**
 * Cross-session resume: validates the persisted session before it is trusted.
 * Records the closed `session_restored` counter only on a successful resume.
 */
export function restoreWcSession(opts: {
  now?: number
  expectedNetwork?: string
  metadata?: WcSessionMetadata | null
} = {}): WcRestoreResult {
  if (!isWcResilienceEnabled()) return { restored: false, reason: "disabled" }
  const meta = opts.metadata === undefined ? getWcSessionMetadata() : opts.metadata
  if (!meta || !meta.topic) return { restored: false, reason: "missing" }
  if (isWcSessionExpired(meta)) return { restored: false, reason: "expired" }
  const chainCheck = validateWcChain(meta.chain, opts.expectedNetwork ?? "testnet")
  if (!chainCheck.valid) return { restored: false, reason: "chain_mismatch" }
  recordSecurityCounter("session_restored")
  return { restored: true, session: meta }
}

/** Only same-origin relative paths are valid deep-link return targets. */
export function normalizeDeepLinkReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value.startsWith("/") || value.startsWith("//") || /[\\]/.test(value)) {
    recordSecurityCounter("deep_link_rejected")
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value, "https://phase.local")
    if (parsed.origin !== "https://phase.local") {
      recordSecurityCounter("deep_link_rejected")
      return null
    }
  } catch {
    recordSecurityCounter("deep_link_rejected")
    return null
  }
  recordSecurityCounter("deep_link_return")
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** Reads and clears the stored return path so a single deep link resumes once. */
export function consumeDeepLinkReturn(): string | null {
  const target = normalizeDeepLinkReturnPath(getMobileDeepLinkReturn())
  clearMobileDeepLinkReturn()
  return target
}
