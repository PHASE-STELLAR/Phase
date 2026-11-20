import { createHash } from "node:crypto"
import { Keypair } from "@stellar/stellar-sdk"
import { z } from "zod"
import { getDb } from "@/lib/sqlite-db"
import { resolveStellarNetwork } from "@/lib/stellar-network"
import { incSecurityCounter, type CUSTODIAN_RELEASE_REASONS } from "@/lib/security-counters"

export const CUSTODIAN_RELEASE_DOMAIN = "Phase Custodian Release v1"
export const CUSTODIAN_RELEASE_PREFIX = "Stellar Signed Message:\n"
export const CUSTODIAN_RELEASE_CLOCK_SKEW_SECONDS = 30
export const CUSTODIAN_RELEASE_MAX_TTL_SECONDS = 3600

export type CustodianReleaseAuditReason = (typeof CUSTODIAN_RELEASE_REASONS)[number]

export const CustodianReleaseClaimsSchema = z.object({
  tokenId: z.number().int().positive(),
  recipient: z.string().length(56).regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address"),
  nonce: z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "Invalid nonce format"),
  exp: z.number().int().positive(),
})

export type CustodianReleaseClaims = z.infer<typeof CustodianReleaseClaimsSchema>

export type CustodianAuthVerificationResult =
  | { ok: true; claims: CustodianReleaseClaims }
  | {
      ok: false
      code:
        | "MISSING_AUTHORIZATION"
        | "MALFORMED_CLAIMS"
        | "CLAIMS_MISMATCH"
        | "EXPIRED_AUTHORIZATION"
        | "FORGED_AUTHORIZATION"
      error: string
    }

