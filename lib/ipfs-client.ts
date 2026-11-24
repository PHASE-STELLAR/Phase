/**
 * Unified Resilient IPFS Client — Issue #651
 *
 * Feature flags:
 *  - phase-117: multi-gateway pinning with redundancy & quorum verification
 *  - phase-119: content-addressed CID cache with tamper verification
 *  - phase-120: upload retry with exponential backoff and checksum integrity
 *  - phase-123: ordered gateway fallback chain with per-gateway timeout
 *
 * Combines gateway fallback, quorum pin verification, upload retry integrity,
 * and tamper-evident CID caching into a single coherent client.
 */

import { z } from "zod"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"
import {
  CidSchema,
  sha256Hex,
  verifyBytesIntegrity,
  getCachedCid,
  setCachedCid,
  invalidateCachedCid,
  isPhase119Enabled,
} from "@/lib/cid-cache"
import { verifyCID } from "@/lib/cid-verification"
import {
  DEFAULT_IPFS_GATEWAYS,
  resolveIpfsFallbackConfig,
  type IpfsFallbackConfig,
} from "@/lib/ipfs-fallback"
import {
  DEFAULT_MULTI_PIN_CONFIG,
  resolveMultiPinConfig,
  type MultiGatewayPinConfig,
  type PinResult,
  type MultiPinResult,
  isPhase117Enabled,
} from "@/lib/ipfs-pinning"
import {
  DEFAULT_RETRY_CONFIG,
  resolveRetryConfig,
  exponentialBackoffMs,
  sleep,
  computeSha256Hex,
  type IpfsUploadRetryConfig,
  type ChecksumRecord,
  IpfsUploadRetryError,
  isPhase120Enabled,
} from "@/lib/ipfs-upload-retry"

export function isIpfsClientFallbackEnabled(): boolean {
  return isFeatureEnabled("phase-123")
}

export type IpfsClientUploadOptions = {
  fileName?: string
  contentType?: string
  expectedChecksum?: string | null
  jwt?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  retryConfig?: Partial<IpfsUploadRetryConfig>
  pinConfig?: Partial<MultiGatewayPinConfig>
}

export type IpfsClientUploadResult = {
  ok: boolean
  uri: string
  cid: string
  checksum: ChecksumRecord
  attempts: number
  verified: boolean
  quorumAchieved?: number
  quorumRequired?: number
  error?: string | null
}

export type IpfsClientRetrieveOptions = {
  expectedSha256?: string | null
  expectedCid?: string | null
  contentType?: string
  ttlMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  fallbackConfig?: Partial<IpfsFallbackConfig>
  skipCache?: boolean
}

export type IpfsClientRetrieveResult =
  | {
      ok: true
      bytes: ArrayBuffer
      contentType: string
      fromCache: boolean
      sha256: string
      gateway: string
      attempts: number
    }
  | {
      ok: false
      error: string
      code: "CID_INVALID" | "HASH_MISMATCH" | "TAMPERED" | "FETCH_FAILED" | "ALL_GATEWAYS_FAILED"
      attempts: number
    }

export type IpfsClientPinOptions = {
  jwt?: string
  fileName?: string
  expectedChecksum?: string | null
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  config?: Partial<MultiGatewayPinConfig>
}

export type IpfsClientPinResult = MultiPinResult

export type IpfsClientVerifyResult = {
  ok: boolean
  code?: string
  reason?: string
  algorithm?: string
}

function normalizeToBuffer(
  content: Blob | File | Uint8Array | Buffer | ArrayBuffer,
): { buffer: Buffer; fileName: string; contentType: string } {
  let fileName = "phase-asset.bin"
  let contentType = "application/octet-stream"

  if (typeof File !== "undefined" && content instanceof File) {
    fileName = content.name || fileName
    contentType = content.type || contentType
  } else if (typeof Blob !== "undefined" && content instanceof Blob) {
    contentType = content.type || contentType
  }

  let buffer: Buffer
  if (Buffer.isBuffer(content)) {
    buffer = content
  } else if (content instanceof ArrayBuffer) {
    buffer = Buffer.from(content)
  } else if (content instanceof Uint8Array) {
    buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  } else {
    // Blob or File (requires async arrayBuffer call, handled by caller or pre-converted)
    throw new Error("Blob must be pre-converted to buffer for synchronous normalize")
  }

  return { buffer, fileName, contentType }
}

