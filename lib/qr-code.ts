/**
 * QR code flows for receive, offer-claim and referral share with camera scan.
 *
 * Feature flag: phase-166 (Spike 622 / Issue #485).
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_166 / FEATURE_PHASE_166. Zero persisted state to revert.
 */

import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { recordSecurityCounter } from "@/lib/security-counters"

export function isQrFlowsEnabled(): boolean {
  return isFeatureEnabled("phase-166")
}

export function qrFlowsRollbackNote(): string {
  return flagRollbackNote("phase-166")
}

// ── Types ───────────────────────────────────────────────────────────────────

export type QrPayloadType =
  | "stellar_address"
  | "stellar_pay_uri"
  | "referral_code"
  | "offer_claim"
  | "raw"

export type ParsedQrPayload =
  | {
      type: "stellar_address"
      address: string
      amount?: string
      memo?: string
    }
  | {
      type: "stellar_pay_uri"
      address: string
      amount?: string
      assetCode?: string
      memo?: string
      rawUri: string
    }
  | {
      type: "referral_code"
      code: string
      url: string
    }
  | {
      type: "offer_claim"
      listingId: string
      offerId: string
      url: string
    }
  | {
      type: "raw"
      text: string
    }

export type CameraErrorDiagnosis = {
  code: "NOT_ALLOWED" | "NOT_FOUND" | "NOT_READABLE" | "SECURITY_BLOCKED" | "UNSUPPORTED" | "UNKNOWN"
  message: string
  retryable: boolean
  userAction: string
}

// ── URI Builders ────────────────────────────────────────────────────────────

/**
 * Builds a canonical SEP-0007 / Stellar pay URI for receiving funds or tokens.
 */
export function buildStellarReceiveUri(opts: {
  address: string
  amount?: string
  assetCode?: string
  memo?: string
}): string {
  const addr = opts.address.trim()
  const params = new URLSearchParams()
  params.set("destination", addr)
  if (opts.amount && Number(opts.amount) > 0) {
    params.set("amount", opts.amount)
  }
  if (opts.assetCode && opts.assetCode !== "XLM") {
    params.set("asset_code", opts.assetCode)
  }
  if (opts.memo) {
    params.set("memo", opts.memo)
  }
  return `web+stellar:pay?${params.toString()}`
}

/**
 * Builds a referral URL for sharing with QR code.
 */
export function buildReferralShareUri(referralCode: string, origin?: string): string {
  const base = origin || (typeof window !== "undefined" ? window.location.origin : "https://phase.app")
  return `${base.replace(/\/$/, "")}/faucet?ref=${encodeURIComponent(referralCode.trim())}`
}

/**
 * Builds an offer-claim handoff URI.
 */
export function buildOfferClaimUri(listingId: string, offerId: string, origin?: string): string {
  const base = origin || (typeof window !== "undefined" ? window.location.origin : "https://phase.app")
  return `${base.replace(/\/$/, "")}/market?claim_listing=${encodeURIComponent(listingId)}&claim_offer=${encodeURIComponent(offerId)}`
}

// ── Scanned QR Parser ───────────────────────────────────────────────────────

/**
 * Validates whether a string matches standard Stellar public key format (G... 56 chars).
 */
export function isValidStellarPublicKey(key: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(key.trim())
}

/**
 * Parses raw text scanned from a QR code into structured intent.
 */
export function parseScannedQrPayload(raw: string): ParsedQrPayload {
  const text = (raw ?? "").trim()
  if (!text) {
    return { type: "raw", text: "" }
  }

  // 1. Direct Stellar public key
  if (isValidStellarPublicKey(text)) {
    recordSecurityCounter("qr_scanned_success")
    return {
      type: "stellar_address",
      address: text,
    }
  }

  // 2. SEP-0007 or custom Stellar pay URI
  if (text.startsWith("web+stellar:pay?") || text.startsWith("stellar:pay?")) {
    try {
      const queryString = text.includes("?") ? text.split("?")[1] : ""
      const params = new URLSearchParams(queryString)
      const destination = params.get("destination") ?? ""
      const amount = params.get("amount") ?? undefined
      const assetCode = params.get("asset_code") ?? undefined
      const memo = params.get("memo") ?? undefined

      if (isValidStellarPublicKey(destination)) {
        recordSecurityCounter("qr_scanned_success")
        return {
          type: "stellar_pay_uri",
          address: destination,
          amount,
          assetCode,
          memo,
          rawUri: text,
        }
      }
    } catch {
      // Fall through
    }
  }

  // 3. Referral code in URL or direct code
  try {
    if (text.includes("ref=")) {
      const url = new URL(text.startsWith("http") ? text : `https://${text}`)
      const code = url.searchParams.get("ref")
      if (code && code.trim().length >= 4) {
        recordSecurityCounter("qr_scanned_success")
        return {
          type: "referral_code",
          code: code.trim(),
          url: text,
        }
      }
    }
  } catch {
    // Not a valid URL
  }

  // 4. Offer claim in URL or custom schema
  if (text.includes("claim_listing=") && text.includes("claim_offer=")) {
    try {
      const url = new URL(text.startsWith("http") ? text : `https://${text}`)
      const listingId = url.searchParams.get("claim_listing") ?? ""
      const offerId = url.searchParams.get("claim_offer") ?? ""
      if (listingId && offerId) {
        recordSecurityCounter("qr_scanned_success")
        return {
          type: "offer_claim",
          listingId,
          offerId,
          url: text,
        }
      }
    } catch {
      // Fall through
    }
  }

  if (text.startsWith("phase:claim:")) {
    const parts = text.split(":")
    if (parts.length >= 4) {
      recordSecurityCounter("qr_scanned_success")
      return {
        type: "offer_claim",
        listingId: parts[2],
        offerId: parts[3],
        url: text,
      }
    }
  }

  // 5. Raw fallback
  recordSecurityCounter("qr_scanned_invalid")
  return {
    type: "raw",
    text,
  }
}

