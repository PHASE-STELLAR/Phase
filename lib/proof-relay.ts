import { createHash } from "node:crypto"
import { z } from "zod"
import { getDb } from "@/lib/sqlite-db"

export const PROOF_RELAY_TIMEOUT_MS = 4_000

export const ProofSubmissionSchema = z.object({
  msg_id: z.string().regex(/^[a-f0-9]{64}$/i, "msg_id must be a 32-byte hex string"),
  source_chain: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "Invalid source_chain"),
  payload: z.string().min(1).max(16_384),
  nonce: z.number().int().nonnegative().default(0),
  signatures: z.array(z.string().min(1).max(512)).min(1),
  proof_hash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
})

export type ProofSubmission = z.infer<typeof ProofSubmissionSchema>

export type ProofRelayFailureCode =
  | "INVALID_SCHEMA"
  | "TAMPERED_PROOF"
  | "RELAY_TIMEOUT"
  | "RELAY_UNAVAILABLE"
  | "CONTRACT_REJECTED"

export class ProofRelayError extends Error {
  code: ProofRelayFailureCode
  retryable: boolean

  constructor(code: ProofRelayFailureCode, message: string, retryable = false) {
    super(message)
    this.name = "ProofRelayError"
    this.code = code
    this.retryable = retryable
  }
}

export type ProofVerificationRecord = {
  proof_hash: string
  msg_id: string
  source_chain: string
  status: "pending" | "verified" | "failed"
  tx_hash: string | null
  verified_at: number | null
  failure_code: string | null
  created_at: number
}

export type ProofRelayAdapterResult =
  | { verified: true; txHash: string; verifiedAt: number }
  | { verified: false; code: ProofRelayFailureCode; reason: string }

export type ProofRelayAdapter = (
  submission: ProofSubmission,
  canonicalBytes: Buffer,
  proofHash: string,
  signal: AbortSignal,
) => Promise<ProofRelayAdapterResult>

function ensureProofRelayTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS proof_relay_verifications (
      proof_hash   TEXT PRIMARY KEY,
      msg_id       TEXT NOT NULL,
      source_chain TEXT NOT NULL,
      status       TEXT NOT NULL,
      tx_hash      TEXT,
      verified_at  INTEGER,
      failure_code TEXT,
      created_at   INTEGER NOT NULL
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_proof_relay_msg_id ON proof_relay_verifications (msg_id)")
}

/**
 * Deterministic canonical byte encoding for proof hashing and on-chain relay verification.
 */
export function canonicalProofBytes(input: Pick<ProofSubmission, "msg_id" | "source_chain" | "payload" | "nonce">): Buffer {
  const canonical = JSON.stringify({
    msg_id: input.msg_id.toLowerCase(),
    source_chain: input.source_chain,
    payload: input.payload,
    nonce: input.nonce ?? 0,
  })
  return Buffer.from(canonical, "utf8")
}

export function computeProofHash(input: Pick<ProofSubmission, "msg_id" | "source_chain" | "payload" | "nonce">): string {
  return createHash("sha256").update(canonicalProofBytes(input)).digest("hex")
}

/**
 * Emit structured proof-relay log without PII (no payloads, signatures, or wallet addresses).
 */
export function logProofRelayEvent(
  event: "proof_verified" | "proof_replayed" | "proof_rejected" | "proof_timeout",
  proofHash: string,
  status: string,
  code?: string,
): void {
  console.info(
    JSON.stringify({
      event,
      proofHashPrefix: proofHash.slice(0, 12),
      status,
      ...(code ? { code } : {}),
      ts: new Date().toISOString(),
    }),
  )
}

export function getProofVerificationByHash(proofHash: string): ProofVerificationRecord | null {
  ensureProofRelayTable()
  const row = getDb()
    .prepare(
      `SELECT proof_hash, msg_id, source_chain, status, tx_hash, verified_at, failure_code, created_at
       FROM proof_relay_verifications WHERE proof_hash = ? LIMIT 1`,
    )
    .get(proofHash) as ProofVerificationRecord | undefined
  return row ?? null
}