async function contentToBuffer(
  content: Blob | File | Uint8Array | Buffer | ArrayBuffer,
): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
  let fileName = "phase-asset.bin"
  let contentType = "application/octet-stream"

  if (typeof File !== "undefined" && content instanceof File) {
    fileName = content.name || fileName
    contentType = content.type || contentType
    const ab = await content.arrayBuffer()
    return { buffer: Buffer.from(ab), fileName, contentType }
  }

  if (typeof Blob !== "undefined" && content instanceof Blob) {
    contentType = content.type || contentType
    const ab = await content.arrayBuffer()
    return { buffer: Buffer.from(ab), fileName, contentType }
  }

  if (Buffer.isBuffer(content)) {
    return { buffer: content, fileName, contentType }
  }

  if (content instanceof ArrayBuffer) {
    return { buffer: Buffer.from(content), fileName, contentType }
  }

  if (content instanceof Uint8Array) {
    return {
      buffer: Buffer.from(content.buffer, content.byteOffset, content.byteLength),
      fileName,
      contentType,
    }
  }

  throw new Error("Unsupported content type for IPFS upload")
}

function resolvePinataJwt(explicit?: string): string {
  const jwt = explicit?.trim() || process.env.PINATA_JWT?.trim() || process.env.PINATA_API_JWT?.trim() || ""
  return jwt
}

/**
 * Unified resilient IPFS client implementation.
 */
export class IpfsClient {
  private static instance: IpfsClient | null = null

  public static getInstance(): IpfsClient {
    if (!IpfsClient.instance) {
      IpfsClient.instance = new IpfsClient()
    }
    return IpfsClient.instance
  }