function ensureCustodianReleaseTables(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS custodian_release_nonces (
      nonce       TEXT PRIMARY KEY,
      token_id    INTEGER NOT NULL,
      recipient   TEXT NOT NULL,
      consumed_at INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_custodian_nonces_expires ON custodian_release_nonces (expires_at)")
  db.exec(`
    CREATE TABLE IF NOT EXISTS custodian_released_tokens (
      token_id    INTEGER PRIMARY KEY,
      recipient   TEXT NOT NULL,
      nonce       TEXT NOT NULL,
      tx_hash     TEXT,
      released_at INTEGER NOT NULL
    )
  `)
}

export function serverCustodianNetworkPassphrase(): string {
  return resolveStellarNetwork().passphrase
}

export function buildCustodianReleaseMessage(
  claims: CustodianReleaseClaims,
  contractId: string,
  networkPassphrase: string = serverCustodianNetworkPassphrase(),
): string {
  return [
    CUSTODIAN_RELEASE_DOMAIN,
    networkPassphrase,
    contractId,
    String(claims.tokenId),
    claims.recipient,
    claims.nonce,
    String(claims.exp),
  ].join("|")
}

export function custodianReleaseDigestBytes(
  claims: CustodianReleaseClaims,
  contractId: string,
  networkPassphrase: string = serverCustodianNetworkPassphrase(),
): Buffer {
  const message = buildCustodianReleaseMessage(claims, contractId, networkPassphrase)
  return createHash("sha256")
    .update(`${CUSTODIAN_RELEASE_PREFIX}${message}`, "utf8")
    .digest()
}

export function verifyCustodianReleaseAuthorization(input: {
  claims: unknown
  signatureBase64: string | undefined
  tokenId: number
  recipient: string
  contractId: string
  networkPassphrase?: string
  now?: Date
}): CustodianAuthVerificationResult {
  if (!input.signatureBase64 || typeof input.signatureBase64 !== "string" || input.signatureBase64.trim().length === 0) {
    return {
      ok: false,
      code: "MISSING_AUTHORIZATION",
      error: "Signed release authorization is required.",
    }
  }

  const parsed = CustodianReleaseClaimsSchema.safeParse(input.claims)
  if (!parsed.success) {
    return {
      ok: false,
      code: "MALFORMED_CLAIMS",
      error: "Malformed release authorization claims.",
    }
  }

  const claims = parsed.data
  if (claims.tokenId !== input.tokenId || claims.recipient.toUpperCase() !== input.recipient.toUpperCase()) {
    return {
      ok: false,
      code: "CLAIMS_MISMATCH",
      error: "Release authorization is not bound to the requested tokenId and recipient.",
    }
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  if (claims.exp + CUSTODIAN_RELEASE_CLOCK_SKEW_SECONDS <= nowSeconds) {
    return {
      ok: false,
      code: "EXPIRED_AUTHORIZATION",
      error: "Release authorization has expired.",
    }
  }
  if (claims.exp - nowSeconds > CUSTODIAN_RELEASE_MAX_TTL_SECONDS) {
    return {
      ok: false,
      code: "MALFORMED_CLAIMS",
      error: "Release authorization expiry exceeds maximum TTL.",
    }
  }

  let sigBytes: Buffer
  try {
    sigBytes = Buffer.from(input.signatureBase64.trim(), "base64")
    if (sigBytes.length !== 64) {
      return {
        ok: false,
        code: "FORGED_AUTHORIZATION",
        error: "Invalid Ed25519 signature length.",
      }
    }
  } catch {
    return {
      ok: false,
      code: "FORGED_AUTHORIZATION",
      error: "Malformed base64 signature.",
    }
  }

  try {
    const kp = Keypair.fromPublicKey(claims.recipient)
    const digest = custodianReleaseDigestBytes(claims, input.contractId, input.networkPassphrase)
    if (!kp.verify(digest, sigBytes)) {
      return {
        ok: false,
        code: "FORGED_AUTHORIZATION",
        error: "Release authorization signature verification failed.",
      }
    }
  } catch {
    return {
      ok: false,
      code: "FORGED_AUTHORIZATION",
      error: "Release authorization signature verification failed.",
    }
  }

  return { ok: true, claims }
}

/**
 * Atomically consume a release nonce in SQLite.
 * Returns false if the nonce was already consumed (replay).
 */
export function consumeCustodianReleaseNonce(
  nonce: string,
  tokenId: number,
  recipient: string,
  expiresAtSeconds: number,
  now: Date = new Date(),
): boolean {
  ensureCustodianReleaseTables()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const result = getDb()
    .prepare(
      `INSERT INTO custodian_release_nonces (nonce, token_id, recipient, consumed_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (nonce) DO NOTHING`,
    )
    .run(nonce, tokenId, recipient, nowSeconds, expiresAtSeconds)
  return Number(result.changes) > 0
}

export function isTokenCustodianReleased(tokenId: number): boolean {
  ensureCustodianReleaseTables()
  const row = getDb()
    .prepare("SELECT token_id FROM custodian_released_tokens WHERE token_id = ? LIMIT 1")
    .get(tokenId) as { token_id?: number } | undefined
  return row?.token_id !== undefined
}

/**
 * Atomically reserve a token release slot in SQLite so released tokens cannot be re-released.
 */
export function reserveCustodianTokenRelease(
  tokenId: number,
  recipient: string,
  nonce: string,
  now: Date = new Date(),
): boolean {
  ensureCustodianReleaseTables()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const result = getDb()
    .prepare(
      `INSERT INTO custodian_released_tokens (token_id, recipient, nonce, tx_hash, released_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (token_id) DO NOTHING`,
    )
    .run(tokenId, recipient, nonce, nowSeconds)
  return Number(result.changes) > 0
}

export function finalizeCustodianTokenRelease(tokenId: number, txHash: string | null): void {
  ensureCustodianReleaseTables()
  getDb()
    .prepare("UPDATE custodian_released_tokens SET tx_hash = ? WHERE token_id = ?")
    .run(txHash, tokenId)
}

export function rollbackCustodianTokenRelease(tokenId: number): void {
  ensureCustodianReleaseTables()
  getDb()
    .prepare("DELETE FROM custodian_released_tokens WHERE token_id = ? AND tx_hash IS NULL")
    .run(tokenId)
}

/**
 * Emit a closed-label audit event for custodian release outcomes.
 * Never logs PII (no wallet addresses, no nonces, no token IDs).
 */
export function emitCustodianReleaseAuditEvent(reason: CustodianReleaseAuditReason): void {
  incSecurityCounter("custodian_release_total", reason)
  if (reason === "released") {
    incSecurityCounter("custodian_release_success")
  } else if (reason === "forged_authorization") {
    incSecurityCounter("custodian_release_forged")
  } else if (reason === "nonce_replay") {
    incSecurityCounter("custodian_release_replay")
  } else if (reason === "already_released") {
    incSecurityCounter("custodian_release_already_released")
  }
  console.info(
    JSON.stringify({
      event: "custodian_release_audit",
      reason,
      ts: new Date().toISOString(),
    }),
  )
}
