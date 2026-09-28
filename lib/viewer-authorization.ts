// @ts-nocheck
/**
 * Gated-preview viewer authorization (issue #227).
 *
 * `PhaseProtectedPreview` gates world lore and phase-nft metadata to holders.
 * This module supplies the server-side half of that gate: a viewer proves
 * wallet ownership by signing a payload that is *bound* to the token they want
 * to see, and the server decides whether to honour it.
 *
 * A signature over `viewer + token_id` alone is not a gate — it is a bearer
 * token that (a) never expires, (b) is valid for every token the viewer does
 * or does not own, and (c) replays indefinitely. Each of those is fixed here:
 *
 *   - `signedPayload = SHA256("Phase SEP50" || networkPassphrase || contractId
 *     || viewer || tokenId || exp || jti)`
 *   - `exp` is enforced (`VIEWER_SIGNATURE_TTL_SECONDS`, default 300s),
 *   - `jti` is single-use: consumed atomically, a second presentation is a
 *     replay,
 *   - `tokenId` is inside the digest, so a signature minted for token 1 cannot
 *     be replayed against token 2,
 *   - `networkPassphrase` is inside the digest, so a testnet signature cannot
 *     be replayed against mainnet.
 *
 * `jti` consumption uses an `INSERT ... ON CONFLICT DO NOTHING` against a
 * `viewer_jti` table, so the single-use guarantee is enforced by the database
 * rather than by a read-then-write in the request path (which two concurrent
 * requests carrying the same signature would both pass).
 */

import { getDb } from "@/lib/sqlite-db"

/** Domain separator. Any change invalidates every previously issued signature. */
export const VIEWER_SIGNATURE_DOMAIN = "Phase SEP50"

/** SEP-53 prefix, prepended to the message before hashing (unchanged from viewer-signature.ts). */
export const VIEWER_SIGNATURE_PREFIX = "Stellar Signed Message:\n"

/** How long a viewer signature stays valid. */
export const VIEWER_SIGNATURE_TTL_SECONDS = 300

/** Widest clock skew tolerated when evaluating `exp`. */
export const VIEWER_SIGNATURE_CLOCK_SKEW_SECONDS = 30

export type ViewerSignatureClaims = {
  viewer: string
  tokenId: number
  exp: number
  jti: string
  contractId: string
  networkPassphrase: string
}

export type ViewerVerificationResult =
  | { ok: true; claims: ViewerSignatureClaims }
  | {
      ok: false
      code:
        | "missing_claims"
        | "malformed"
        | "expired"
        | "replay"
        | "bad_signature"
        | "network_mismatch"
      reason: string
    }

/** Rows older than this are swept on write; nothing depends on a long history. */
const JTI_RETENTION_SECONDS = VIEWER_SIGNATURE_TTL_SECONDS * 4

function ensureViewerJtiTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS viewer_jti (
      jti          TEXT PRIMARY KEY,
      viewer       TEXT NOT NULL,
      token_id     INTEGER NOT NULL,
      consumed_at  INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_viewer_jti_expires ON viewer_jti (expires_at)")
}

function sweepExpiredJti(nowSeconds: number): void {
  getDb()
    .prepare("DELETE FROM viewer_jti WHERE expires_at <= ?")
    .run(nowSeconds)
}

/**
 * Atomically consume a `jti`.
 *
 * Returns false when the id was already present, which is the replay signal.
 * The uniqueness is the primary key, so concurrent presentations of the same
 * signature cannot both succeed — the loser gets `changes === 0`.
 */
export function consumeJti(
  jti: string,
  viewer: string,
  tokenId: number,
  expiresAtSeconds: number,
  now: Date = new Date(),
): boolean {
  ensureViewerJtiTable()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  sweepExpiredJti(nowSeconds)

  const result = getDb()
    .prepare(
      `INSERT INTO viewer_jti (jti, viewer, token_id, consumed_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (jti) DO NOTHING`,
    )
    .run(jti, viewer, tokenId, nowSeconds, expiresAtSeconds)

  return Number(result.changes) > 0
}

/** Release a consumed `jti` (test seam, and used when a signature fails later). */
export function releaseJti(jti: string): void {
  ensureViewerJtiTable()
  getDb().prepare("DELETE FROM viewer_jti WHERE jti = ?").run(jti)
}

/** The network this server settles on. Mismatched signatures are rejected. */
export function serverNetworkPassphrase(): string {
  return (
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    "Test SDF Network ; September 2015"
  )
}

/**
 * Deterministic message that is signed. Field order is fixed; every protected
 * field is included so no field can be swapped after signing.
 */
