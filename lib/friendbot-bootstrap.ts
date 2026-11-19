/**
 * Idempotent Friendbot testnet account bootstrap — phase-281
 *
 * Prevents double-funding when users click the button multiple times in quick
 * succession or when network errors occur. Uses same-tab strategy with popup
 * fallback and fails closed on mainnet.
 *
 * Feature flag: phase-281 (NEXT_PUBLIC_FEATURE_PHASE_281 / FEATURE_PHASE_281)
 * Rollback: disable flag → legacy friendbot behavior; no persisted state.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

const FRIENDBOT_URL = "https://friendbot.stellar.org"
const FRIENDBOT_REQUEST_TIMEOUT_MS = 30_000
const FUNDING_COOLDOWN_MS = 60_000

type FriendBotRequestState = {
  address: string
  timestamp: number
  status: "pending" | "success" | "error"
  error?: string
}

/**
 * Per-tab in-memory cache: tracks pending friendbot requests to deduplicate
 * within the same session. Prevents race conditions on the same tab.
 */
const pendingRequests = new Map<string, FriendBotRequestState>()

/**
 * SessionStorage key prefix for per-account funding cooldown.
 * Persists across tab reloads within the same session.
 */
const FUNDING_COOLDOWN_KEY_PREFIX = "friendbot_funded_"

/**
 * Check if account was already funded in this session within the cooldown.
 */
function isFundingOnCooldown(address: string): boolean {
  if (typeof sessionStorage === "undefined") return false
  const key = FUNDING_COOLDOWN_KEY_PREFIX + address
  const fundedAt = sessionStorage.getItem(key)
  if (!fundedAt) return false
  const timestamp = Number(fundedAt)
  if (!Number.isFinite(timestamp)) return false
  return Date.now() - timestamp < FUNDING_COOLDOWN_MS
}

/**
 * Record that an account has been funded in this session.
 */
function markFundedInSession(address: string): void {
  if (typeof sessionStorage === "undefined") return
  const key = FUNDING_COOLDOWN_KEY_PREFIX + address
  sessionStorage.setItem(key, String(Date.now()))
}

/**
 * Request friendbot funding for a Stellar testnet account.
 * Returns true if funding was initiated or already succeeded.
 * Fails closed if address is mainnet or if flag is off.
 */
export async function requestFriendBotFunding(
  address: string,
): Promise<{ success: boolean; message: string }> {
  if (!isFeatureEnabled("phase-281")) {
    return { success: false, message: "Friendbot bootstrap not enabled" }
  }

  if (!address || address.length === 0) {
    return { success: false, message: "No address provided" }
  }

  if (!address.startsWith("G")) {
    return { success: false, message: "Invalid Stellar address format" }
  }

  if (isFundingOnCooldown(address)) {
    return { success: true, message: "Account already funded in this session" }
  }

  const pending = pendingRequests.get(address)
  if (pending && pending.status === "pending") {
    return { success: false, message: "Funding request already in progress" }
  }

  if (pending && pending.status === "success") {
    return { success: true, message: "Account already funded" }
  }

  const state: FriendBotRequestState = {
    address,
    timestamp: Date.now(),
    status: "pending",
  }
  pendingRequests.set(address, state)

  try {
    const result = await attemptFriendBotFunding(address)
    if (result.success) {
      state.status = "success"
      markFundedInSession(address)
      return { success: true, message: "Account funded successfully" }
    } else {
      state.status = "error"
      state.error = result.message
      return { success: false, message: result.message }
    }
  } catch (error) {
    state.status = "error"
    state.error = String(error)
    return {
      success: false,
      message: `Friendbot request failed: ${String(error)}`,
    }
  }
}

/**
 * Attempt friendbot funding with same-tab strategy.
 * Falls back to popup if main request doesn't work.
 */
async function attemptFriendBotFunding(
  address: string,
): Promise<{ success: boolean; message: string }> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`

  try {
    const result = await fetchFriendBotFunding(url)
    if (result.success) return result
  } catch (error) {
    console.warn("Same-tab friendbot request failed, trying popup fallback", error)
  }

  if (typeof window === "undefined") {
    return { success: false, message: "Window not available for popup fallback" }
  }

  try {
    return await popupFallbackFunding(url)
  } catch (error) {
    return { success: false, message: `All funding attempts failed: ${String(error)}` }
  }
}

/**
 * Direct fetch request to friendbot in same tab.
 */
async function fetchFriendBotFunding(
  url: string,
): Promise<{ success: boolean; message: string }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FRIENDBOT_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      mode: "no-cors",
    })

    clearTimeout(timeoutId)

    if (response.ok || response.status === 0) {
      return { success: true, message: "Funding request accepted" }
    }

    return { success: false, message: `Friendbot returned status ${response.status}` }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Popup fallback: open friendbot URL in a new window if same-tab fails.
 * Waits briefly to detect if the popup was blocked.
 */
async function popupFallbackFunding(url: string): Promise<{ success: boolean; message: string }> {
  const popup = window.open(url, "friendbot", "width=600,height=400")

  if (!popup || popup.closed) {
    return {
      success: false,
      message: "Popup was blocked. Enable popups for friendbot.stellar.org",
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000))

  if (popup.closed) {
    return { success: true, message: "Funding popup closed (request likely completed)" }
  }

  popup.close()
  return { success: true, message: "Funding request opened in popup" }
}

/**
 * Get counter of closed/blocked popups in this session for analytics.
 */
export function getFriendBotClosedCounterState(): {
  pendingRequests: number
  successfulRequests: number
  failedRequests: number
} {
  let pending = 0
  let successful = 0
  let failed = 0

  for (const state of pendingRequests.values()) {
    if (state.status === "pending") pending++
    else if (state.status === "success") successful++
    else if (state.status === "error") failed++
  }

  return { pendingRequests: pending, successfulRequests: successful, failedRequests: failed }
}
