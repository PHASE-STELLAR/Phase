/**
 * xBull full support with sign, trustline and Freighter-difference matrix.
 *
 * Feature flag: phase-168 (Spike 624 / Issue #487).
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_168 / FEATURE_PHASE_168. Zero persistent migration.
 */

import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { recordSecurityCounter } from "@/lib/security-counters"

export function isXBullEnabled(): boolean {
  return isFeatureEnabled("phase-168")
}

export function xbullRollbackNote(): string {
  return flagRollbackNote("phase-168")
}

export const XBULL_ID = "xbull"

/** Module-id matcher used by the wallet-kit dispatcher (spike 624). */
export function isXBullModuleId(id: unknown): boolean {
  if (typeof id !== "string") return false
  const normalized = id.trim().toLowerCase().replace(/[^a-z]/g, "")
  return normalized === "xbull" || normalized === "xbullwallet"
}
const LS_SELECTED_MODULE_ID = "@StellarWalletsKit/selectedModuleId"

/**
 * Checks whether xBull is the currently selected wallet module in StellarWalletsKit.
 */
export function isXBullSelected(): boolean {
  if (typeof window === "undefined") return false
  const selected = window.localStorage.getItem(LS_SELECTED_MODULE_ID)?.trim()?.toLowerCase()
  return selected === XBULL_ID || selected === "xbull-wallet"
}

// ── Freighter vs xBull Difference Matrix ─────────────────────────────────────

export const XBULL_FREIGHTER_DIFFERENCE_MATRIX: Array<{ dimension: string; freighter: string; xbull: string }> = [
  {
    dimension: "Sign Result Shape",
    freighter: "returns { signedTxXdr }",
    xbull: "returns xdr/result or a raw string; normalize before submitting",
  },
  {
    dimension: "Execution Model",
    freighter: "browser extension injects window.freighterApi",
    xbull: "wallet-kit module opens a popup or the mobile app",
  },
  {
    dimension: "Error Format",
    freighter: "throws Error with a plain message",
    xbull: "rejects with a code/message object; map to XBullErrorMapped",
  },
  {
    dimension: "Trustline Flow",
    freighter: "changeTrust signed in-extension",
    xbull: "changeTrust signed through the kit module; same XDR, different prompt",
  },
]

export const FREIGHTER_XBULL_DIFFERENCE_MATRIX = {
  returnShape: {
    freighter: "{ signedTxXdr: string }",
    xbull: "{ signedTxXdr?: string, signedTransaction?: string } | raw string",
    resolution: "Normalized via normalizeXBullSignResult() into standard { signedTxXdr, signedTransaction }",
  },
  errorHandling: {
    freighter: "Standard Error with message",
    xbull: "Error object or string (e.g. 'user_rejected', 'cancelled', 'Extension not installed')",
    resolution: "Mapped via mapXBullError() with retryable and humanized bilingual copy",
  },
  trustlines: {
    freighter: "Batched changeTrust accepted without sequence re-sync",
    xbull: "Requires fee-bump verification and explicit networkPassphrase validation",
    resolution: "Validate network and envelopment before submitting",
  },
  windowFocus: {
    freighter: "Background modal keeps state",
    xbull: "Extension popup can dismiss on blur",
    resolution: "Retry prompt with persistence guidance",
  },
} as const

// ── Result Normalizer ────────────────────────────────────────────────────────

/**
 * Normalizes any xBull signature return shape into the standard Phase signed result.
 */