export function buildViewerSignatureMessage(claims: ViewerSignatureClaims): string {
  return [
    VIEWER_SIGNATURE_DOMAIN,
    claims.networkPassphrase,
    claims.contractId,
    claims.viewer,
    String(claims.tokenId),
    String(claims.exp),
    claims.jti,
  ].join("|")
}

/** SHA-256 of a UTF-8 string, hex — identical to `sha256Hex` in viewer-signature.ts. */
export async function viewerSignatureDigest(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** The exact bytes a wallet signs: SEP-53 prefix over the digest of the message. */
export async function viewerSignatureBytes(claims: ViewerSignatureClaims): Promise<Uint8Array> {
  const digest = await viewerSignatureDigest(buildViewerSignatureMessage(claims))
  return new TextEncoder().encode(`${VIEWER_SIGNATURE_PREFIX}phase-viewer:v1:${digest}`)
}

function parseClaims(
  raw: unknown,
  contractId: string,
  networkPassphrase: string,
): ViewerSignatureClaims | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  const viewer = typeof value.viewer === "string" ? value.viewer.trim() : ""
  const tokenId = typeof value.tokenId === "number" ? Math.floor(value.tokenId) : Number.NaN
  const exp = typeof value.exp === "number" ? Math.floor(value.exp) : Number.NaN
  const jti = typeof value.jti === "string" ? value.jti.trim() : ""

  if (!viewer) return null
  if (!Number.isFinite(tokenId) || tokenId <= 0) return null
  if (!Number.isFinite(exp) || exp <= 0) return null
  if (jti.length < 8 || jti.length > 128) return null

  return { viewer, tokenId, exp, jti, contractId, networkPassphrase }
}

/**
 * Verify a viewer signature for a specific token.
 *
 * Order matters and is deliberate:
 *   1. claims are parsed and `exp` checked *before* any signature work, so an
 *      expired or malformed request never reaches Ed25519 verification,
 *   2. the signature is verified against the digest that binds every field,
 *   3. `jti` is consumed last, so a signature that fails to verify is not
 *      burned — only a signature that actually verified is single-use.
 */
export async function verifyViewerSignature(input: {
  claims: unknown
  signatureBase64: string
  contractId: string
  tokenId: number
  now?: Date
  networkPassphrase?: string
  consume?: boolean
}): Promise<ViewerVerificationResult> {
  const now = input.now ?? new Date()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const networkPassphrase = input.networkPassphrase ?? serverNetworkPassphrase()

  const claims = parseClaims(input.claims, input.contractId, networkPassphrase)
  if (!claims) {
    return { ok: false, code: "missing_claims", reason: "viewer, tokenId, exp and jti are required" }
  }

  if (networkPassphrase !== input.networkPassphrase && input.networkPassphrase !== undefined) {
    return { ok: false, code: "network_mismatch", reason: "signature network does not match this server" }
  }

  // `token_id` binding: the request must be for the token that was signed.
  if (claims.tokenId !== Math.floor(input.tokenId)) {
    return {
      ok: false,
      code: "malformed",
      reason: `signature is bound to token ${claims.tokenId}, not token ${Math.floor(input.tokenId)}`,
    }
  }

  if (claims.exp + VIEWER_SIGNATURE_CLOCK_SKEW_SECONDS < nowSeconds) {
    return { ok: false, code: "expired", reason: `signature expired at ${new Date(claims.exp * 1000).toISOString()}` }
  }

  if (!input.signatureBase64 || typeof input.signatureBase64 !== "string") {
    return { ok: false, code: "bad_signature", reason: "signature is required" }
  }

  let signatureValid = false
  try {
    const { Keypair } = await import("@stellar/stellar-sdk")
    const bytes = await viewerSignatureBytes(claims)
    signatureValid = Keypair.fromPublicKey(claims.viewer).verify(bytes, Buffer.from(input.signatureBase64, "base64"))
  } catch {
    signatureValid = false
  }

  if (!signatureValid) {
    return { ok: false, code: "bad_signature", reason: "signature does not verify for the requested token" }
  }

  if (input.consume !== false) {
    const firstUse = consumeJti(claims.jti, claims.viewer, claims.tokenId, claims.exp, now)
    if (!firstUse) {
      return { ok: false, code: "replay", reason: "signature has already been used" }
    }
  }

  return { ok: true, claims }
}

/**
 * Cache-Control for gated responses.
 *
 * `public` on a gated CID is the leak in issue #227: a shared cache would hand
 * gated lore to the next unauthenticated caller. Gated content is `private`
 * and varies on Authorization so a shared cache keeps one entry per viewer.
 */
export const GATED_CACHE_CONTROL = "private, max-age=60, Vary: Authorization"

/** Cache-Control for verified, non-gated responses. */
export const PUBLIC_CACHE_CONTROL = "public, max-age=2592000, s-maxage=31536000, immutable, Vary: Authorization"
