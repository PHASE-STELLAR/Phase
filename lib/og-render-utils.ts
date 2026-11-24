/**
 * Shared OG image rendering utilities for app/api/og/* route handlers.
 *
 * Extracts the duplicated image-composition + error-handling logic shared by
 * the chamber and profile renderers into a single typed, well-tested module.
 * All pixel-affecting constants come from the design-token registry
 * (lib/og-design-tokens) — routes should never hardcode a color/geometry.
 */
import path from "node:path"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import sharp from "sharp"
import { isFeatureEnabled } from "@/lib/feature-flags"
import {
  computeOgThemeDigest,
  escapeMarkup,
  getOgTheme,
  sanitizeForSharp,
  type OgTheme,
} from "@/lib/og-design-tokens"

export const NOTO_SANS_TTF = path.join(process.cwd(), "public", "fonts", "NotoSans-Regular.ttf")

// ─── Template resolution (preserves public/og-template.png wiring) ───────────

export interface OgTemplateResolution {
  path: string
  name: "og-template.png" | "og-monitor.png"
}

/** Prefer og-template.png, fall back to og-monitor.png (legacy, no regression). */
export function resolveOgTemplatePath(): string {
  const template = path.join(process.cwd(), "public", "og-template.png")
  if (existsSync(template)) return template
  return path.join(process.cwd(), "public", "og-monitor.png")
}

export function templateName(filePath: string): OgTemplateResolution["name"] {
  return filePath.endsWith("og-template.png") ? "og-template.png" : "og-monitor.png"
}

// ─── Remote image fetching ────────────────────────────────────────────────────

// Collection/NFT image URIs are creator-supplied and proxied through arbitrary
// IPFS gateways; without a hard cap, a single oversized source image buffered
// whole (plus sharp's decode buffer) is enough to blow past the Vercel lambda
// memory ceiling on this route. Streamed so an unbounded body with no/false
// Content-Length still gets cut off instead of buffered in full.
export const DEFAULT_MAX_OG_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024

export async function fetchImageBuffer(
  url: string,
  timeoutMs = 7000,
  maxBytes = DEFAULT_MAX_OG_SOURCE_IMAGE_BYTES,
): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const contentLength = res.headers.get("content-length")
    if (contentLength && Number(contentLength) > maxBytes) return null
    if (!res.body) {
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.byteLength > maxBytes ? null : buf
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } catch {
    return null
  }
}

// ─── Text overlays (sharp Pango renderer, bundled NotoSans TTF) ───────────────

export interface TextLayerOptions {
  left: number
  top: number
  width: number
  fontSize: number
  color: string
  align?: "left" | "center" | "right"
  height?: number
  letterSpacing?: number
}

/**
 * Render text as a PNG overlay using sharp's native Pango text input. Font is
 * the bundled NotoSans TTF so it works on Vercel (Amazon Linux 2) without any
 * system font. Center/right alignment measures natural width then offsets.
 */
export async function textLayer(
  text: string,
  opts: TextLayerOptions,
  fontfile = NOTO_SANS_TTF,
): Promise<sharp.OverlayOptions | null> {
  try {
    const align = opts.align ?? "left"
    const pango = `<span foreground="${opts.color}">${escapeMarkup(text)}</span>`
    const textBuf = await sharp({
      text: {
        text: pango,
        fontfile,
        font: `Noto Sans ${opts.fontSize}`,
        rgba: true,
        dpi: 72,
      },
    })
      .png()
      .toBuffer()

    let finalLeft = opts.left
    if (align === "center" || align === "right") {
      const { width: textW = 0 } = await sharp(textBuf).metadata()
      if (align === "center") finalLeft = Math.max(0, Math.round((opts.width - textW) / 2))
      else finalLeft = Math.max(0, opts.left + opts.width - textW)
    }

    return { input: textBuf, left: finalLeft, top: opts.top }
  } catch {
    return null
  }
}

/**
 * Build a display name safe for Pango:
 *   - cap at theme max chars (with ellipsis)
 *   - strip non-printable ASCII with a themed fallback
 */
export function safeDisplayName(
  raw: string,
  fallback: string,
  theme: OgTheme,
  uppercase = true,
): string {
  const clean = sanitizeForSharp(raw, fallback)
  const max = theme.dimensions.maxNameChars
  const capped = clean.length > max ? clean.slice(0, max) + "…" : clean
  return uppercase ? capped.toUpperCase() : capped
}

// ─── Error boundary ───────────────────────────────────────────────────────────

export type OgRenderOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

/**
 * Generic error boundary for OG renderers. Converts any thrown error during
 * image assembly into a typed result so route handlers never leak unhandled
 * exceptions to production logs.
 */
export async function withOgErrorBoundary<T>(
  fn: () => Promise<T>,
  onError?: (err: unknown) => void,
): Promise<OgRenderOutcome<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    if (onError) onError(err)
    return { ok: false, error: err }
  }
}

