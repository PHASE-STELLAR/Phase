import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetDbForTests } from "@/lib/sqlite-db"
import {
  canonicalProofBytes,
  computeProofHash,
  verifyAndRecordProof,
  type ProofSubmission,
} from "@/lib/proof-relay"
import { GET as proofVerifyGet, POST as proofVerifyPost } from "@/app/api/proof-verify/route"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase-proof-relay-"))
  vi.stubEnv("PHASE_SERVER_DATA_DIR", dir)
  vi.stubEnv("STELLAR_NETWORK", "testnet")
  vi.stubEnv("FEATURE_PHASE_249", "0")
  vi.stubEnv("NEXT_PUBLIC_FEATURE_PHASE_249", "0")
  resetDbForTests()
})

afterEach(() => {
  resetDbForTests()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// Testnet proof fixture with Stellar testnet tx hash
const TESTNET_PROOF_FIXTURE: Omit<ProofSubmission, "proof_hash"> = {
  msg_id: "4a7d1ed414474e4033ac29ccb8653d9b4a7d1ed414474e4033ac29ccb8653d9b",
  source_chain: "stellar-testnet",
  payload: JSON.stringify({
    contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    event: "phase_settled",
    tokenId: 42,
  }),
  nonce: 1,
  signatures: ["dGVzdG5ldF92YWxpZGF0b3Jfc2lnbmF0dXJlXzE="],
}
const TESTNET_TX_HASH = "8f14e45fceea167a5a36dedd4bea25438f14e45fceea167a5a36dedd4bea2543"

describe("phase-249 proof-relay verification integration (#700)", () => {
  it("returns 404 for GET and POST when phase-249 flag is off", async () => {
    const getRes = await proofVerifyGet(
      new NextRequest(`https://phase.example/api/proof-verify?msg_id=${TESTNET_PROOF_FIXTURE.msg_id}`),
    )
    expect(getRes.status).toBe(404)

    const postRes = await proofVerifyPost(
      new NextRequest("https://phase.example/api/proof-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(TESTNET_PROOF_FIXTURE),
      }),
    )
    expect(postRes.status).toBe(404)
  })

  it("verifies a testnet proof with tx hash, records idempotently, and emits PII-free logs", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const proofHash = computeProofHash(TESTNET_PROOF_FIXTURE)
    expect(canonicalProofBytes(TESTNET_PROOF_FIXTURE).length).toBeGreaterThan(0)

    const adapter = vi.fn().mockResolvedValue({
      verified: true,
      txHash: TESTNET_TX_HASH,
      verifiedAt: 1_760_000_000,
    })

    const first = await verifyAndRecordProof(
      { ...TESTNET_PROOF_FIXTURE, proof_hash: proofHash },
      { adapter },
    )
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.replayed).toBe(false)
      expect(first.record.status).toBe("verified")
      expect(first.record.tx_hash).toBe(TESTNET_TX_HASH)
      expect(first.record.proof_hash).toBe(proofHash)
    }
    expect(adapter).toHaveBeenCalledTimes(1)

    // Replayed proof is idempotent and does not re-invoke the on-chain adapter
    const replay = await verifyAndRecordProof(
      { ...TESTNET_PROOF_FIXTURE, proof_hash: proofHash },
      { adapter },
    )
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      expect(replay.replayed).toBe(true)
      expect(replay.record.tx_hash).toBe(TESTNET_TX_HASH)
    }
    expect(adapter).toHaveBeenCalledTimes(1)

    // Verify no PII, payload, or signatures appear in structured logs
    for (const call of logSpy.mock.calls) {
      const line = String(call[0])
      expect(line).not.toContain("phase_settled")
      expect(line).not.toContain(TESTNET_PROOF_FIXTURE.signatures[0])
    }
  })

  it("rejects a tampered proof whose payload does not match its proof_hash", async () => {
    vi.stubEnv("FEATURE_PHASE_249", "1")
    const originalHash = computeProofHash(TESTNET_PROOF_FIXTURE)
    const tamperedSubmission: ProofSubmission = {
      ...TESTNET_PROOF_FIXTURE,
      payload: JSON.stringify({ event: "tampered_amount", tokenId: 9999 }),
      proof_hash: originalHash,
    }

    const res = await proofVerifyPost(
      new NextRequest("https://phase.example/api/proof-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tamperedSubmission),
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; status: string }
    expect(body.code).toBe("TAMPERED_PROOF")
    expect(body.status).toBe("failed")
  })

  it("degrades safely with a typed RELAY_TIMEOUT failure when the relay contract times out", async () => {
    const slowAdapter = vi.fn(
      (_sub: ProofSubmission, _bytes: Buffer, _hash: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("ABORTED")))
        }),
    )

    const result = await verifyAndRecordProof(TESTNET_PROOF_FIXTURE, {
      adapter: slowAdapter,
      timeoutMs: 10,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("RELAY_TIMEOUT")
      expect(result.retryable).toBe(true)
    }
  })
})
