/**
 * design-token theming system for the OG image renderers
 * (app/api/og/chamber + app/api/og/profile).
 *
 * Centralizes every hardcoded color / layout literal previously scattered
 * across the route files into typed, validated design tokens. Changing a
 * theme is now a single-point edit instead of hunting through route bodies.
 */
import { z } from "zod"

// ─── Raw color tokens ─────────────────────────────────────────────────────────

/** 3 or 6 digit hex color with optional leading "#". */
export const HexColorSchema = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "invalid hex color")

/** 0-255 RGB channel with alpha 0-1, used by sharp `create.background`. */
export const RgbaTokenSchema = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
  alpha: z.number().min(0).max(1),
})

export type HexColor = z.infer<typeof HexColorSchema>
export type RgbaToken = z.infer<typeof RgbaTokenSchema>

// ─── Semantic color tokens ────────────────────────────────────────────────────

/** All semantic color slots shared across the OG renderers. */
export const OgColorTokensSchema = z.object({
  badge: HexColorSchema, // token-badge text (e.g. "#c4b5fd")
  headline: HexColorSchema, // NFT / collection / display name (e.g. "#e2e8f0")
  primary: HexColorSchema, // brand violet (e.g. "#7c3aed")
  muted: HexColorSchema, // secondary text (e.g. "#52525b")
  faint: HexColorSchema, // footer handles (e.g. "#3f3f46")
})

export type OgColorTokens = z.infer<typeof OgColorTokensSchema>

// ─── Layout / geometry tokens ─────────────────────────────────────────────────

export const OgCanvasSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

export type OgCanvas = z.infer<typeof OgCanvasSchema>

export const OgDimensionTokensSchema = z.object({
  canvas: OgCanvasSchema,
  nameTop: z.number().int(),
  nameFontSize: z.number().positive(),
  badgeLeft: z.number().int(),
  badgeTop: z.number().int(),
  badgeFontSize: z.number().positive(),
  nftLeft: z.number().int(),
  nftTop: z.number().int(),
  nftWidth: z.number().int().positive(),
  nftHeight: z.number().int().positive(),
  maxNameChars: z.number().int().positive(),
})

export type OgDimensionTokens = z.infer<typeof OgDimensionTokensSchema>

// ─── Theme definitions ────────────────────────────────────────────────────────

export const OgThemeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  colors: OgColorTokensSchema,
  dimensions: OgDimensionTokensSchema,
  canvasBackground: RgbaTokenSchema,
  accentStrip: RgbaTokenSchema,
  accentStripWidth: z.number().int().positive(),
})

export type OgTheme = z.infer<typeof OgThemeSchema>

// ─── Concrete themes ──────────────────────────────────────────────────────────

export const OG_CANVAS_WIDTH = 1200
export const OG_CANVAS_HEIGHT = 630

/**
 * "monitor" theme — shared by chamber & profile. Values lifted verbatim from
 * the pre-existing route literals so pixel output is byte-identical.
 */
export const monitorTheme: OgTheme = {
  id: "monitor",
  name: "PHASE Monitor",
  colors: {
    badge: "#c4b5fd",
    headline: "#e2e8f0",
    primary: "#7c3aed",
    muted: "#52525b",
    faint: "#3f3f46",
  },
  dimensions: {
    canvas: { width: OG_CANVAS_WIDTH, height: OG_CANVAS_HEIGHT },
    nameTop: 473,
    nameFontSize: 16,
    badgeLeft: 340,
    badgeTop: 80,
    badgeFontSize: 13,
    nftLeft: 522,
    nftTop: 199,
    nftWidth: 150,
    nftHeight: 210,
    maxNameChars: 30,
  },
  canvasBackground: { r: 9, g: 9, b: 11, alpha: 1 },
  accentStrip: { r: 139, g: 92, b: 246, alpha: 1 },
  accentStripWidth: 6,
}

/**
 * Registry of all registered OG themes. Lookup / validation is centralized so
 * unknown theme ids fail loudly (type-safe) instead of silently using stale
 * literals.
 */
export const OG_THEMES: readonly OgTheme[] = Object.freeze([monitorTheme])

const OgThemeDirectorySchema = z.array(OgThemeSchema).min(1)

export function validateOgTheme(theme: unknown): OgTheme | null {
  const parsed = OgThemeSchema.safeParse(theme)
  return parsed.success ? parsed.data : null
}

export function validateOgThemeDirectory(themes: unknown): Omit<OgTheme, never>[] | null {
  const parsed = OgThemeDirectorySchema.safeParse(themes)
  return parsed.success ? parsed.data : null
}

// ─── Lookup & normalization helpers ───────────────────────────────────────────

const themeById = new Map<string, OgTheme>()
for (const t of OG_THEMES) themeById.set(t.id, validateOgTheme(t) as OgTheme)

/** Resolve a theme by id; falls back to the monitor theme for unknown ids. */
export function getOgTheme(id?: string | null): OgTheme {
  if (id && themeById.has(id)) {
    const theme = themeById.get(id)
    if (theme) return theme
  }
  return monitorTheme
}

/** Returns the full set of currently registered theme ids (for tests/observability). */
export function listOgThemes(): string[] {
  return OG_THEMES.map((t) => t.id)
}

// ─── Shared text-render helpers (isolated domain logic) ──────────────────────

/** Escape XML special chars for Pango markup. */
export function escapeMarkup(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }
  return s.replace(/[&<>"]/g, (ch) => map[ch] ?? ch)
}

/** Strip non-printable-ASCII; fallback when too short to be meaningful. */
export function sanitizeForSharp(name: string, fallback: string, minLength = 2): string {
  const clean = (name ?? "").replace(/[^\x20-\x7E]/g, "").trim()
  return clean.length >= minLength ? clean : fallback
}

/** Skip-ASCII variant with a smaller meaningful threshold (profile wallets). */
export function sanitizeAscii(s: string, fallback: string): string {
  return sanitizeForSharp(s, fallback, 1)
}

/** Truncate an address like GABC...WXYZ. */
export function truncate(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length < head + tail + 3) return addr
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`
}

/** Cap a display string to a max length, appending an ellipsis when truncated. */
export function capName(name: string, max: number, ellipsis = "…"): string {
  if (!name) return name
  return name.length > max ? name.slice(0, max) + ellipsis : name
}

// ─── Type-safe schema-driven query parsing ───────────────────────────────────

/**
 * Parse an optional pin/retries query object and return a discriminated result.
 * Centralizes schema validation so route bodies stay minimal and typed.
 */
export const OgPinQuerySchema = z.object({
  pin: z.enum(["0", "1", "true", "false"]).optional(),
  retries: z.coerce.number().int().min(0).max(6).optional(),
})

export type OgPinQuery = z.infer<typeof OgPinQuerySchema>

export interface PinIntent {
  shouldPin: boolean
  retries: number | undefined
  invalid: boolean
}

/** Interpret pin query values into a normalized intent object. */
export function resolvePinIntent(rawPin: string | null | undefined, rawRetries: string | null | undefined): PinIntent {
  const pinValue = rawPin ?? undefined
  const parsed = OgPinQuerySchema.safeParse({ pin: pinValue === "" ? undefined : pinValue, retries: rawRetries ?? undefined })
  if (!parsed.success) return { shouldPin: false, retries: undefined, invalid: true }
  const { pin, retries } = parsed.data
  return { shouldPin: pin === "1" || pin === "true", retries, invalid: false }
}