  /**
   * Upload content with exponential backoff retries, content checksum verification,
   * and optional multi-gateway quorum confirmation.
   */
  public async upload(
    content: Blob | File | Uint8Array | Buffer | ArrayBuffer,
    opts: IpfsClientUploadOptions = {},
  ): Promise<IpfsClientUploadResult> {
    const { buffer, fileName: autoName, contentType } = await contentToBuffer(content)
    const fileName = opts.fileName ?? autoName
    const checksumHex = computeSha256Hex(buffer)

    if (opts.expectedChecksum && opts.expectedChecksum !== checksumHex) {
      incSecurityCounter("ipfs_upload_failed")
      return {
        ok: false,
        uri: "",
        cid: "",
        checksum: { algo: "sha256", hex: checksumHex, byteLength: buffer.length },
        attempts: 0,
        verified: false,
        error: `Checksum mismatch: expected ${opts.expectedChecksum.slice(0, 8)}... got ${checksumHex.slice(0, 8)}...`,
      }
    }

    const jwt = resolvePinataJwt(opts.jwt)
    const fetchFn = opts.fetchImpl ?? fetch
    const checksumRecord: ChecksumRecord = {
      algo: "sha256",
      hex: checksumHex,
      byteLength: buffer.length,
    }

    // Flag off: single-shot Pinata legacy upload without retry or quorum verification
    if (!isPhase120Enabled() && !isPhase117Enabled()) {
      if (!jwt) {
        incSecurityCounter("ipfs_upload_failed")
        return {
          ok: false,
          uri: "",
          cid: "",
          checksum: checksumRecord,
          attempts: 0,
          verified: false,
          error: "PINATA_JWT not configured",
        }
      }
      try {
        const form = new FormData()
        const blob = new Blob([buffer], { type: contentType })
        form.append("file", blob, fileName)
        const res = await fetchFn("https://api.pinata.cloud/pinning/pinFileToIPFS", {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}` },
          body: form,
          signal: opts.signal,
        })
        const text = await res.text()
        let parsed: { IpfsHash?: string; error?: unknown } = {}
        try {
          parsed = JSON.parse(text) as typeof parsed
        } catch {}
        if (!res.ok || !parsed.IpfsHash) {
          incSecurityCounter("ipfs_upload_failed")
          return {
            ok: false,
            uri: "",
            cid: "",
            checksum: checksumRecord,
            attempts: 1,
            verified: false,
            error: res.ok ? "Missing IpfsHash" : text.slice(0, 200) || `HTTP ${res.status}`,
          }
        }
        const cid = parsed.IpfsHash
        incSecurityCounter("ipfs_upload_success")
        return {
          ok: true,
          uri: `ipfs://${cid}`,
          cid,
          checksum: checksumRecord,
          attempts: 1,
          verified: true,
        }
      } catch (e) {
        incSecurityCounter("ipfs_upload_failed")
        return {
          ok: false,
          uri: "",
          cid: "",
          checksum: checksumRecord,
          attempts: 1,
          verified: false,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    }

    // When phase-120 is enabled: upload retry with exponential backoff + checksum check
    const retryConfig = resolveRetryConfig(opts.retryConfig)
    let lastError: string | null = null
    let successfulCid: string | null = null
    let totalAttempts = 0

    for (let attempt = 1; attempt <= retryConfig.maxRetries + 1; attempt++) {
      if (opts.signal?.aborted) {
        incSecurityCounter("ipfs_upload_failed")
        return {
          ok: false,
          uri: "",
          cid: "",
          checksum: checksumRecord,
          attempts: attempt - 1,
          verified: false,
          error: "Upload aborted",
        }
      }

      if (attempt > 1) {
        incSecurityCounter("ipfs_upload_retry")
        const delay = exponentialBackoffMs(
          attempt - 2,
          retryConfig.baseDelayMs,
          retryConfig.maxDelayMs,
          retryConfig.jitterRatio,
        )
        await sleep(delay, opts.signal).catch(() => {})
      }

      totalAttempts = attempt

      // Verify checksum consistency before each attempt to prevent bytes mutation
      const attemptChecksum = computeSha256Hex(buffer)
      if (attemptChecksum !== checksumHex) {
        incSecurityCounter("ipfs_upload_failed")
        return {
          ok: false,
          uri: "",
          cid: "",
          checksum: checksumRecord,
          attempts: attempt,
          verified: false,
          error: "Content bytes mutated between retries (checksum failure)",
        }
      }

      try {
        const form = new FormData()
        const blob = new Blob([buffer], { type: contentType })
        form.append("file", blob, fileName)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), retryConfig.timeoutMs)
        if (opts.signal) {
          if (opts.signal.aborted) controller.abort(opts.signal.reason)
          else opts.signal.addEventListener("abort", () => controller.abort(opts.signal.reason), { once: true })
        }

        let res: Response
        try {
          res = await fetchFn("https://api.pinata.cloud/pinning/pinFileToIPFS", {
            method: "POST",
            headers: { Authorization: `Bearer ${jwt}` },
            body: form,
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
        }

        const text = await res.text()
        let parsed: { IpfsHash?: string; error?: unknown } = {}
        try {
          parsed = JSON.parse(text) as typeof parsed
        } catch {}

        if (!res.ok) {
          lastError = `HTTP ${res.status}: ${text.slice(0, 160)}`
          continue
        }

        if (!parsed.IpfsHash || typeof parsed.IpfsHash !== "string") {
          lastError = "Missing IpfsHash in response"
          continue
        }

        successfulCid = parsed.IpfsHash
        break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
      }
    }

    if (!successfulCid) {
      incSecurityCounter("ipfs_upload_failed")
      return {
        ok: false,
        uri: "",
        cid: "",
        checksum: checksumRecord,
        attempts: totalAttempts,
        verified: false,
        error: lastError ?? "Upload retries exhausted",
      }
    }

    // If phase-117 is enabled: perform quorum verification across gateway set
    if (isPhase117Enabled()) {
      const pinBlob = new Blob([buffer], { type: contentType })
      const pinRes = await this.pin(pinBlob, {
        jwt,
        fileName,
        expectedChecksum: checksumHex,
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
        config: opts.pinConfig,
      })

      if (!pinRes.ok) {
        incSecurityCounter("ipfs_quorum_failed")
        return {
          ok: false,
          uri: `ipfs://${successfulCid}`,
          cid: successfulCid,
          checksum: checksumRecord,
          attempts: totalAttempts,
          verified: false,
          quorumAchieved: pinRes.achieved,
          quorumRequired: pinRes.quorum,
          error: `Pin quorum not met: achieved ${pinRes.achieved} of required ${pinRes.quorum}`,
        }
      }

      incSecurityCounter("ipfs_quorum_met")
      incSecurityCounter("ipfs_upload_success")
      return {
        ok: true,
        uri: `ipfs://${successfulCid}`,
        cid: successfulCid,
        checksum: checksumRecord,
        attempts: totalAttempts,
        verified: true,
        quorumAchieved: pinRes.achieved,
        quorumRequired: pinRes.quorum,
      }
    }

    incSecurityCounter("ipfs_upload_success")
    return {
      ok: true,
      uri: `ipfs://${successfulCid}`,
      cid: successfulCid,
      checksum: checksumRecord,
      attempts: totalAttempts,
      verified: true,
    }
  }

  /**
   * Retrieve content with tamper-evident CID cache verification and ordered gateway fallback.
   */
  public async retrieve(
    cidOrPath: string,
    opts: IpfsClientRetrieveOptions = {},
  ): Promise<IpfsClientRetrieveResult> {
    const cleanPath = cidOrPath.replace(/^\/+/, "").trim()
    const cid = cleanPath.split("/")[0] ?? ""

    if (!CidSchema.safeParse(cid).success) {
      incSecurityCounter("cid_poison_attempts")
      return {
        ok: false,
        error: `Invalid CID format: ${cid.slice(0, 24)}`,
        code: "CID_INVALID",
        attempts: 0,
      }
    }

    const expectedSha = opts.expectedSha256 ?? null
    const fetchFn = opts.fetchImpl ?? fetch

    // Step 1: Check tamper-evident CID cache (when phase-119 is enabled)
    if (isPhase119Enabled() && !opts.skipCache) {
      try {
        const cached = await getCachedCid(cid, {
          expectedSha256: expectedSha,
          verifyIntegrity: true,
        })
        if (cached) {
          // Re-verify cached content against expected CID before returning
          const cachedBuf = cached.bytes
          const verification = verifyCID(cid, cachedBuf)
          if (!verification.ok) {
            incSecurityCounter("ipfs_cache_tamper")
            incSecurityCounter("cid_mismatch")
            await invalidateCachedCid(cid)
            // Recover through gateway fallback path below!
          } else {
            incSecurityCounter("ipfs_cache_hit")
            incSecurityCounter("cid_verified")
            const ab = cachedBuf.buffer.slice(
              cachedBuf.byteOffset,
              cachedBuf.byteOffset + cachedBuf.byteLength,
            ) as ArrayBuffer
            return {
              ok: true,
              bytes: ab,
              contentType: cached.entry.contentType,
              fromCache: true,
              sha256: cached.entry.sha256,
              gateway: "cache",
              attempts: 0,
            }
          }
        } else {
          incSecurityCounter("ipfs_cache_miss")
        }
      } catch (e) {
        incSecurityCounter("ipfs_cache_tamper")
        incSecurityCounter("cid_poison_attempts")
        await invalidateCachedCid(cid).catch(() => {})
      }
    }

    // Step 2: Ordered gateway fallback retrieval
    const fallbackConfig = resolveIpfsFallbackConfig(opts.fallbackConfig)
    const gateways = fallbackConfig.gateways
    let attempts = 0
    let lastError = "All IPFS gateways failed"

    for (const base of gateways) {
      attempts++
      incSecurityCounter("ipfs_fallback_attempt")
      const url = `${base.replace(/\/+$/, "")}/${cleanPath}`
      const timeoutMs = fallbackConfig.timeoutMs

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs)
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason)
        else opts.signal.addEventListener("abort", () => controller.abort(opts.signal.reason), { once: true })
      }

      try {
        const res = await fetchFn(url, {
          headers: { Accept: "*/*" },
          cache: "no-store",
          signal: controller.signal,
        })
        clearTimeout(timer)

        if (!res.ok) {
          lastError = `Gateway ${base} returned HTTP ${res.status}`
          continue
        }

        const ab = await res.arrayBuffer()
        const buf = Buffer.from(ab)
        const computedSha = sha256Hex(buf)

        // Prevent fallback from silently returning different content
        if (expectedSha && computedSha !== expectedSha) {
          incSecurityCounter("cid_mismatch")
          lastError = `Gateway ${base} returned checksum mismatch`
          continue
        }

        // Verify content against expected CID
        const verification = verifyCID(cid, buf)
        if (!verification.ok) {
          incSecurityCounter("cid_poison_attempts")
          lastError = `Gateway ${base} returned bytes not matching CID: ${verification.reason}`
          continue
        }

        incSecurityCounter("cid_verified")
        incSecurityCounter("ipfs_fallback_success")

        // Store into tamper-evident cache if phase-119 is on
        const contentType = res.headers.get("content-type") ?? opts.contentType ?? "application/octet-stream"
        if (isPhase119Enabled()) {
          await setCachedCid(cid, buf, {
            contentType,
            ttlMs: opts.ttlMs,
            expectedSha256: computedSha,
          }).catch(() => {})
        }

        return {
          ok: true,
          bytes: ab,
          contentType,
          fromCache: false,
          sha256: computedSha,
          gateway: base,
          attempts,
        }
      } catch (e) {
        clearTimeout(timer)
        lastError = e instanceof Error ? e.message : String(e)
      }
    }

