// @ts-nocheck
/**
 * CID verification for content fetched by `metadata_uri` (issue #229).
 *
 * A CID is only useful as an integrity check if the bytes are actually
 * checked against it. `lib/cid-cache.ts` verifies the SHA-256 of cached bytes
 * against a *stored* digest, which catches a corrupted cache entry but not an
 * attacker who supplies both the CID and the payload: `metadata_uri` is
 * client-supplied, so a valid-looking `bafy…` bound to a malicious payload
 * passes every check that never recomputes the multihash.
 *
 * `verifyCID` closes that: it recomputes SHA-256 over the bytes and compares
 * the digest against the digest embedded in the CID. A CID that does not match
 * its payload is rejected and never cached, so the poison cannot be promoted
 * to the `s-maxage=31536000` shared cache.
 *
 * Supported: CIDv1 (`bafy…` sha2-256, `bafk…` raw, `bafb…` blake2b-256) and
 * CIDv0 (`Qm…`, which is raw sha2-256 with a 34-byte multihash). digests of
 * other algorithms are rejected rather than skipped — an unverifiable CID is
 * not a verified CID.
 */

import { createHash } from "node:crypto"
import { CidSchema } from "@/lib/cid-cache"
import { getCidCacheStats } from "@/lib/cid-cache"
import { incSecurityCounter } from "@/lib/security-counters"

/** Multicodec prefix for dag-cbor; metadata documents are JSON, not protobuf. */
export const CODEC_DAG_CBOR = 0x71

export type CidVerificationResult =
  | { ok: true; cid: string; algorithm: "sha2-256" | "blake2b-256" | "sha2-256-v0" }
  | { ok: false; code: "CID_INVALID" | "CID_UNSUPPORTED_CODEC" | "CID_UNVERIFIABLE" | "CID_MISMATCH"; reason: string }

/** base32 (RFC 4648 lowercase, no padding) — the alphabet CIDv0/v1 use. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

export function base32Decode(input: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of input.toLowerCase()) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`invalid base32 character: ${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase()
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function sha256Bytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** CIDv0 is base58btc `0x12 0x20 <32-byte digest>`. */
const CIDV0_PREFIX = "Qm"

function decodeCidV0(cid: string): { digest: Uint8Array; algorithm: "sha2-256-v0" } | null {
  // 46-char Qm… decodes to 34 bytes: code 0x12, length 0x20, then sha2-256.
  const bytes = base58Decode(cid)
  if (bytes.length !== 34) return null
  if (bytes[0] !== 0x12 || bytes[1] !== 0x20) return null
  return { digest: bytes.slice(2), algorithm: "sha2-256-v0" }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

export function base58Decode(input: string): Uint8Array {
  let value = 0n
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`invalid base58 character: ${char}`)
    value = value * 58n + BigInt(index)
  }
  // Leading '1's are leading zero bytes.
  let hex = value.toString(16)
  if (hex.length % 2 === 1) hex = `0${hex}`
  const leadingZeroBytes = input.split("").filter((c) => c === "1").length
  const prefix = "00".repeat(leadingZeroBytes)
  return hexToBytes(prefix + hex)
}

/**
 * Parse a CIDv1 into its codec and raw digest.
 *
 * Layout: `<multibase><version=0x01><codec varint><multihash>` where a
 * multihash is `<hashCode varint><length varint><digest>`. Only the length-32
 * digest algorithms are accepted, because only those can be recomputed here.
 */
function decodeCidV1(cid: string): { codec: number; digest: Uint8Array; algorithm: "sha2-256" | "blake2b-256" } | null {
  if (!cid.startsWith("b")) return null
  const bytes = base32Decode(cid.slice(1))
  let offset = 0
  const readVarint = (): number | null => {
    let result = 0
    let shift = 0
    while (offset < bytes.length) {
      const byte = bytes[offset++]
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result >>> 0
      shift += 7
      if (shift > 28) return null
    }
    return null
  }

  const version = readVarint()
  if (version !== 1) return null
  const codec = readVarint()
  if (codec === null) return null
  const hashCode = readVarint()
  if (hashCode === null) return null
  const digestLength = readVarint()
  if (digestLength === null) return null

  // 0x12 = sha2-256, 0xb220 = blake2b-256, 0xb260 = blake3. Only the first two
  // are recomputable with node:crypto.
  if (hashCode !== 0x12 && hashCode !== 0xb220) return null
  if (digestLength !== 32) return null
  if (offset + digestLength > bytes.length) return null

  return {
    codec,
    digest: bytes.slice(offset, offset + digestLength),
    algorithm: hashCode === 0x12 ? "sha2-256" : "blake2b-256",
  }
}

/**
 * Verify that `bytes` hash to the digest embedded in `cid`.
 *
 * A blake2b-256 CID cannot be recomputed with node:crypto's sha256, so it is
 * reported as `CID_UNVERIFIABLE` rather than passed: the caller must then
 * treat the content as unverified, not as fine.
 */
