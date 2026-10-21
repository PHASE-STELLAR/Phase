import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { Keypair } from "@stellar/stellar-sdk"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetDbForTests } from "@/lib/sqlite-db"
import { POST as exportRoute } from "@/app/api/tax/export/route"
import { POST as webhookRoute } from "@/app/api/compliance/webhook/route"
import { GET as resolveRoute } from "@/app/api/links/resolve/route"
import { taxExportMessage } from "@/lib/tax-export-proof"
import { recordTaxEvent } from "@/lib/tax-report"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-routes-")); vi.stubEnv("PHASE_SERVER_DATA_DIR", dir); vi.stubEnv("STELLAR_NETWORK", "testnet"); resetDbForTests()
  for (const id of [175,176,177]) { vi.stubEnv(`FEATURE_PHASE_${id}`, "0"); vi.stubEnv(`NEXT_PUBLIC_FEATURE_PHASE_${id}`, "0") }
})
afterEach(() => { resetDbForTests(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })
const post = (url: string, body: unknown, headers: Record<string,string> = {}) => new NextRequest(`https://phase.example${url}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })

describe("new route boundaries", () => {
  it("bounds bodies and returns deterministic errors for null or oversized export input", async () => {
    vi.stubEnv("FEATURE_PHASE_177", "1"); vi.stubEnv("FEATURE_PHASE_176", "1"); vi.stubEnv("PHASE_KYC_MODE", "mock")
    expect((await exportRoute(post("/api/tax/export", null))).status).toBe(400)
    expect((await exportRoute(post("/api/tax/export", { data: "x".repeat(8192) }))).status).toBe(400)
    expect((await webhookRoute(post("/api/compliance/webhook", { data: "x".repeat(8192) }))).status).toBe(413)
  })
  it("returns 404 for every new behavior when flags are off", async () => {
    expect((await exportRoute(post("/api/tax/export", {}))).status).toBe(404)
    expect((await webhookRoute(post("/api/compliance/webhook", {}))).status).toBe(404)
    expect((await resolveRoute(new NextRequest("https://phase.example/api/links/resolve?link=phase://collection/1"))).status).toBe(404)
  })
  it("authenticates the export, streams an attachment privately, and rejects replay", async () => {
    vi.stubEnv("FEATURE_PHASE_177", "1")
    const key = Keypair.random(), wallet = key.publicKey(), network = "Test SDF Network ; September 2015"
    const claims = { wallet, from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z", policy: "FIFO" as const, exp: Math.floor(Date.now()/1000)+240, nonce: "nonce_abcdefghijklmnop" }
    recordTaxEvent({ eventKey: "receipt", wallet, kind: "reward", asset: "PHASELQ", amountStroops: "10000000", txHash: "a".repeat(64), occurredAt: Date.parse(claims.from)+100, verified: true })
    const signature = key.sign(Buffer.from(`Stellar Signed Message:\n${taxExportMessage(claims, network)}`)).toString("base64")
    const response = await exportRoute(post("/api/tax/export", { claims, signature }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toContain(wallet)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.text()).toContain('"receipt"')
    expect((await exportRoute(post("/api/tax/export", { claims, signature }))).status).toBe(409)
    expect((await exportRoute(post("/api/tax/export", { claims: { ...claims, wallet: Keypair.random().publicKey() }, signature }))).status).toBe(401)
  })
  it("returns deterministic webhook version conflicts and idempotent retry results", async () => {
    vi.stubEnv("FEATURE_PHASE_176", "1"); vi.stubEnv("PHASE_KYC_MODE", "mock"); vi.stubEnv("PHASE_KYC_HASH_KEY", "h".repeat(32)); vi.stubEnv("PHASE_KYC_WEBHOOK_SECRET", "s".repeat(32))
    const event = { eventId: "event_abcdefgh", wallet: Keypair.random().publicKey(), subject: "provider-subject", status: "verified", expectedVersion: 0, expiresAt: Date.now()+60_000 }
    async function send(value: unknown) {
      const timestamp = String(Date.now()), signature = createHmac("sha256", "s".repeat(32)).update(`${timestamp}.${JSON.stringify(value)}`).digest("hex")
      return webhookRoute(post("/api/compliance/webhook", value, { "x-phase-timestamp": timestamp, "x-phase-signature": signature }))
    }
    expect((await send(event)).status).toBe(200)
    expect(await (await send(event)).json()).toMatchObject({ replay: true, version: 1 })
    const conflict = await send({ ...event, eventId: "event_different" })
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ current_version: 1 })
  })
  it("rejects unsafe links and unknown quests without taking payment actions", async () => {
    vi.stubEnv("FEATURE_PHASE_175", "1")
    for (const link of ["phase://collection/3?redirect=evil", "https://evil.example/link/quest/quest_1"]) {
      expect((await resolveRoute(new NextRequest(`https://phase.example/api/links/resolve?link=${encodeURIComponent(link)}`))).status).toBe(400)
    }
    expect((await resolveRoute(new NextRequest("https://phase.example/api/links/resolve?link=phase://quest/missing"))).status).toBe(410)
    const response = await resolveRoute(new NextRequest("https://phase.example/api/links/resolve?link=phase://quest/quest_connect_wallet"))
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ href: "/forge?quest=quest_connect_wallet" })
  })
})