    incSecurityCounter("ipfs_fallback_exhausted")
    return {
      ok: false,
      error: lastError,
      code: "ALL_GATEWAYS_FAILED",
      attempts,
    }
  }

  /**
   * Quorum pin verification across configured gateways.
   */
  public async pin(
    contentOrCid: Blob | File | Buffer | Uint8Array | ArrayBuffer | string,
    opts: IpfsClientPinOptions = {},
  ): Promise<IpfsClientPinResult> {
    const config = resolveMultiPinConfig(opts.config)
    const jwt = resolvePinataJwt(opts.jwt)

    if (typeof contentOrCid === "string") {
      // Pin existing CID by verifying replicated availability
      const cid = contentOrCid.replace(/^ipfs:\/\//, "").trim()
      const pinResults: PinResult[] = []

      for (const gw of config.gateways) {
        const start = Date.now()
        const url = `${gw.gatewayUrl.replace(/\/+$/, "")}/${cid}`
        try {
          const res = await (opts.fetchImpl ?? fetch)(url, {
            headers: { Accept: "*/*" },
            cache: "no-store",
            signal: opts.signal,
          })
          const latencyMs = Date.now() - start
          if (!res.ok) {
            pinResults.push({
              ok: false,
              uri: null,
              cid: null,
              gateway: gw.name,
              latencyMs,
              error: `HTTP ${res.status}`,
              verified: false,
            })
            continue
          }
          const buf = await res.arrayBuffer()
          const verification = verifyCID(cid, Buffer.from(buf))
          if (!verification.ok) {
            pinResults.push({
              ok: false,
              uri: null,
              cid: null,
              gateway: gw.name,
              latencyMs,
              error: verification.reason,
              verified: false,
            })
            continue
          }
          pinResults.push({
            ok: true,
            uri: `ipfs://${cid}`,
            cid,
            gateway: gw.name,
            latencyMs,
            error: null,
            verified: true,
          })
        } catch (e) {
          pinResults.push({
            ok: false,
            uri: null,
            cid: null,
            gateway: gw.name,
            latencyMs: Date.now() - start,
            error: e instanceof Error ? e.message : String(e),
            verified: false,
          })
        }
      }

      const achieved = pinResults.filter((r) => r.ok && r.verified).length
      const ok = achieved >= config.quorum
      if (ok) incSecurityCounter("ipfs_quorum_met")
      else incSecurityCounter("ipfs_quorum_failed")

      return {
        ok,
        uri: ok ? `ipfs://${cid}` : null,
        cid: ok ? cid : null,
        quorum: config.quorum,
        achieved,
        attempts: pinResults.length,
        results: pinResults,
        checksum: null,
        verified: ok,
      }
    }

    // Pin file content
    const { buffer, fileName } = await contentToBuffer(contentOrCid)
    const blob = new Blob([buffer])
    const { pinWithRedundancy } = await import("@/lib/ipfs-pinning")
    const res = await pinWithRedundancy(blob, jwt, {
      config,
      signal: opts.signal,
      fileName: opts.fileName ?? fileName,
      expectedChecksum: opts.expectedChecksum,
      fetchImpl: opts.fetchImpl,
    })

    if (res.ok) incSecurityCounter("ipfs_quorum_met")
    else incSecurityCounter("ipfs_quorum_failed")

    return res
  }

  /**
   * Verify content bytes against an expected CID or digest.
   */
  public verify(
    cid: string,
    bytes: Uint8Array | Buffer | ArrayBuffer,
    expectedSha256?: string,
  ): IpfsClientVerifyResult {
    const buf = Buffer.isBuffer(bytes)
      ? bytes
      : bytes instanceof ArrayBuffer
        ? Buffer.from(bytes)
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    if (expectedSha256) {
      if (!verifyBytesIntegrity(buf, expectedSha256)) {
        incSecurityCounter("cid_mismatch")
        return { ok: false, code: "HASH_MISMATCH", reason: "Bytes SHA-256 does not match expected digest" }
      }
    }

    const verification = verifyCID(cid, buf)
    if (!verification.ok) {
      incSecurityCounter("cid_poison_attempts")
      return { ok: false, code: verification.code, reason: verification.reason }
    }

    incSecurityCounter("cid_verified")
    return { ok: true, algorithm: verification.algorithm }
  }
}

export const ipfsClient = IpfsClient.getInstance()
