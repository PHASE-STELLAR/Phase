/**
 * Sello visual PHASE en esquina (garantía de Forja) antes de subir a IPFS.
 * Solo cliente para composición canvas (createImageBitmap); derivación determinista
 * y verificación de digest disponibles en cliente y servidor (phase-259).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

const SEAL_LABEL = "PHASE"
const SEAL_SUB = "FORGE"
const MAX_CACHE_ENTRIES = 128

export type ForgeSealMetadata = Record<string, unknown>

export type ForgeSealCounterKey =
  | "seal_rendered"
  | "seal_cache_hit"
  | "seal_cache_miss"
  | "seal_tamper_rejected"
  | "seal_renderer_fallback"
  | "seal_flag_disabled"

const counters: Record<ForgeSealCounterKey, number> = {
  seal_rendered: 0,
  seal_cache_hit: 0,
  seal_cache_miss: 0,
  seal_tamper_rejected: 0,
  seal_renderer_fallback: 0,
  seal_flag_disabled: 0,
}

function incCounter(key: ForgeSealCounterKey): void {
  counters[key] += 1
}

export function getForgeSealCounters(): Readonly<Record<ForgeSealCounterKey, number>> {
  return { ...counters }
}

export function resetForgeSealCounters(): void {
  for (const k of Object.keys(counters) as ForgeSealCounterKey[]) {
    counters[k] = 0
  }
}

export function isDeterministicSealEnabled(): boolean {
  return isFeatureEnabled("phase-259")
}

// ── Pure-TS SHA-256 (deterministic across browser, Node, and test runtimes) ──

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

export function sha256Hex(data: Uint8Array): string {
  const bitLen = data.length * 8
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLen)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Uint32Array(64)
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, "0"))
    .join("")
}

// ── Canonicalization & Digest Derivation ──

function canonicalSort(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalSort)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key]
    if (v !== undefined) {
      sorted[key] = canonicalSort(v)
    }
  }
  return sorted
}

export function canonicalizeArtifactMetadata(metadata: ForgeSealMetadata): string {
  return JSON.stringify(canonicalSort(metadata))
}

export function canonicalArtifactBytes(
  artifactBytes: Uint8Array,
  metadata?: ForgeSealMetadata,
): Uint8Array {
  const encoder = new TextEncoder()
  const metaBytes = metadata ? encoder.encode(canonicalizeArtifactMetadata(metadata)) : new Uint8Array(0)
  const prefix = encoder.encode("PHASE_FORGE_SEAL_V1:")
  const sep = new Uint8Array([0x00])
  const out = new Uint8Array(prefix.length + artifactBytes.length + sep.length + metaBytes.length)
  out.set(prefix, 0)
  out.set(artifactBytes, prefix.length)
  out.set(sep, prefix.length + artifactBytes.length)
  out.set(metaBytes, prefix.length + artifactBytes.length + sep.length)
  return out
}

export function deriveSealDigest(
  artifactBytes: Uint8Array,
  metadata?: ForgeSealMetadata,
): string {
  return sha256Hex(canonicalArtifactBytes(artifactBytes, metadata))
}

// ── Deterministic Seal Renderer & Fallback ──

export const DEFAULT_SEAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="124" height="40" viewBox="0 0 124 40"><rect x="1" y="1" width="122" height="38" rx="8" fill="rgba(0,0,0,0.62)" stroke="rgba(34,211,238,0.85)" stroke-width="2"/><polygon points="14,12 22,20 14,28 6,20" fill="rgba(34,211,238,0.95)"/><text x="28" y="18" fill="rgba(220,252,255,0.95)" font-family="monospace" font-size="12" font-weight="bold">PHASE</text><text x="28" y="30" fill="rgba(34,211,238,0.75)" font-family="monospace" font-size="8">FORGE</text></svg>`

function digestByte(digest: string, index: number): number {
  const hex = digest.slice((index * 2) % 64, (index * 2) % 64 + 2)
  return Number.parseInt(hex || "00", 16)
}

export function renderDeterministicSealSvg(digest: string, width = 140, height = 44): string {
  const normalized = digest.toLowerCase()
  const hue = Math.round((digestByte(normalized, 0) / 255) * 360)
  const accent = `hsl(${hue}, 82%, 62%)`
  const shortTag = normalized.slice(0, 8).toUpperCase()

  const cells: string[] = []
  const cellSize = 4
  const ox = 8
  const oy = 10
  for (let row = 0; row < 4; row++) {
    const b = digestByte(normalized, row + 1)
    for (let col = 0; col < 4; col++) {
      if ((b >> col) & 1) {
        cells.push(
          `<rect x="${ox + col * cellSize}" y="${oy + row * cellSize}" width="${cellSize}" height="${cellSize}" fill="${accent}"/>`,
        )
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-seal-digest="${normalized}"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="rgba(0,0,0,0.78)" stroke="${accent}" stroke-width="2"/>${cells.join("")}<text x="30" y="18" fill="#ecfeff" font-family="monospace" font-size="11" font-weight="bold">PHASE FORGE</text><text x="30" y="32" fill="${accent}" font-family="monospace" font-size="9">${shortTag}</text></svg>`
}

export function renderDeterministicSealBytes(digest: string): Uint8Array {
  return new TextEncoder().encode(renderDeterministicSealSvg(digest))
}

// ── Digest-keyed Cache (never keyed by session) ──

type CachedSealEntry = {
  artifactDigest: string
  sealDigest: string
  bytes: Uint8Array
  blob?: Blob
}

const sealCache = new Map<string, CachedSealEntry>()

export function clearForgeSealCache(): void {
  sealCache.clear()
}

export function getForgeSealCacheSize(): number {
  return sealCache.size
}

function putCacheEntry(entry: CachedSealEntry): void {
  if (sealCache.size >= MAX_CACHE_ENTRIES && !sealCache.has(entry.artifactDigest)) {
    const oldest = sealCache.keys().next().value
    if (oldest !== undefined) sealCache.delete(oldest)
  }
  sealCache.set(entry.artifactDigest, entry)
}

export type SealVerificationResult = {
  valid: boolean
  actualSealDigest: string
  reason?: "SEAL_DIGEST_MISMATCH" | "INVALID_ARTIFACT_DIGEST"
}

export function verifyServedSeal(
  servedBytes: Uint8Array,
  expectedArtifactDigest: string,
  committedSealDigest: string,
): SealVerificationResult {
  const actualSealDigest = sha256Hex(servedBytes)
  if (!/^[0-9a-f]{64}$/i.test(expectedArtifactDigest)) {
    incCounter("seal_tamper_rejected")
    return { valid: false, actualSealDigest, reason: "INVALID_ARTIFACT_DIGEST" }
  }
  if (actualSealDigest.toLowerCase() !== committedSealDigest.toLowerCase()) {
    incCounter("seal_tamper_rejected")
    return { valid: false, actualSealDigest, reason: "SEAL_DIGEST_MISMATCH" }
  }
  return { valid: true, actualSealDigest }
}

export type RenderSealResult = {
  artifactDigest: string | null
  sealDigest: string
  bytes: Uint8Array
  fromCache: boolean
  fallback: boolean
}

export async function renderDeterministicSealWithFallback(
  artifactBytes: Uint8Array,
  metadata?: ForgeSealMetadata,
  options?: {
    renderer?: (digest: string) => Uint8Array | Promise<Uint8Array>
  },
): Promise<RenderSealResult> {
  if (!isDeterministicSealEnabled()) {
    incCounter("seal_flag_disabled")
    const bytes = new TextEncoder().encode(DEFAULT_SEAL_SVG)
    return {
      artifactDigest: null,
      sealDigest: sha256Hex(bytes),
      bytes,
      fromCache: false,
      fallback: true,
    }
  }

  const artifactDigest = deriveSealDigest(artifactBytes, metadata)
  const cached = sealCache.get(artifactDigest)
  if (cached) {
    const check = verifyServedSeal(cached.bytes, artifactDigest, cached.sealDigest)
    if (check.valid) {
      incCounter("seal_cache_hit")
      return {
        artifactDigest,
        sealDigest: cached.sealDigest,
        bytes: cached.bytes,
        fromCache: true,
        fallback: false,
      }
    }
    sealCache.delete(artifactDigest)
  }

  incCounter("seal_cache_miss")
  try {
    const renderer = options?.renderer ?? renderDeterministicSealBytes
    const rendered = await renderer(artifactDigest)
    if (!rendered || rendered.length === 0) {
      throw new Error("Empty seal output")
    }
    const sealDigest = sha256Hex(rendered)
    putCacheEntry({ artifactDigest, sealDigest, bytes: rendered })
    incCounter("seal_rendered")
    return {
      artifactDigest,
      sealDigest,
      bytes: rendered,
      fromCache: false,
      fallback: false,
    }
  } catch {
    incCounter("seal_renderer_fallback")
    const fallbackBytes = new TextEncoder().encode(DEFAULT_SEAL_SVG)
    return {
      artifactDigest,
      sealDigest: sha256Hex(fallbackBytes),
      bytes: fallbackBytes,
      fromCache: false,
      fallback: true,
    }
  }
}

// ── Canvas Seal Drawing ──

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  rw: number,
  rh: number,
  rad: number,
) {
  ctx.moveTo(px + rad, py)
  ctx.lineTo(px + rw - rad, py)
  ctx.quadraticCurveTo(px + rw, py, px + rw, py + rad)
  ctx.lineTo(px + rw, py + rh - rad)
  ctx.quadraticCurveTo(px + rw, py + rh, px + rw - rad, py + rh)
  ctx.lineTo(px + rad, py + rh)
  ctx.quadraticCurveTo(px, py + rh, px, py + rh - rad)
  ctx.lineTo(px, py + rad)
  ctx.quadraticCurveTo(px, py, px + rad, py)
}

function drawPhaseForgeSeal(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number) {
  const m = Math.max(6, Math.round(Math.min(canvasW, canvasH) * 0.018))
  const sealH = Math.max(28, Math.round(Math.min(canvasW, canvasH) * 0.072))
  const sealW = Math.round(sealH * 3.1)
  const x = canvasW - sealW - m
  const y = canvasH - sealH - m
  const r = Math.max(4, Math.round(sealH * 0.2))

  ctx.save()
  ctx.fillStyle = "rgba(0,0,0,0.62)"
  ctx.strokeStyle = "rgba(34,211,238,0.85)"
  ctx.lineWidth = Math.max(1, Math.round(sealH / 28))

  ctx.beginPath()
  drawRoundedRect(ctx, x, y, sealW, sealH, r)
  ctx.fill()
  ctx.stroke()

  // Marca geométrica mínima (diamante PHASE)
  const gx = x + sealH * 0.35
  const gy = y + sealH * 0.5
  const gs = sealH * 0.22
  ctx.fillStyle = "rgba(34,211,238,0.95)"
  ctx.beginPath()
  ctx.moveTo(gx, gy - gs)
  ctx.lineTo(gx + gs, gy)
  ctx.lineTo(gx, gy + gs)
  ctx.lineTo(gx - gs, gy)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = "rgba(220,252,255,0.95)"
  ctx.font = `bold ${Math.round(sealH * 0.38)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  ctx.fillText(SEAL_LABEL, x + sealH * 0.62, y + sealH * 0.42)

  ctx.fillStyle = "rgba(34,211,238,0.75)"
  ctx.font = `${Math.round(sealH * 0.24)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
  ctx.fillText(SEAL_SUB, x + sealH * 0.62, y + sealH * 0.72)

  ctx.restore()
}

export function drawDeterministicPhaseForgeSeal(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  digest: string,
) {
  const m = Math.max(6, Math.round(Math.min(canvasW, canvasH) * 0.018))
  const sealH = Math.max(28, Math.round(Math.min(canvasW, canvasH) * 0.072))
  const sealW = Math.round(sealH * 3.4)
  const x = canvasW - sealW - m
  const y = canvasH - sealH - m
  const r = Math.max(4, Math.round(sealH * 0.2))

  const hue = Math.round((digestByte(digest, 0) / 255) * 360)
  const accent = `hsl(${hue}, 82%, 62%)`

  ctx.save()
  ctx.fillStyle = "rgba(0,0,0,0.78)"
  ctx.strokeStyle = accent
  ctx.lineWidth = Math.max(1, Math.round(sealH / 28))

  ctx.beginPath()
  drawRoundedRect(ctx, x, y, sealW, sealH, r)
  ctx.fill()
  ctx.stroke()

  const cellSize = Math.max(2, Math.floor((sealH * 0.56) / 4))
  const gx = x + sealH * 0.18
  const gy = y + (sealH - cellSize * 4) / 2
  ctx.fillStyle = accent
  for (let row = 0; row < 4; row++) {
    const b = digestByte(digest, row + 1)
    for (let col = 0; col < 4; col++) {
      if ((b >> col) & 1) {
        ctx.fillRect(gx + col * cellSize, gy + row * cellSize, cellSize, cellSize)
      }
    }
  }

  const tx = gx + cellSize * 4 + sealH * 0.16
  ctx.fillStyle = "rgba(220,252,255,0.95)"
  ctx.font = `bold ${Math.round(sealH * 0.34)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  ctx.fillText(SEAL_LABEL, tx, y + sealH * 0.38)

  ctx.fillStyle = accent
  ctx.font = `${Math.round(sealH * 0.24)}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
  ctx.fillText(digest.slice(0, 8).toUpperCase(), tx, y + sealH * 0.72)

  ctx.restore()
}

export type ComposeSealOptions = {
  metadata?: ForgeSealMetadata
  committedDigest?: string
}

/**
 * Dibuja el sello de garantía y devuelve PNG. Si falla (formato, memoria), devuelve el blob original.
 * Con phase-259 activo, deriva el sello deterministamente de los bytes canónicos y cachea por digest.
 */
