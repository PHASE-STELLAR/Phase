import { afterEach, beforeEach, describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  buildExplorerUrl,
  fetchAssetEnrichment,
  fetchTxEnrichment,
  isExplorerEnabled,
  isMainnetLinksAllowed,
  isSafeExplorerUrl,
  isValidTxHash,
  sanitizeEnrichmentRequest,
} from "@/lib/explorer-links"
import { StrKey } from "@stellar/stellar-sdk"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"

const TX_HASH = "a".repeat(64)
const ISSUER = "GD7VAD4VDVHASKZIJPRORMXLML4RSVLRANYNRCCBWLO5ACOSYQZBSUFI"
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3))

describe("phase-220 explorer links + enrichment", () => {
  const originalFlag = process.env.FEATURE_PHASE_220
  const originalMainnet = process.env.PHASE_EXPLORER_ALLOW_MAINNET

  beforeEach(() => {
    process.env.FEATURE_PHASE_220 = "1"
    delete process.env.PHASE_EXPLORER_ALLOW_MAINNET
    resetSecurityCounters()
  })

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_PHASE_220
    else process.env.FEATURE_PHASE_220 = originalFlag
    if (originalMainnet === undefined) delete process.env.PHASE_EXPLORER_ALLOW_MAINNET
    else process.env.PHASE_EXPLORER_ALLOW_MAINNET = originalMainnet
  })

  it("is flag gated", () => {
    assert.equal(isExplorerEnabled(), true)
    process.env.FEATURE_PHASE_220 = "0"
    assert.equal(isExplorerEnabled(), false)
  })

  it("builds correct testnet links for every entity", () => {
    for (const [entity, id, path] of [
      ["tx", TX_HASH, "tx"],
      ["contract", CONTRACT, "contract"],
      ["account", ISSUER, "account"],
      ["asset", `PHASERLIQ-${ISSUER}`, "asset"],
    ] as const) {
      const link = buildExplorerUrl({ entity, id })
      assert.equal(link.ok, true)
      if (link.ok) {
        assert.equal(link.url, `https://stellar.expert/explorer/testnet/${path}/${id}`)
        assert.equal(isSafeExplorerUrl(link.url), true)
      }
    }
  })

  it("rejects invalid ids and unsafe URLs", () => {
    assert.equal(isValidTxHash("not-a-hash"), false)
    assert.equal(buildExplorerUrl({ entity: "tx", id: "xyz" }).ok, false)
    assert.equal(isSafeExplorerUrl("https://evil.example/explorer/testnet/tx/x"), false)
    assert.equal(isSafeExplorerUrl("http://stellar.expert/explorer/testnet/tx/x"), false)
    assert.equal(isSafeExplorerUrl("javascript:alert(1)"), false)
  })

  it("fences mainnet links unless explicitly allowed", () => {
    assert.equal(isMainnetLinksAllowed(), false)
    const fenced = buildExplorerUrl({ entity: "tx", id: TX_HASH, network: "mainnet" })
    assert.equal(fenced.ok, false)
    assert.equal(getSecurityCounter("explorer_mainnet_link_blocked"), 1)
    process.env.PHASE_EXPLORER_ALLOW_MAINNET = "1"
    const allowed = buildExplorerUrl({ entity: "tx", id: TX_HASH, network: "mainnet" })
    assert.equal(allowed.ok, true)
    if (allowed.ok) assert.equal(allowed.url, `https://stellar.expert/explorer/public/tx/${TX_HASH}`)
  })

  it("rejects any request field beyond kind and id (no PII)", () => {
    const ok = sanitizeEnrichmentRequest({ kind: "tx", id: TX_HASH })
    assert.equal(ok.ok, true)
    assert.equal(
      sanitizeEnrichmentRequest({ kind: "tx", id: TX_HASH, walletAddress: ISSUER }).ok,
      false,
    )
    assert.equal(sanitizeEnrichmentRequest({ kind: "tx", id: TX_HASH, memo: "hi" }).ok, false)
    assert.equal(sanitizeEnrichmentRequest({ kind: "profile", id: ISSUER }).ok, false)
  })

  it("enriches a tx read-only and strips account/memo from the payload", async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return new Response(
        JSON.stringify({
          hash: TX_HASH,
          ledger: 42,
          created_at: "2026-01-01T00:00:00Z",
          successful: true,
          fee_charged: "100",
          source_account: ISSUER,
          memo: "secret",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
    const result = await fetchTxEnrichment(TX_HASH, { fetchImpl })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.data.ledger, 42)
      assert.equal(result.data.hash, TX_HASH)
      assert.ok(!JSON.stringify(result.data).includes("secret"))
    }
    assert.equal(calls.length, 1)
    assert.ok(calls[0]!.includes(`/transactions/${TX_HASH}`))
  })

  it("degrades gracefully on timeout and when the flag is off", async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as typeof fetch
    const timedOut = await fetchTxEnrichment(TX_HASH, { fetchImpl: hanging, timeoutMs: 5 })
    assert.equal(timedOut.ok, false)
    if (!timedOut.ok) assert.equal(timedOut.reason, "timeout")

    process.env.FEATURE_PHASE_220 = "0"
    const disabled = await fetchTxEnrichment(TX_HASH)
    assert.equal(disabled.ok, false)
    if (!disabled.ok) assert.equal(disabled.reason, "disabled")
  })

  it("enriches asset metadata without sending wallet data", async () => {
    const fetchImpl = (async (url: string) => {
      assert.ok(url.includes("asset_code=PHASERLIQ"))
      assert.ok(url.includes(`asset_issuer=${ISSUER}`))
      return new Response(
        JSON.stringify({ _embedded: { records: [{ amount: "1000.0", num_accounts: 3 }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
    const result = await fetchAssetEnrichment(`PHASERLIQ-${ISSUER}`, { fetchImpl })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.data.code, "PHASERLIQ")
  })
})
