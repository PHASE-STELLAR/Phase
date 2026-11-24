import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { StrKey } from "@stellar/stellar-sdk"
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
    expect(isExplorerEnabled()).toBe(true)
    process.env.FEATURE_PHASE_220 = "0"
    expect(isExplorerEnabled()).toBe(false)
  })

  it("builds correct testnet links for every entity", () => {
    for (const [entity, id, path] of [
      ["tx", TX_HASH, "tx"],
      ["contract", CONTRACT, "contract"],
      ["account", ISSUER, "account"],
      ["asset", `PHASERLIQ-${ISSUER}`, "asset"],
    ] as const) {
      const link = buildExplorerUrl({ entity, id })
      expect(link.ok).toBe(true)
      if (link.ok) {
        expect(link.url).toBe(`https://stellar.expert/explorer/testnet/${path}/${id}`)
        expect(isSafeExplorerUrl(link.url)).toBe(true)
      }
    }
  })

  it("rejects invalid ids and unsafe URLs", () => {
    expect(isValidTxHash("not-a-hash")).toBe(false)
    expect(buildExplorerUrl({ entity: "tx", id: "xyz" }).ok).toBe(false)
    expect(isSafeExplorerUrl("https://evil.example/explorer/testnet/tx/x")).toBe(false)
    expect(isSafeExplorerUrl("http://stellar.expert/explorer/testnet/tx/x")).toBe(false)
    expect(isSafeExplorerUrl("javascript:alert(1)")).toBe(false)
  })

  it("fences mainnet links unless explicitly allowed", () => {
    expect(isMainnetLinksAllowed()).toBe(false)
    const fenced = buildExplorerUrl({ entity: "tx", id: TX_HASH, network: "mainnet" })
    expect(fenced.ok).toBe(false)
    expect(getSecurityCounter("explorer_mainnet_link_blocked")).toBe(1)
    process.env.PHASE_EXPLORER_ALLOW_MAINNET = "1"
    const allowed = buildExplorerUrl({ entity: "tx", id: TX_HASH, network: "mainnet" })
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.url).toBe(`https://stellar.expert/explorer/public/tx/${TX_HASH}`)
  })

  it("rejects any request field beyond kind and id (no PII)", () => {
    expect(sanitizeEnrichmentRequest({ kind: "tx", id: TX_HASH }).ok).toBe(true)
    expect(sanitizeEnrichmentRequest({ kind: "tx", id: TX_HASH, walletAddress: ISSUER }).ok).toBe(false)
    expect(sanitizeEnrichmentRequest({ kind: "tx", id: TX_HASH, memo: "hi" }).ok).toBe(false)
    expect(sanitizeEnrichmentRequest({ kind: "profile", id: ISSUER }).ok).toBe(false)
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
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.ledger).toBe(42)
      expect(result.data.hash).toBe(TX_HASH)
      expect(JSON.stringify(result.data)).not.toContain("secret")
    }
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain(`/transactions/${TX_HASH}`)
  })

  it("degrades gracefully on timeout and when the flag is off", async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as typeof fetch
    const timedOut = await fetchTxEnrichment(TX_HASH, { fetchImpl: hanging, timeoutMs: 5 })
    expect(timedOut.ok).toBe(false)
    if (!timedOut.ok) expect(timedOut.reason).toBe("timeout")

    process.env.FEATURE_PHASE_220 = "0"
    const disabled = await fetchTxEnrichment(TX_HASH)
    expect(disabled.ok).toBe(false)
    if (!disabled.ok) expect(disabled.reason).toBe("disabled")
  })

  it("enriches asset metadata without sending wallet data", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain("asset_code=PHASERLIQ")
      expect(url).toContain(`asset_issuer=${ISSUER}`)
      return new Response(
        JSON.stringify({ _embedded: { records: [{ amount: "1000.0", num_accounts: 3 }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
    const result = await fetchAssetEnrichment(`PHASERLIQ-${ISSUER}`, { fetchImpl })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.code).toBe("PHASERLIQ")
  })
})
