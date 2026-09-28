/**
 * phase-60: design-token theming system — unit tests
 * Run: node --test --import tsx lib/__tests__/og-design-tokens.test.ts
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  HexColorSchema,
  RgbaTokenSchema,
  OgColorTokensSchema,
  OgThemeSchema,
  monitorTheme,
  OG_THEMES,
  OG_CANVAS_WIDTH,
  OG_CANVAS_HEIGHT,
  getOgTheme,
  listOgThemes,
  validateOgTheme,
  validateOgThemeDirectory,
  escapeMarkup,
  sanitizeForSharp,
  sanitizeAscii,
  truncate,
  capName,
  resolvePinIntent,
} from "@/lib/og-design-tokens"

describe("hex color tokens", () => {
  it("accepts 3 and 6 digit hex with or without #", () => {
    assert.equal(HexColorSchema.safeParse("#c4b5fd").success, true)
    assert.equal(HexColorSchema.safeParse("c4b5fd").success, true)
    assert.equal(HexColorSchema.safeParse("#abc").success, true)
  })

  it("rejects invalid hex", () => {
    assert.equal(HexColorSchema.safeParse("red").success, false)
    assert.equal(HexColorSchema.safeParse("#12345").success, false)
    assert.equal(HexColorSchema.safeParse("#gggggg").success, false)
    assert.equal(HexColorSchema.safeParse(123).success, false)
  })
})

describe("rgba tokens", () => {
  it("accepts in-range values", () => {
    assert.equal(RgbaTokenSchema.safeParse({ r: 9, g: 9, b: 11, alpha: 1 }).success, true)
  })

  it("rejects out-of-range channels", () => {
    assert.equal(RgbaTokenSchema.safeParse({ r: 256, g: 0, b: 0, alpha: 1 }).success, false)
    assert.equal(RgbaTokenSchema.safeParse({ r: 0, g: 0, b: 0, alpha: 1.5 }).success, false)
  })
})

describe("color schema", () => {
  it("validates a complete color token map", () => {
    const ok = OgColorTokensSchema.safeParse(monitorTheme.colors)
    assert.equal(ok.success, true)
  })

  it("rejects a missing slot", () => {
    const { badge, headline, primary, muted } = monitorTheme.colors
    const parsed = OgColorTokensSchema.safeParse({ badge, headline, primary, muted })
    assert.equal(parsed.success, false)
  })
})

describe("theme schema + directory", () => {
  it("validates the monitor theme", () => {
    const parsed = OgThemeSchema.safeParse(monitorTheme)
    assert.equal(parsed.success, true)
  })

  it("validates the theme directory", () => {
    const parsed = validateOgThemeDirectory(OG_THEMES)
    assert.ok(Array.isArray(parsed))
    assert.equal(parsed!.length, OG_THEMES.length)
  })

  it("validateOgTheme returns the theme for a valid input", () => {
    const theme = validateOgTheme(monitorTheme)
    assert.ok(theme !== null)
    assert.equal(theme!.id, "monitor")
  })

  it("validateOgTheme returns null for invalid input", () => {
    assert.equal(validateOgTheme({ id: "x" }), null)
    assert.equal(validateOgTheme(null), null)
    assert.equal(validateOgTheme(undefined), null)
  })

  it("theme directory must not be empty", () => {
    assert.equal(validateOgThemeDirectory([]), null)
  })
})

describe("theme registry", () => {
  it("monitor theme matches the published 1200x630 canvas", () => {
    assert.equal(OG_CANVAS_WIDTH, 1200)
    assert.equal(OG_CANVAS_HEIGHT, 630)
    assert.equal(monitorTheme.dimensions.canvas.width, OG_CANVAS_WIDTH)
    assert.equal(monitorTheme.dimensions.canvas.height, OG_CANVAS_HEIGHT)
  })

  it("looks up the monitor theme by id", () => {
    assert.equal(getOgTheme("monitor").id, "monitor")
    assert.equal(getOgTheme().id, "monitor")
    assert.equal(getOgTheme("unknown").id, "monitor")
    assert.equal(getOgTheme(null).id, "monitor")
  })

  it("lists registered themes", () => {
    assert.deepEqual(listOgThemes(), ["monitor"])
  })

  it("monitor theme carries the previously hardcoded color values", () => {
    assert.equal(monitorTheme.colors.badge, "#c4b5fd")
    assert.equal(monitorTheme.colors.headline, "#e2e8f0")
    assert.equal(monitorTheme.colors.primary, "#7c3aed")
    assert.equal(monitorTheme.colors.muted, "#52525b")
    assert.equal(monitorTheme.colors.faint, "#3f3f46")
  })

  it("monitor theme carries the previously hardcoded geometry", () => {
    assert.equal(monitorTheme.dimensions.nameTop, 473)
    assert.equal(monitorTheme.dimensions.badgeLeft, 340)
    assert.equal(monitorTheme.dimensions.badgeTop, 80)
    assert.equal(monitorTheme.dimensions.nftLeft, 522)
    assert.equal(monitorTheme.dimensions.nftTop, 199)
    assert.equal(monitorTheme.dimensions.nftWidth, 150)
    assert.equal(monitorTheme.dimensions.nftHeight, 210)
    assert.equal(monitorTheme.dimensions.maxNameChars, 30)
  })
})

describe("escapeMarkup", () => {
  it("escapes XML special chars", () => {
    assert.equal(escapeMarkup('A&B<C>D"E'), "A&amp;B&lt;C&gt;D&quot;E")
  })

  it("leaves plain text untouched", () => {
    assert.equal(escapeMarkup("PHASE-ARTIFACT 123"), "PHASE-ARTIFACT 123")
  })

  it("handles empty input", () => {
    assert.equal(escapeMarkup(""), "")
  })
})

describe("sanitizeForSharp / sanitizeAscii", () => {
  it("strips non-printable ASCII", () => {
    assert.equal(sanitizeForSharp("日本語 ARTIFACT", "FALLBACK"), "ARTIFACT")
  })

  it("falls back when stripped content is too short", () => {
    assert.equal(sanitizeForSharp("あ", "FALLBACK"), "FALLBACK")
  })

  it("respects a custom min length", () => {
    assert.equal(sanitizeForSharp("a", "FALLBACK", 1), "a")
  })

  it("sanitizeAscii uses a smaller meaningful threshold", () => {
    assert.equal(sanitizeAscii("あ", "FALLBACK"), "FALLBACK")
  })
})

describe("truncate", () => {
  it("shortens a long address", () => {
    assert.equal(truncate("GABCDEFGHIJKLMNOP"), "GABCDE...MNOP")
  })

  it("returns short addresses unchanged", () => {
    assert.equal(truncate("GA"), "GA")
  })

  it("handles empty/undefined", () => {
    assert.equal(truncate(""), "")
    assert.equal(truncate(undefined as unknown as string), undefined)
  })
})

describe("capName", () => {
  it("caps and appends ellipsis", () => {
    assert.equal(capName("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef", 10), "ABCDEFGHIJ…")
  })

  it("keeps short names intact", () => {
    assert.equal(capName("Short", 10), "Short")
  })
})

describe("resolvePinIntent", () => {
  it("detects pin=1 / pin=true", () => {
    assert.equal(resolvePinIntent("1", null).shouldPin, true)
    assert.equal(resolvePinIntent("true", null).shouldPin, true)
  })

  it("treats pin=0 / missing as no-pin", () => {
    assert.equal(resolvePinIntent("0", null).shouldPin, false)
    assert.equal(resolvePinIntent(null, null).shouldPin, false)
    assert.equal(resolvePinIntent(undefined, undefined).shouldPin, false)
  })

  it("passes through retries", () => {
    assert.equal(resolvePinIntent("1", "3").retries, 3)
    assert.equal(resolvePinIntent("1", null).retries, undefined)
  })

  it("flags invalid values as not pinning", () => {
    assert.equal(resolvePinIntent("banana", null).invalid, true)
    assert.equal(resolvePinIntent("banana", null).shouldPin, false)
  })
})
