import { describe, it, beforeEach, afterEach } from "vitest"
import * as assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "phase-webhooks-"))
  process.env.PHASE_SERVER_DATA_DIR = dataDir
  process.env.FEATURE_PHASE_215 = "1"
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.PHASE_SERVER_DATA_DIR
  delete process.env.FEATURE_PHASE_215
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_215
})

describe("phase-215 SSRF fence", () => {
  it("rejects insecure protocols, credentials and loopback hosts", async () => {
    const { validateWebhookUrl } = await import("@/lib/webhook-ssrf")
    const cases = [
      "http://example.com/hook",
      "https://user:pass@example.com/hook",
      "https://localhost/hook",
      "https://api.internal/hook",
      "https://metadata.google.internal/hook",
    ]
    for (const url of cases) {
      assert.throws(() => validateWebhookUrl(url))
    }
  })

  it("rejects private IP literals and accepts public https URLs", async () => {
    const { validateWebhookUrl, resolveSafeEndpoint, isPrivateAddress } = await import("@/lib/webhook-ssrf")
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "172.16.4.4", "192.168.1.1", "[::1]"]) {
      assert.equal(isPrivateAddress(ip), true, ip)
      await assert.rejects(resolveSafeEndpoint(`https://${ip}/hook`))
    }
    const endpoint = await resolveSafeEndpoint("https://1.1.1.1/hook?token=abc")
    assert.equal(endpoint.addresses[0], "1.1.1.1")
    assert.equal(endpoint.logLabel, "https://1.1.1.1/hook")
    assert.ok(validateWebhookUrl("https://example.com/hook"))
  })
})

describe("phase-215 signing, circuit breaker and redelivery log", () => {
  it("produces a stable HMAC signature", async () => {
    const { signWebhookDelivery } = await import("@/lib/webhook-delivery")
    const a = signWebhookDelivery("secret", 1000, "nonce", '{"event":"x"}')
    const b = signWebhookDelivery("secret", 1000, "nonce", '{"event":"x"}')
    assert.equal(a, b)
    assert.notEqual(a, signWebhookDelivery("secret", 1001, "nonce", '{"event":"x"}'))
  })

  it("opens, half-opens and closes the per-endpoint circuit", async () => {
    const breaker = await import("@/lib/webhook-circuit-breaker")
    breaker.resetWebhookCircuits()
    const endpoint = "https://example.com/hook"
    assert.equal(breaker.allowWebhookRequest(endpoint), true)
    breaker.recordWebhookFailure(endpoint, 1000)
    breaker.recordWebhookFailure(endpoint, 1000)
    breaker.recordWebhookFailure(endpoint, 1000)
    assert.equal(breaker.getWebhookCircuitState(endpoint, 1000), "OPEN")
    assert.equal(breaker.allowWebhookRequest(endpoint, 1000), false)
    assert.equal(breaker.getWebhookCircuitState(endpoint, 16_000), "HALF_OPEN")
    breaker.recordWebhookSuccess(endpoint)
    assert.equal(breaker.getWebhookCircuitState(endpoint, 16_000), "CLOSED")
  })

  it("redacts secrets from the delivery log", async () => {
    const { sanitizeForLog } = await import("@/lib/webhook-delivery-log")
    const clean = sanitizeForLog({
      event: "settle.verified",
      secret: "super-secret",
      nested: { api_key: "abc", wallet: "GABC", signature: "xyz" },
    }) as Record<string, unknown>
    assert.equal(clean.secret, "[REDACTED]")
    assert.equal((clean.nested as Record<string, unknown>).api_key, "[REDACTED]")
    assert.equal(JSON.stringify(clean).includes("super-secret"), false)
    assert.equal((clean.nested as Record<string, unknown>).wallet, "GABC")
  })

  it("claims each event id exactly once", async () => {
    const { claimEventId } = await import("@/lib/webhook-delivery-log")
    assert.equal(await claimEventId("settle.verified:abc"), true)
    assert.equal(await claimEventId("settle.verified:abc"), false)
    assert.equal(await claimEventId("settle.verified:def"), true)
  })

  it("gate is off with no flag and subscription URLs are https-only", async () => {
    const { isPhase215Enabled } = await import("@/lib/webhook-subscriptions")
    assert.equal(isPhase215Enabled(), true)
    delete process.env.FEATURE_PHASE_215
    assert.equal(isPhase215Enabled(), false)
    process.env.FEATURE_PHASE_215 = "1"

    const { createSubscription } = await import("@/lib/webhook-subscriptions")
    await assert.rejects(createSubscription({ url: "http://example.com/hook", events: ["settle.verified"] }))
  })
})
