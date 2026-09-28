/**
 * phase-60: shared OG render utilities — unit tests
 * Run: node --test --import tsx lib/__tests__/og-render-utils.test.ts
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { monitorTheme } from "@/lib/og-design-tokens"
import {
  resolveOgTemplatePath,
  templateName,
  safeDisplayName,
  withOgErrorBoundary,
} from "@/lib/og-render-utils"

describe("template resolution", () => {
  it("returns a template file path", () => {
    const p = resolveOgTemplatePath()
    assert.ok(p.endsWith(".png"))
  })

  it("classifies a template by name", () => {
    assert.equal(templateName("/tmp/og-template.png"), "og-template.png")
    assert.equal(templateName("/tmp/og-monitor.png"), "og-monitor.png")
    assert.equal(templateName("/tmp/whatever.png"), "og-monitor.png")
  })
})

describe("safeDisplayName", () => {
  it("caps at theme max chars with ellipsis", () => {
    const long = "A".repeat(50)
    const out = safeDisplayName(long, "FALLBACK", monitorTheme)
    assert.ok(out.length <= monitorTheme.dimensions.maxNameChars + 1)
    assert.ok(out.endsWith("…"))
  })

  it("sanitizes non-ASCII and uppercases by default", () => {
    const out = safeDisplayName("日本語 ARTIFACT", "FALLBACK", monitorTheme)
    assert.equal(out, "ARTIFACT")
  })

  it("preserves case when uppercase=false", () => {
    const out = safeDisplayName("Artifact", "FB", monitorTheme, false)
    assert.equal(out, "Artifact")
  })

  it("falls back for unusable input", () => {
    const out = safeDisplayName("あ", "PHASE ARTIFACT #7", monitorTheme)
    assert.equal(out, "PHASE ARTIFACT #7")
  })
})

describe("withOgErrorBoundary", () => {
  it("returns the value when fn succeeds", async () => {
    const out = await withOgErrorBoundary(async () => 42)
    assert.equal(out.ok, true)
    if (out.ok) assert.equal(out.value, 42)
  })

  it("captures errors when fn throws", async () => {
    const boom = new Error("boom")
    const out = await withOgErrorBoundary(async () => {
      throw boom
    })
    assert.equal(out.ok, false)
    if (!out.ok) assert.equal(out.error, boom)
  })

  it("invokes the onError callback", async () => {
    let called: unknown = null
    const out = await withOgErrorBoundary(
      async () => {
        throw new Error("x")
      },
      (err) => {
        called = err
      },
    )
    assert.equal(out.ok, false)
    assert.ok(called instanceof Error)
  })
})
