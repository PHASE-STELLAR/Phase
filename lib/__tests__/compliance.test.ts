import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHmac } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Keypair } from "@stellar/stellar-sdk"
import { resetDbForTests, getDb } from "@/lib/sqlite-db"
import { applyVerificationEvent, screenCompliance, verifyComplianceWebhook, complianceGate } from "@/lib/compliance"
import { resetSecurityCounters, getSecurityCounter } from "@/lib/security-counters"

let dir: string
const wallet = Keypair.random().publicKey()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-compliance-"))
  vi.stubEnv("PHASE_SERVER_DATA_DIR", dir)
  vi.stubEnv("FEATURE_PHASE_176", "1")
  vi.stubEnv("PHASE_KYC_MODE", "mock")
  vi.stubEnv("STELLAR_NETWORK", "testnet")
  vi.stubEnv("PHASE_KYC_HASH_KEY", "h".repeat(32))
  vi.stubEnv("PHASE_KYC_WEBHOOK_SECRET", "s".repeat(32))
  vi.stubEnv("PHASE_KYC_THRESHOLD_STROOPS", "100")
  resetDbForTests(); resetSecurityCounters()
})
afterEach(() => { resetDbForTests(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
describe("amount-aware compliance gate", () => {
  it("does nothing with its flag off, including malformed legacy inputs", async () => {
    vi.stubEnv("FEATURE_PHASE_176", "0")
    await expect(screenCompliance("", "", "faucet")).resolves.toBeUndefined()
  })
  it("allows small drips but requires verified credentials at the exact threshold on every credit path", async () => {
    await expect(screenCompliance(wallet, "99", "faucet")).resolves.toBeUndefined()
    for (const operation of ["faucet", "bounty", "bootstrap", "x402"] as const) await expect(screenCompliance(wallet, "100", operation)).rejects.toMatchObject({ code: "KYC_REQUIRED", status: 403 })
    applyVerificationEvent({ eventId: "event_123456", wallet, subject: "provider-subject", status: "verified", expiresAt: Date.now() + 60_000, expectedVersion: 0 })
    await expect(screenCompliance(wallet, "100", "faucet")).resolves.toBeUndefined()
    const rows = getDb().prepare("SELECT * FROM compliance_credentials").all()
    expect(JSON.stringify(rows)).not.toContain(wallet)
    expect(JSON.stringify(rows)).not.toContain("provider-subject")
  })
  it("serializes overlapping updates, exposes versions, and deduplicates redelivery", async () => {
    const event = { eventId: "event_123456", wallet, subject: "subject", status: "verified", expiresAt: Date.now() + 60_000, expectedVersion: 0 }
    expect(applyVerificationEvent(event)).toEqual({ replay: false, version: 1 })
    expect(applyVerificationEvent(event)).toEqual({ replay: true, version: 1 })
    expect(() => applyVerificationEvent({ ...event, eventId: "event_654321" })).toThrow("VERSION_CONFLICT")
    applyVerificationEvent({ ...event, eventId: "event_654321", expectedVersion: 1, status: "revoked" })
    await expect(screenCompliance(wallet, "100", "faucet")).rejects.toMatchObject({ code: "KYC_REQUIRED" })
    expect(getSecurityCounter("compliance_webhook_replay")).toBe(1)
  })
  it("rejects an overlapping writer in a separate Node process with the committed version", async () => {
    const startAt = Date.now() + 1200
    const event = { wallet, subject: "subject", status: "verified", expiresAt: Date.now() + 60_000, expectedVersion: 0 }
    const moduleUrl = pathToFileURL(resolve("lib/compliance.ts")).href
    const run = promisify(execFile)
    const outcomes = await Promise.all(["event_process_1", "event_process_2"].map(eventId => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import complianceModule from ${JSON.stringify(moduleUrl)};
      const { applyVerificationEvent } = complianceModule;
      await new Promise(r => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
      try { const result = applyVerificationEvent(${JSON.stringify({ ...event, eventId })}); console.log(JSON.stringify({ok:true,...result})); }
      catch (error) { console.log(JSON.stringify({ok:false,current_version:error.current_version,...(error.current_version === undefined ? {reason:error.message} : {})})); }
    `], { env: { ...process.env, PHASE_SERVER_DATA_DIR: dir, FEATURE_PHASE_176: "1", PHASE_KYC_MODE: "mock", PHASE_KYC_HASH_KEY: "h".repeat(32) } })))
    const results = outcomes.map(result => JSON.parse(result.stdout.trim()))
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toEqual({ ok: false, current_version: 1 })
  }, 10_000)
  it("blocks sanctioned wallets even below the threshold and on trustlines", async () => {
    vi.stubEnv("PHASE_KYC_MOCK_BLOCKED_WALLETS", wallet)
    const response = await complianceGate(wallet, "0", "trustline")
    expect(response?.status).toBe(451)
    expect(getSecurityCounter("compliance_denied")).toBe(1)
  })
  it("fails closed on live provider outage, stale responses and redirects without leaking request details", async () => {
    vi.stubEnv("PHASE_KYC_MODE", "live"); vi.stubEnv("PHASE_SANCTIONS_URL", "https://screen.example/check"); vi.stubEnv("PHASE_SANCTIONS_API_KEY", "test-key")
    const fetchMock = vi.fn().mockRejectedValue(new Error("secret PII provider detail"))
    vi.stubGlobal("fetch", fetchMock)
    const response = await complianceGate(wallet, "1", "faucet")
    expect(response?.status).toBe(503); expect(response?.headers.get("retry-after")).toBe("60")
    expect(await response?.text()).not.toContain("PII")
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ sanctions: "clear", checkedAt: Date.now() - 7200_000, expiresAt: Date.now() + 1000 })))
    await expect(screenCompliance(wallet, "1", "faucet")).rejects.toMatchObject({ code: "SCREENING_UNAVAILABLE" })
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store", redirect: "error" })
  })
  it("validates webhook timestamp, exact bytes and signature; extra PII fields are rejected", () => {
    const body = '{"eventId":"event_123456"}', timestamp = String(Date.now())
    const signature = createHmac("sha256", "s".repeat(32)).update(`${timestamp}.${body}`).digest("hex")
    expect(verifyComplianceWebhook(body, timestamp, signature)).toBe(true)
    expect(verifyComplianceWebhook(body + " ", timestamp, signature)).toBe(false)
    expect(verifyComplianceWebhook(body, String(Date.now() - 600_000), signature)).toBe(false)
    expect(() => applyVerificationEvent({ eventId: "event_123456", wallet, subject: "subject", status: "verified", expectedVersion: 0, expiresAt: Date.now() + 60_000, dob: "private" })).toThrow()
  })
  it("never permits mock screening on mainnet", async () => {
    vi.stubEnv("STELLAR_NETWORK", "mainnet"); vi.stubEnv("PHASE_MAINNET_CUTOVER_ACK", "1")
    await expect(screenCompliance(wallet, "1", "faucet")).rejects.toMatchObject({ code: "SCREENING_UNAVAILABLE" })
  })
})
