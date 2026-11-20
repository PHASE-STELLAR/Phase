import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  clearExplorerMetadataCacheForTests,
  computeExplorerMetadataDigest,
  EXPLORER_METADATA_TTL_MS,
  fetchExplorerMetadata,
} from "@/lib/explorer-metadata"
import { GET as explorerVerifyGet } from "@/app/api/explorer-verify/route"

beforeEach(() => {
  clearExplorerMetadataCacheForTests()
  vi.stubEnv("FEATURE_PHASE_250", "0")
  vi.stubEnv("NEXT_PUBLIC_FEATURE_PHASE_250", "0")
})

afterEach(() => {
  clearExplorerMetadataCacheForTests()
  vi.unstubAllEnvs()
})

describe("phase-250 explorer metadata integration (#701)", () => {
  it("hides badge and returns 404 when phase-250 flag is off", async () => {
    const adapter = vi.fn()
    const result = await fetchExplorerMetadata(1, undefined, { adapter })
    expect(result.status).toBe("disabled")
    expect(result.showVerifiedBadge).toBe(false)
    expect(adapter).not.toHaveBeenCalled()

    const res = await explorerVerifyGet(
      new NextRequest("https://phase.example/api/explorer-verify?collection_id=1"),
    )
    expect(res.status).toBe(404)
  })

  it("surfaces verified badge only when digest matches and removes it on mismatch", async () => {
    vi.stubEnv("FEATURE_PHASE_250", "1")
    const expectedDigest = computeExplorerMetadataDigest({
      collectionId: 42,
      name: "Phase Genesis",
      externalUrl: "https://phase.example/collections/42",
    })

    const adapter = vi.fn().mockResolvedValue({
      collectionId: 42,
      name: "Phase Genesis",
      externalUrl: "https://phase.example/collections/42",
      verified: true,
    })

    const matched = await fetchExplorerMetadata(42, expectedDigest, { adapter, now: 1_000 })
    expect(matched.status).toBe("verified")
    expect(matched.showVerifiedBadge).toBe(true)
    expect(matched.stale).toBe(false)

    // Mismatched committed digest removes the verified badge
    const tamperedDigest = "0".repeat(64)
    const mismatched = await fetchExplorerMetadata(42, tamperedDigest, { adapter, now: 2_000 })
    expect(mismatched.status).toBe("mismatch")
    expect(mismatched.showVerifiedBadge).toBe(false)
  })

  it("labels stale data on error after short TTL without trusting it as fresh", async () => {
    vi.stubEnv("FEATURE_PHASE_250", "1")
    const digest = computeExplorerMetadataDigest({
      collectionId: 7,
      name: "Stellar Relics",
      externalUrl: "https://phase.example/collections/7",
    })

    const okAdapter = vi.fn().mockResolvedValue({
      collectionId: 7,
      name: "Stellar Relics",
      externalUrl: "https://phase.example/collections/7",
      verified: true,
    })

    const fresh = await fetchExplorerMetadata(7, digest, { adapter: okAdapter, now: 10_000 })
    expect(fresh.status).toBe("verified")
    expect(fresh.showVerifiedBadge).toBe(true)

    // After TTL expires, adapter fails -> stale-on-error fence labels data stale and hides verified badge
    const failingAdapter = vi.fn().mockRejectedValue(new Error("RPC_UNAVAILABLE"))
    const stale = await fetchExplorerMetadata(7, digest, {
      adapter: failingAdapter,
      now: 10_000 + EXPLORER_METADATA_TTL_MS + 1_000,
    })
    expect(stale.status).toBe("stale")
    expect(stale.stale).toBe(true)
    expect(stale.showVerifiedBadge).toBe(false)
    expect(stale.metadata?.name).toBe("Stellar Relics")
  })

  it("degrades gracefully on cold adapter timeout", async () => {
    vi.stubEnv("FEATURE_PHASE_250", "1")
    const slowAdapter = vi.fn(
      (_id: number, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("ABORTED")))
        }),
    )

    const result = await fetchExplorerMetadata(99, undefined, {
      adapter: slowAdapter,
      timeoutMs: 10,
    })
    expect(result.status).toBe("unavailable")
    expect(result.showVerifiedBadge).toBe(false)
    expect(result.stale).toBe(false)
    expect(result.metadata).toBeNull()
  })
})