export function getProofVerificationByMsgId(msgId: string): ProofVerificationRecord | null {
  ensureProofRelayTable()
  const row = getDb()
    .prepare(
      `SELECT proof_hash, msg_id, source_chain, status, tx_hash, verified_at, failure_code, created_at
       FROM proof_relay_verifications WHERE msg_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(msgId.toLowerCase()) as ProofVerificationRecord | undefined
  return row ?? null
}

/**
 * Record verification result idempotently by proof_hash.
 * Returns { record, replayed } where replayed=true if proof_hash already existed.
 */
export function recordProofVerificationIdempotently(
  input: Omit<ProofVerificationRecord, "created_at">,
  now: Date = new Date(),
): { record: ProofVerificationRecord; replayed: boolean } {
  ensureProofRelayTable()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const result = getDb()
    .prepare(
      `INSERT INTO proof_relay_verifications
        (proof_hash, msg_id, source_chain, status, tx_hash, verified_at, failure_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (proof_hash) DO NOTHING`,
    )
    .run(
      input.proof_hash,
      input.msg_id.toLowerCase(),
      input.source_chain,
      input.status,
      input.tx_hash,
      input.verified_at,
      input.failure_code,
      nowSeconds,
    )

  const existing = getProofVerificationByHash(input.proof_hash)!
  return {
    record: existing,
    replayed: Number(result.changes) === 0,
  }
}

async function defaultProofRelayAdapter(
  submission: ProofSubmission,
  _canonicalBytes: Buffer,
  _proofHash: string,
  signal: AbortSignal,
): Promise<ProofRelayAdapterResult> {
  const rpcUrl = process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org"
  const contractId = process.env.PHASE_PROOF_RELAY_CONTRACT_ID?.trim()
  if (!contractId) {
    return {
      verified: false,
      code: "RELAY_UNAVAILABLE",
      reason: "PHASE_PROOF_RELAY_CONTRACT_ID is not configured.",
    }
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `proof-relay-${submission.msg_id.slice(0, 12)}`,
      method: "getLedgerEntries",
      params: { keys: [] },
    }),
    signal,
  })

  if (!response.ok) {
    return {
      verified: false,
      code: "RELAY_UNAVAILABLE",
      reason: `Soroban RPC returned HTTP ${response.status}`,
    }
  }

  return {
    verified: false,
    code: "CONTRACT_REJECTED",
    reason: "Proof not verified on-chain by relay contract.",
  }
}

export async function verifyAndRecordProof(
  submission: ProofSubmission,
  options?: {
    adapter?: ProofRelayAdapter
    timeoutMs?: number
    now?: Date
  },
): Promise<
  | { ok: true; record: ProofVerificationRecord; replayed: boolean }
  | { ok: false; code: ProofRelayFailureCode; error: string; retryable: boolean; proofHash: string }
> {
  const bytes = canonicalProofBytes(submission)
  const proofHash = computeProofHash(submission)

  if (submission.proof_hash && submission.proof_hash.toLowerCase() !== proofHash) {
    logProofRelayEvent("proof_rejected", proofHash, "failed", "TAMPERED_PROOF")
    return {
      ok: false,
      code: "TAMPERED_PROOF",
      error: "Submitted proof_hash does not match canonical proof bytes.",
      retryable: false,
      proofHash,
    }
  }

  const existing = getProofVerificationByHash(proofHash)
  if (existing) {
    logProofRelayEvent("proof_replayed", proofHash, existing.status)
    return { ok: true, record: existing, replayed: true }
  }

  const adapter = options?.adapter ?? defaultProofRelayAdapter
  const timeoutMs = options?.timeoutMs ?? PROOF_RELAY_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const outcome = await Promise.race([
      adapter(submission, bytes, proofHash, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new ProofRelayError("RELAY_TIMEOUT", "Proof relay verification timed out.", true))
        }, timeoutMs)
      }),
    ])

    if (!outcome.verified) {
      logProofRelayEvent("proof_rejected", proofHash, "failed", outcome.code)
      return {
        ok: false,
        code: outcome.code,
        error: outcome.reason,
        retryable: outcome.code === "RELAY_TIMEOUT" || outcome.code === "RELAY_UNAVAILABLE",
        proofHash,
      }
    }

    const { record, replayed } = recordProofVerificationIdempotently(
      {
        proof_hash: proofHash,
        msg_id: submission.msg_id,
        source_chain: submission.source_chain,
        status: "verified",
        tx_hash: outcome.txHash,
        verified_at: outcome.verifiedAt,
        failure_code: null,
      },
      options?.now,
    )
    logProofRelayEvent(replayed ? "proof_replayed" : "proof_verified", proofHash, record.status)
    return { ok: true, record, replayed }
  } catch (err) {
    if (err instanceof ProofRelayError && err.code === "RELAY_TIMEOUT") {
      logProofRelayEvent("proof_timeout", proofHash, "failed", "RELAY_TIMEOUT")
      return {
        ok: false,
        code: "RELAY_TIMEOUT",
        error: err.message,
        retryable: true,
        proofHash,
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    logProofRelayEvent("proof_rejected", proofHash, "failed", "RELAY_UNAVAILABLE")
    return {
      ok: false,
      code: "RELAY_UNAVAILABLE",
      error: msg,
      retryable: true,
      proofHash,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