export async function composeImageWithPhaseForgeSeal(
  input: Blob | File,
  options?: ComposeSealOptions,
): Promise<Blob> {
  const passthrough = () => (input instanceof File ? input : input.slice(0, input.size, input.type))

  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    if (!isDeterministicSealEnabled()) {
      incCounter("seal_flag_disabled")
    } else {
      incCounter("seal_renderer_fallback")
    }
    return passthrough()
  }

  try {
    const deterministic = isDeterministicSealEnabled()
    let artifactDigest: string | null = null

    if (deterministic) {
      const inputBytes = new Uint8Array(await input.arrayBuffer())
      artifactDigest = deriveSealDigest(inputBytes, options?.metadata)
      if (options?.committedDigest && options.committedDigest.toLowerCase() !== artifactDigest.toLowerCase()) {
        incCounter("seal_tamper_rejected")
        throw new Error("Committed artifact digest mismatch")
      }
      const cached = sealCache.get(artifactDigest)
      if (cached?.blob) {
        const check = verifyServedSeal(cached.bytes, artifactDigest, cached.sealDigest)
        if (check.valid) {
          incCounter("seal_cache_hit")
          return cached.blob
        }
        sealCache.delete(artifactDigest)
      }
      incCounter("seal_cache_miss")
    } else {
      incCounter("seal_flag_disabled")
    }

    const bmp = await createImageBitmap(input)
    const w = bmp.width
    const h = bmp.height
    if (w < 8 || h < 8 || w > 8192 || h > 8192) {
      bmp.close()
      return passthrough()
    }

    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      bmp.close()
      if (deterministic) incCounter("seal_renderer_fallback")
      return passthrough()
    }

    ctx.drawImage(bmp, 0, 0)
    bmp.close()

    if (deterministic && artifactDigest) {
      drawDeterministicPhaseForgeSeal(ctx, w, h, artifactDigest)
    } else {
      drawPhaseForgeSeal(ctx, w, h)
    }

    const out = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png")
    })
    if (!out) {
      if (deterministic) incCounter("seal_renderer_fallback")
      return passthrough()
    }

    if (deterministic && artifactDigest) {
      const outBytes = new Uint8Array(await out.arrayBuffer())
      const sealDigest = sha256Hex(outBytes)
      putCacheEntry({ artifactDigest, sealDigest, bytes: outBytes, blob: out })
      incCounter("seal_rendered")
    }

    return out
  } catch (err) {
    if (err instanceof Error && err.message === "Committed artifact digest mismatch") {
      throw err
    }
    if (isDeterministicSealEnabled()) {
      incCounter("seal_renderer_fallback")
    }
    return passthrough()
  }
}