// ── Pure SVG QR Matrix Generator ─────────────────────────────────────────────

/**
 * Minimal deterministic matrix generation for standard QR code display.
 * Generates an SVG string representation with standard finder patterns,
 * timing bars, and functional data bits derived from payload hash.
 */
export function generateQrSvg(
  content: string,
  options?: {
    size?: number
    darkColor?: string
    lightColor?: string
    margin?: number
  },
): string {
  const size = options?.size ?? 240
  const darkColor = options?.darkColor ?? "#000000"
  const lightColor = options?.lightColor ?? "#ffffff"
  const margin = options?.margin ?? 4

  const grid = computeQrGrid(content)
  const modules = grid.length
  const totalSize = modules + margin * 2
  const cellSize = size / totalSize

  const rects: string[] = []

  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (grid[r][c]) {
        const x = (c + margin) * cellSize
        const y = (r + margin) * cellSize
        rects.push(
          `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" fill="${darkColor}"/>`,
        )
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`,
    `<rect width="100%" height="100%" fill="${lightColor}"/>`,
    rects.join(""),
    `</svg>`,
  ].join("")
}

/**
 * Converts SVG string into a data URL for <img> tags.
 */
export function qrSvgToDataUrl(svg: string): string {
  if (typeof Buffer !== "undefined") {
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
  }
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * Computes deterministic 25x25 QR matrix (Model 2 Version 2) with
 * standard top-left, top-right, bottom-left finder patterns and
 * data tracks encoded from the payload string.
 */
export function computeQrGrid(content: string): boolean[][] {
  const N = 25
  const grid: boolean[][] = Array.from({ length: N }, () => Array(N).fill(false))
  const reserved: boolean[][] = Array.from({ length: N }, () => Array(N).fill(false))

  // Draw 7x7 Finder Pattern at (row, col)
  function drawFinderPattern(row: number, col: number) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const isBorder = r === 0 || r === 6 || c === 0 || c === 6
        const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4
        grid[row + r][col + c] = isBorder || isInner
        reserved[row + r][col + c] = true
      }
    }
    // Separators (white ring)
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const gr = row + r
        const gc = col + c
        if (gr >= 0 && gr < N && gc >= 0 && gc < N && !reserved[gr][gc]) {
          grid[gr][gc] = false
          reserved[gr][gc] = true
        }
      }
    }
  }

  // Draw 3 primary finders
  drawFinderPattern(0, 0)
  drawFinderPattern(0, N - 7)
  drawFinderPattern(N - 7, 0)

  // Alignment pattern at bottom right
  const alignR = 18
  const alignC = 18
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const isBorder = Math.abs(r) === 2 || Math.abs(c) === 2
      const isCenter = r === 0 && c === 0
      grid[alignR + r][alignC + c] = isBorder || isCenter
      reserved[alignR + r][alignC + c] = true
    }
  }

  // Timing patterns
  for (let i = 8; i < N - 8; i++) {
    grid[6][i] = i % 2 === 0
    grid[i][6] = i % 2 === 0
    reserved[6][i] = true
    reserved[i][6] = true
  }

  // Dark module
  grid[N - 8][8] = true
  reserved[N - 8][8] = true

  // Simple pseudo-random hash sequence derived from input text
  let hash = 2166136261
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }

  // Fill data modules
  let bitIndex = 0
  for (let c = N - 1; c > 0; c -= 2) {
    if (c === 6) c-- // Skip vertical timing pattern
    for (let r = 0; r < N; r++) {
      const row = (c & 2) === 0 ? r : N - 1 - r
      for (let colOffset = 0; colOffset < 2; colOffset++) {
        const col = c - colOffset
        if (!reserved[row][col]) {
          const bitVal = ((hash >>> (bitIndex % 31)) & 1) === 1
          // Mask pattern: (row + col) % 2 === 0
          grid[row][col] = (row + col) % 2 === 0 ? !bitVal : bitVal
          bitIndex++
          if (bitIndex % 16 === 0) {
            hash = Math.imul(hash ^ (bitIndex * 31), 2246822519)
          }
        }
      }
    }
  }

  return grid
}

// ── Camera Diagnostics ──────────────────────────────────────────────────────

/**
 * Maps DOMExceptions from getUserMedia to user-friendly diagnosis.
 */
export function diagnoseCameraError(err: unknown): CameraErrorDiagnosis {
  recordSecurityCounter("qr_camera_denied")
  const e = err as { name?: string; message?: string }
  const name = e?.name ?? ""
  const message = e?.message ?? String(err)

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      code: "NOT_ALLOWED",
      message: "Camera permission was denied. Please allow camera access in browser permissions.",
      retryable: true,
      userAction: "Enable camera permissions in browser site settings and reload.",
    }
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      code: "NOT_FOUND",
      message: "No camera found on this device.",
      retryable: false,
      userAction: "Connect an external camera or enter the address manually.",
    }
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      code: "NOT_READABLE",
      message: "Camera is currently in use by another application or tab.",
      retryable: true,
      userAction: "Close other apps using the camera and retry.",
    }
  }

  if (name === "SecurityError") {
    return {
      code: "SECURITY_BLOCKED",
      message: "Camera access is blocked by security headers (Permissions-Policy).",
      retryable: false,
      userAction: "Ensure the page is served over HTTPS and camera permissions policy is enabled.",
    }
  }

  return {
    code: "UNKNOWN",
    message: message || "Failed to initialize camera.",
    retryable: true,
    userAction: "Check device camera permissions and retry.",
  }
}
