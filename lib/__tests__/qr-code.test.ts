import { describe, it, expect, beforeEach } from "vitest"
import {
  isQrFlowsEnabled,
  qrFlowsRollbackNote,
  buildStellarReceiveUri,
  buildReferralShareUri,
  buildOfferClaimUri,
  isValidStellarPublicKey,
  parseScannedQrPayload,
  computeQrGrid,
  generateQrSvg,
  qrSvgToDataUrl,
  diagnoseCameraError,
} from "@/lib/qr-code"
import { resetSecurityCounters, getSecurityCounter } from "@/lib/security-counters"

const VALID_STELLAR_G = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
const INVALID_STELLAR_G = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFL" // 55 chars

describe("spike 622: QR code flows and camera scan (phase-166)", () => {
  beforeEach(() => {
    resetSecurityCounters()
  })

  it("exposes rollback notes mentioning phase-166", () => {
    expect(qrFlowsRollbackNote()).toContain("phase-166")
  })

  it("validates Stellar public keys correctly", () => {
    expect(isValidStellarPublicKey(VALID_STELLAR_G)).toBe(true)
    expect(isValidStellarPublicKey(INVALID_STELLAR_G)).toBe(false)
    expect(isValidStellarPublicKey("not-a-key")).toBe(false)
    expect(isValidStellarPublicKey("")).toBe(false)
  })

  it("builds canonical Stellar receive URIs", () => {
    const basic = buildStellarReceiveUri({ address: VALID_STELLAR_G })
    expect(basic).toBe(`web+stellar:pay?destination=${VALID_STELLAR_G}`)

    const withAmount = buildStellarReceiveUri({
      address: VALID_STELLAR_G,
      amount: "25.5",
      assetCode: "PHASELQ",
      memo: "drop-mint",
    })
    expect(withAmount).toContain(`destination=${VALID_STELLAR_G}`)
    expect(withAmount).toContain("amount=25.5")
    expect(withAmount).toContain("asset_code=PHASELQ")
    expect(withAmount).toContain("memo=drop-mint")
  })

  it("builds referral and claim URIs", () => {
    const referralUri = buildReferralShareUri("REF77ABC", "https://phase.app")
    expect(referralUri).toBe("https://phase.app/faucet?ref=REF77ABC")

    const claimUri = buildOfferClaimUri("list-100", "offer-200", "https://phase.app")
    expect(claimUri).toBe("https://phase.app/market?claim_listing=list-100&claim_offer=offer-200")
  })

  it("parses direct Stellar addresses from QR", () => {
    const parsed = parseScannedQrPayload(VALID_STELLAR_G)
    expect(parsed.type).toBe("stellar_address")
    if (parsed.type === "stellar_address") {
      expect(parsed.address).toBe(VALID_STELLAR_G)
    }
    expect(getSecurityCounter("qr_scanned_success")).toBe(1)
  })

  it("parses SEP-0007 pay URIs from QR", () => {
    const uri = `web+stellar:pay?destination=${VALID_STELLAR_G}&amount=10&asset_code=PHASELQ`
    const parsed = parseScannedQrPayload(uri)
    expect(parsed.type).toBe("stellar_pay_uri")
    if (parsed.type === "stellar_pay_uri") {
      expect(parsed.address).toBe(VALID_STELLAR_G)
      expect(parsed.amount).toBe("10")
      expect(parsed.assetCode).toBe("PHASELQ")
    }
    expect(getSecurityCounter("qr_scanned_success")).toBe(1)
  })

  it("parses referral codes from URLs", () => {
    const parsed = parseScannedQrPayload("https://phase.app/faucet?ref=JOINPHASE")
    expect(parsed.type).toBe("referral_code")
    if (parsed.type === "referral_code") {
      expect(parsed.code).toBe("JOINPHASE")
    }
    expect(getSecurityCounter("qr_scanned_success")).toBe(1)
  })

  it("parses offer claims and falls back to raw text for unknown payloads", () => {
    const claim = parseScannedQrPayload("phase:claim:list-1:off-2")
    expect(claim.type).toBe("offer_claim")
    if (claim.type === "offer_claim") {
      expect(claim.listingId).toBe("list-1")
      expect(claim.offerId).toBe("off-2")
    }

    const raw = parseScannedQrPayload("arbitrary-scanner-payload-123")
    expect(raw.type).toBe("raw")
    if (raw.type === "raw") {
      expect(raw.text).toBe("arbitrary-scanner-payload-123")
    }
    expect(getSecurityCounter("qr_scanned_invalid")).toBe(1)
  })

  it("computes 25x25 QR matrix with finder patterns and converts to SVG", () => {
    const grid = computeQrGrid(VALID_STELLAR_G)
    expect(grid.length).toBe(25)
    expect(grid[0].length).toBe(25)
    // Top-left finder center module must be dark (true)
    expect(grid[3][3]).toBe(true)

    const svg = generateQrSvg(VALID_STELLAR_G, { size: 200 })
    expect(svg).toContain("<svg")
    expect(svg).toContain('viewBox="0 0 200 200"')
    expect(svg).toContain("<rect")

    const dataUrl = qrSvgToDataUrl(svg)
    expect(dataUrl.startsWith("data:image/svg+xml")).toBe(true)
  })

  it("diagnoses camera errors and assigns retryability", () => {
    const denied = diagnoseCameraError({ name: "NotAllowedError", message: "User denied" })
    expect(denied.code).toBe("NOT_ALLOWED")
    expect(denied.retryable).toBe(true)
    expect(getSecurityCounter("qr_camera_denied")).toBe(1)

    const notFound = diagnoseCameraError({ name: "NotFoundError", message: "No device" })
    expect(notFound.code).toBe("NOT_FOUND")
    expect(notFound.retryable).toBe(false)

    const busy = diagnoseCameraError({ name: "NotReadableError", message: "Hardware locked" })
    expect(busy.code).toBe("NOT_READABLE")
    expect(busy.retryable).toBe(true)

    const blocked = diagnoseCameraError({ name: "SecurityError", message: "CSP / policy" })
    expect(blocked.code).toBe("SECURITY_BLOCKED")
    expect(blocked.retryable).toBe(false)
  })
})