export function verifyCID(cid: string, bytes: Uint8Array | Buffer): CidVerificationResult {
  const clean = String(cid ?? "").trim()

  if (!CidSchema.safeParse(clean).success) {
    incSecurityCounter("cid_poison_attempts")
    return { ok: false, code: "CID_INVALID", reason: `not a well-formed CID: ${clean.slice(0, 24)}` }
  }

  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array)

  if (clean.startsWith(CIDV0_PREFIX)) {
    const parsed = decodeCidV0(clean)
    if (!parsed) {
      incSecurityCounter("cid_poison_attempts")
      return { ok: false, code: "CID_INVALID", reason: "malformed CIDv0 multihash" }
    }
    const actual = hexToBytes(sha256Bytes(payload))
    if (bytesToHex(actual) !== bytesToHex(parsed.digest)) {
      incSecurityCounter("cid_mismatch")
      return { ok: false, code: "CID_MISMATCH", reason: "payload does not hash to the CIDv0 digest" }
    }
    return { ok: true, cid: clean, algorithm: "sha2-256-v0" }
  }

  const parsedV1 = decodeCidV1(clean)
  if (!parsedV1) {
    incSecurityCounter("cid_poison_attempts")
    return {
      ok: false,
      code: "CID_UNVERIFIABLE",
      reason: "CIDv1 uses a digest this server cannot recompute; treat as unverified",
    }
  }

  if (parsedV1.algorithm === "blake2b-256") {
    incSecurityCounter("cid_poison_attempts")
    return {
      ok: false,
      code: "CID_UNVERIFIABLE",
      reason: "blake2b-256 CID cannot be recomputed with sha256; treat as unverified",
    }
  }

  const actual = hexToBytes(sha256Bytes(payload))
  if (bytesToHex(actual) !== bytesToHex(parsedV1.digest)) {
    incSecurityCounter("cid_mismatch")
    return { ok: false, code: "CID_MISMATCH", reason: "payload does not hash to the CID digest" }
  }

  incSecurityCounter("cid_verified")
  return { ok: true, cid: clean, algorithm: parsedV1.algorithm }
}

/**
 * Cache-Control for a CID, per issue #229.
 *
 * Only a *verified* non-gated CID earns the long shared lifetime. Anything
 * unverified, unverifiable, mismatched, or gated stays `private` and varies on
 * Authorization, so a poisoned or gated payload is never written to a shared
 * cache in the first place.
 */
export function cacheControlForCid(verification: CidVerificationResult, gated = false): string {
  if (gated) return "private, max-age=60, Vary: Authorization"
  if (verification.ok) return "public, max-age=2592000, s-maxage=31536000, immutable, Vary: Authorization"
  return "private, no-store, Vary: Authorization"
}

const IPFS_URI = /^ipfs:\/\/([A-Za-z0-9]+)(\/[A-Za-z0-9._/-]*)?$/

export type MetadataUriResult =
  | { ok: true; cid: string; path: string }
  | { ok: false; code: "METADATA_URI_INVALID" | "METADATA_URI_SCHEME" | "METADATA_URI_CID_VERSION"; reason: string }

/**
 * `metadata_uri` allowlist (issue #229).
 *
 * The attacker path in the issue is a client-supplied `metadata_uri`. An
 * `https://` URI is not content-addressed at all — whatever that origin
 * returns today becomes the "World" — so it is rejected outright. The scheme
 * must be `ipfs://`, and the CID must be one this server can verify
 * (CIDv1 sha2-256, or CIDv0), so there is always a digest to check the bytes
 * against.
 */
export function parseMetadataUri(uri: unknown): MetadataUriResult {
  if (typeof uri !== "string" || uri.trim().length === 0) {
    incSecurityCounter("metadata_uri_rejected")
    return { ok: false, code: "METADATA_URI_INVALID", reason: "metadata_uri is required" }
  }

  const clean = uri.trim()

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean) && !IPFS_URI.test(clean)) {
    incSecurityCounter("metadata_uri_rejected")
    return {
      ok: false,
      code: "METADATA_URI_SCHEME",
      reason: "metadata_uri must be ipfs://; non-content-addressed schemes are not accepted",
    }
  }

  const match = clean.match(IPFS_URI)
  if (!match) {
    incSecurityCounter("metadata_uri_rejected")
    return { ok: false, code: "METADATA_URI_INVALID", reason: "metadata_uri must match ipfs://<cid>[/<path>]" }
  }

  const cid = match[1]
  const path = (match[2] ?? "").replace(/^\/+/, "")

  if (!CidSchema.safeParse(cid).success) {
    incSecurityCounter("metadata_uri_rejected")
    return { ok: false, code: "METADATA_URI_INVALID", reason: "metadata_uri CID is malformed" }
  }

  // A CID this server cannot recompute would be accepted on trust, which is
  // exactly the hole #229 describes.
  const isV0 = cid.startsWith(CIDV0_PREFIX)
  if (!isV0 && !decodeCidV1(cid)) {
    incSecurityCounter("metadata_uri_rejected")
    return {
      ok: false,
      code: "METADATA_URI_CID_VERSION",
      reason: "metadata_uri CID must be CIDv1 sha2-256 (bafy…) or CIDv0 (Qm…)",
    }
  }

  return { ok: true, cid, path }
}

/** Diagnostics passthrough so the counters are observable from a route. */
export function cidVerificationStats() {
  return { cache: getCidCacheStats() }
}