export function normalizeXBullSignResult(result: unknown): {
  signedTxXdr: string
  signedTransaction: string
  error?: string
} {
  if (!result) {
    recordSecurityCounter("xbull_error_mapped")
    return { signedTxXdr: "", signedTransaction: "", error: "xBull returned empty signature result." }
  }

  // String result (raw XDR)
  if (typeof result === "string" && result.trim().length > 0) {
    const raw = result.trim()
    recordSecurityCounter("xbull_sign_success")
    return { signedTxXdr: raw, signedTransaction: raw }
  }

  if (typeof result === "object" && result !== null) {
    const res = result as Record<string, unknown>
    const candidate =
      (typeof res.signedTxXdr === "string" && res.signedTxXdr.trim()) ||
      (typeof res.signedTransaction === "string" && res.signedTransaction.trim()) ||
      (typeof res.xdr === "string" && res.xdr.trim()) ||
      (typeof res.result === "string" && res.result.trim()) ||
      ""

    if (candidate) {
      recordSecurityCounter("xbull_sign_success")
      return { signedTxXdr: candidate, signedTransaction: candidate }
    }
  }

  recordSecurityCounter("xbull_error_mapped")
  return {
    signedTxXdr: "",
    signedTransaction: "",
    error: "xBull signature result could not be normalized into transaction XDR.",
  }
}

// Closed-label counter wrappers so call sites cannot invent label names.
export function recordXBullSignRequested(): void {
  recordSecurityCounter("xbull_sign_requested")
}

export function recordXBullSignSuccess(): void {
  recordSecurityCounter("xbull_sign_success")
}

export function recordXBullTrustlineSigned(): void {
  recordSecurityCounter("xbull_trustline_signed")
}

// ── Error Mapper ─────────────────────────────────────────────────────────────

export type XBullErrorMapped = {
  code: "USER_REJECTED" | "NOT_INSTALLED" | "LOCKED" | "NETWORK_MISMATCH" | "POPUP_CLOSED" | "SIGN_FAILED"
  message: string
  retryable: boolean
  userAction: string
}

/**
 * Maps raw xBull exceptions or error codes into human-readable Phase errors.
 */
export function mapXBullError(err: unknown): XBullErrorMapped {
  recordSecurityCounter("xbull_sign_rejected")
  const raw = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err)
  const lower = raw.toLowerCase()

  if (/user_rejected|cancelled|cancelado|rejected|denied/i.test(lower)) {
    return {
      code: "USER_REJECTED",
      message: "xBull: Transacción cancelada por el usuario. / Transaction rejected by user in xBull.",
      retryable: true,
      userAction: "Reintentá cuando estés listo para firmar en xBull.",
    }
  }

  if (/extension not installed|not found|no provider/i.test(lower)) {
    recordSecurityCounter("xbull_error_mapped")
    return {
      code: "NOT_INSTALLED",
      message: "xBull: Extensión no detectada en el navegador. / xBull extension not detected.",
      retryable: false,
      userAction: "Instalá la extensión xBull o seleccioná otra wallet en el selector.",
    }
  }

  if (/password rejected|locked|bloquead/i.test(lower)) {
    recordSecurityCounter("xbull_error_mapped")
    return {
      code: "LOCKED",
      message: "xBull: La wallet está bloqueada o contraseña incorrecta. / xBull wallet is locked.",
      retryable: true,
      userAction: "Desbloqueá la extensión xBull e intentá nuevamente.",
    }
  }

  if (/invalid network|network (miss?match|not match)|wrong network/i.test(lower)) {
    recordSecurityCounter("xbull_error_mapped")
    return {
      code: "NETWORK_MISMATCH",
      message: "xBull: Red incorrecta configurada en la wallet. / xBull network mismatch.",
      retryable: true,
      userAction: "Abrí xBull y cambiá a la red Stellar Testnet.",
    }
  }

  if (/closed|blur|dismissed/i.test(lower)) {
    recordSecurityCounter("xbull_error_mapped")
    return {
      code: "POPUP_CLOSED",
      message: "xBull: La ventana de firma se cerró antes de completar. / xBull popup closed.",
      retryable: true,
      userAction: "Mantené la ventana de xBull visible durante la firma.",
    }
  }

  recordSecurityCounter("xbull_error_mapped")
  return {
    code: "SIGN_FAILED",
    message: `xBull error: ${raw}`,
    retryable: true,
    userAction: "Revisá la extensión xBull y volvé a intentar.",
  }
}
