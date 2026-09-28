/**
 * NFT-index subscription hardening (Issue #228).
 *
 * An nft-index subscription receives every transfer event for the indexed
 * contract, so pointing one at an attacker-controlled host is a standing
 * exfiltration channel (and pointing it at an internal address is SSRF).
 * Subscription now requires an https public URL and a verifiable challenge
 * echo before anything is registered with Mercury.
 *
 * Run with: npm test
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { validateWebhookUrl, verifyWebhookChallenge } from "@/app/api/nft-index/subscribe/route"

describe("nft-index subscribe webhook URL validation (Issue #228)", () => {
  it("accepts a public https endpoint", () => {
    const res = validateWebhookUrl("https://hooks.example.com/mercury")
    assert.equal(res.ok, true)
  })

  it("rejects plaintext http", () => {
    const res = validateWebhookUrl("http://hooks.example.com/mercury")
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.reason, "insecure_protocol")
  })

  it("rejects loopback and internal hostnames", () => {
    for (const url of [
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://app.internal/hook",
      "https://db.local/hook",
    ]) {
      assert.equal(validateWebhookUrl(url).ok, false, url)
    }
  })

  it("rejects cloud metadata and private-network literals (SSRF)", () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/hook",
      "https://192.168.1.1/hook",
    ]) {
      assert.equal(validateWebhookUrl(url).ok, false, url)
    }
  })

  it("rejects embedded credentials", () => {
    const res = validateWebhookUrl("https://user:pass@hooks.example.com/hook")
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.reason, "credentials")
  })

  it("rejects a malformed URL", () => {
    assert.equal(validateWebhookUrl("not a url").ok, false)
  })
})

describe("nft-index subscribe webhook challenge (Issue #228)", () => {
  const realFetch = globalThis.fetch

  function stubFetch(impl: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>) {
    globalThis.fetch = ((input: RequestInfo | URL) =>
      impl(String(input))) as unknown as typeof fetch
  }

  it("passes when the endpoint echoes the challenge", async () => {
    const challenge = "chal-123"
    stubFetch(async (url) => ({ ok: true, text: async () => url.includes(challenge) ? challenge : "nope" }))
    try {
      assert.equal(
        await verifyWebhookChallenge("https://hooks.example.com/hook", challenge),
        true,
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("fails when the endpoint returns a non-2xx", async () => {
    stubFetch(async () => ({ ok: false, text: async () => "unauthorized" }))
    try {
      assert.equal(
        await verifyWebhookChallenge("https://evil.example/hook", "chal-456"),
        false,
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("fails when the endpoint does not echo the challenge", async () => {
    stubFetch(async () => ({ ok: true, text: async () => "<html>captured</html>" }))
    try {
      assert.equal(
        await verifyWebhookChallenge("https://evil.example/hook", "chal-789"),
        false,
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("fails closed when the endpoint is unreachable", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED")
    })
    try {
      assert.equal(
        await verifyWebhookChallenge("https://dead.example/hook", "chal-000"),
        false,
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