// ─── Canvas builders ──────────────────────────────────────────────────────────

/** Create a solid-color RGBA PNG buffer (used for canvases and accent strips). */
export async function solidPng(
  width: number,
  height: number,
  background: { r: number; g: number; b: number; alpha: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer()
}

// ─── phase-260: deterministic digest cache, bounded timeout & static fallback ──

export const OG_RENDER_TIMEOUT_MS = 4500
const MAX_OG_CACHE_ENTRIES = 128
const ogImageCache = new Map<string, Buffer>()

export function isOgDesignTokensEnabled(): boolean {
  return isFeatureEnabled("phase-260")
}

export function ogDesignTokensRollbackNote(): string {
  return "Rollback phase-260: unset NEXT_PUBLIC_FEATURE_PHASE_260 / FEATURE_PHASE_260. Static OG template served."
}

function canonicalizeOgValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeOgValue)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = canonicalizeOgValue(v)
    }
    return out
  }
  return value
}

export type OgSurfaceName = "chamber" | "profile"

/**
 * Compute a deterministic SHA-256 digest from surface, theme tokens, and
 * canonicalized input parameters. Identical inputs + tokens yield identical digests.
 */
export function computeOgInputDigest(input: {
  surface: OgSurfaceName
  theme: OgTheme
  params: Record<string, unknown>
}): string {
  const payload = JSON.stringify(
    canonicalizeOgValue({
      surface: input.surface,
      themeDigest: computeOgThemeDigest(input.theme),
      params: input.params,
    }),
  )
  return createHash("sha256").update(payload).digest("hex")
}

export function getCachedOgImage(digest: string): Buffer | null {
  return ogImageCache.get(digest) ?? null
}

export function setCachedOgImage(digest: string, buffer: Buffer): void {
  if (ogImageCache.size >= MAX_OG_CACHE_ENTRIES) {
    const oldestKey = ogImageCache.keys().next().value
    if (oldestKey !== undefined) ogImageCache.delete(oldestKey)
  }
  ogImageCache.set(digest, buffer)
}

export function clearOgImageCache(): void {
  ogImageCache.clear()
}

export function getOgCacheStats(): { size: number; maxEntries: number } {
  return { size: ogImageCache.size, maxEntries: MAX_OG_CACHE_ENTRIES }
}

/**
 * Render the static fallback template image sized to the active theme canvas.
 * Used when `phase-260` is disabled or when dynamic generation times out/fails.
 */
export async function renderStaticFallbackTemplate(
  theme: OgTheme = getOgTheme("monitor"),
): Promise<Buffer> {
  const { width, height } = theme.dimensions.canvas
  try {
    const templatePath = resolveOgTemplatePath()
    if (existsSync(templatePath)) {
      const raw = await readFile(templatePath)
      return await sharp(raw)
        .resize(width, height, { fit: "cover", position: "centre" })
        .png()
        .toBuffer()
    }
  } catch {
    // Fall through to deterministic solid canvas if template file is unreadable
  }
  return solidPng(width, height, theme.canvasBackground)
}

export type OgRenderedResult = {
  buffer: Buffer
  digest: string
  cacheHit: boolean
  fallbackReason?: "flag_disabled" | "timeout" | "error"
}

/**
 * Execute an OG render with:
 * - `phase-260` flag check (flag off -> static template fallback)
 * - canonical input digest + bounded in-memory cache
 * - bounded generation timeout (timeout -> static template fallback)
 */
export async function renderOgWithTimeoutAndCache(opts: {
  surface: OgSurfaceName
  theme: OgTheme
  params: Record<string, unknown>
  timeoutMs?: number
  force?: boolean
  render: () => Promise<Buffer>
}): Promise<OgRenderedResult> {
  const digest = computeOgInputDigest({
    surface: opts.surface,
    theme: opts.theme,
    params: opts.params,
  })

  if (!opts.force && !isOgDesignTokensEnabled()) {
    const buffer = await renderStaticFallbackTemplate(opts.theme)
    return { buffer, digest, cacheHit: false, fallbackReason: "flag_disabled" }
  }

  const cached = getCachedOgImage(digest)
  if (cached) {
    return { buffer: cached, digest, cacheHit: true }
  }

  const timeoutMs = Math.max(1, opts.timeoutMs ?? OG_RENDER_TIMEOUT_MS)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const rendered = await Promise.race([
      opts.render(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OG_RENDER_TIMEOUT")), timeoutMs)
      }),
    ])
    setCachedOgImage(digest, rendered)
    return { buffer: rendered, digest, cacheHit: false }
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "OG_RENDER_TIMEOUT"
    const buffer = await renderStaticFallbackTemplate(opts.theme)
    return {
      buffer,
      digest,
      cacheHit: false,
      fallbackReason: isTimeout ? "timeout" : "error",
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
