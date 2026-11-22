/**
 * Integration: OG template preservation + feature flags wiring
 * Run: npx tsx tests/og-integration.test.ts
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

// phase-60: no hardcoded color literals should remain in the OG routes; all
// colors flow through the design-token registry.
const HARDCODED_COLOR = /#[0-9a-fA-F]{3,6}\b/

process.env.NEXT_PUBLIC_FEATURE_PHASE_120 = "1"
process.env.NEXT_PUBLIC_FEATURE_PHASE_119 = "1"
process.env.NEXT_PUBLIC_FEATURE_PHASE_117 = "1"
process.env.NEXT_PUBLIC_FEATURE_PHASE_116 = "1"

async function testOgTemplateExists() {
  const p = path.join(process.cwd(), "public", "og-template.png")
  assert.equal(fs.existsSync(p), true, "og-template.png should exist (preserved wiring)")
  const stat = fs.statSync(p)
  assert.ok(stat.size > 1000, "og-template.png not empty")
  // og-monitor should also still exist (fallback)
  const mon = path.join(process.cwd(), "public", "og-monitor.png")
  assert.equal(fs.existsSync(mon), true)
  console.log("✓ og-template.png preserved, monitor fallback exists")
}

async function testFeatureFlagsRegistered() {
  const { isFeatureEnabled, getEnabledFeatureFlags, featureFlagEnvKeys } = await import("@/lib/feature-flags")
  for (const flag of ["phase-116","phase-117","phase-119","phase-120"] as const) {
    assert.equal(isFeatureEnabled(flag), true, `${flag} should be enabled`)
    assert.ok(featureFlagEnvKeys(flag).length > 0)
  }
  const enabled = getEnabledFeatureFlags()
  assert.ok(enabled.includes("phase-120"))
  console.log("✓ feature flags 116/117/119/120 registered & enabled")
}

async function testOgProfilePinHelper() {
  const content = fs.readFileSync(path.join(process.cwd(), "app/api/og/profile/route.tsx"), "utf8")
  assert.ok(content.includes("pinOgProfilePngWithRetry"), "og/profile should export pin helper")
  assert.ok(content.includes("og-template.png"), "should preserve og-template wiring")
  assert.ok(content.includes("phase-120"), "should contain phase-120 flag")
  console.log("✓ og/profile pin helper & template wiring exists")
}

async function testOgChamberHelper() {
  const content = fs.readFileSync(path.join(process.cwd(), "app/api/og/chamber/route.tsx"), "utf8")
  assert.ok(content.includes("pinOgChamberPngWithRetry"))
  assert.ok(content.includes("og-template.png"))
  console.log("✓ og/chamber pin helper & template wiring exists")
}

async function testRouteImportsDoNotThrow() {
  // Check route files contain expected exports via string, without needing next/server runtime
  const trust = fs.readFileSync(path.join(process.cwd(), "app/api/classic-liq/trustline/route.ts"), "utf8")
  assert.ok(trust.includes("export async function POST"))
  assert.ok(trust.includes("export async function GET"))
  assert.ok(trust.includes("phase-119"))
  const avatar = fs.readFileSync(path.join(process.cwd(), "app/api/profile/avatar/route.ts"), "utf8")
  assert.ok(avatar.includes("export async function GET"))
  assert.ok(avatar.includes("export async function POST"))
  assert.ok(avatar.includes("phase-117"))
  const replies = fs.readFileSync(path.join(process.cwd(), "app/api/signals/[id]/replies/route.ts"), "utf8")
  assert.ok(replies.includes("export async function POST"))
  assert.ok(replies.includes("export async function GET"))
  assert.ok(replies.includes("phase-116"))
  console.log("✓ all modified routes contain expected exports & flags")
}

async function testDesignTokenWiring() {
  // 1. both routes must source colors from the token registry (no hardcoded hex)
  for (const route of ["app/api/og/chamber/route.tsx", "app/api/og/profile/route.tsx"]) {
    const content = fs.readFileSync(path.join(process.cwd(), route), "utf8")
    assert.equal(HARDCODED_COLOR.test(content), false, `${route} must not contain hardcoded hex colors (phase-60)`)
    assert.ok(content.includes("@/lib/og-design-tokens"), `${route} should import the design-token registry`)
    assert.ok(content.includes("withOgErrorBoundary"), `${route} should use the error boundary`)
  }
  console.log("✓ OG routes source colors from design tokens + use error boundary")
}

async function testDesignTokenModule() {
  const { getOgTheme, monitorTheme, OG_CANVAS_WIDTH, OG_CANVAS_HEIGHT } = await import("@/lib/og-design-tokens")
  assert.equal(getOgTheme("monitor").id, "monitor")
  assert.equal(monitorTheme.dimensions.canvas.width, OG_CANVAS_WIDTH)
  assert.equal(monitorTheme.dimensions.canvas.height, OG_CANVAS_HEIGHT)
  console.log("✓ design-token registry loads & resolves monitor theme")
}

async function testPhase260DeterministicTokensAndFallback() {
  const { monitorTheme, computeOgThemeDigest } = await import("@/lib/og-design-tokens")
  const {
    clearOgImageCache,
    computeOgInputDigest,
    isOgDesignTokensEnabled,
    renderOgWithTimeoutAndCache,
    renderStaticFallbackTemplate,
  } = await import("@/lib/og-render-utils")

  // 1. Flag off = static template image
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_260
  delete process.env.FEATURE_PHASE_260
  assert.equal(isOgDesignTokensEnabled(), false)
  clearOgImageCache()

  const staticBuf = await renderStaticFallbackTemplate(monitorTheme)
  const flagOffRes = await renderOgWithTimeoutAndCache({
    surface: "chamber",
    theme: monitorTheme,
    params: { kind: "token", tokenId: 42 },
    render: async () => Buffer.from("should-not-run"),
  })
  assert.equal(flagOffRes.fallbackReason, "flag_disabled")
  assert.equal(Buffer.compare(flagOffRes.buffer, staticBuf), 0)

  // 2. Flag on: identical inputs yield identical images & digest cache hit
  process.env.NEXT_PUBLIC_FEATURE_PHASE_260 = "1"
  assert.equal(isOgDesignTokensEnabled(), true)
  clearOgImageCache()

  let renderCount = 0
  const first = await renderOgWithTimeoutAndCache({
    surface: "profile",
    theme: monitorTheme,
    params: { wallet: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" },
    render: async () => {
      renderCount += 1
      return staticBuf
    },
  })
  const second = await renderOgWithTimeoutAndCache({
    surface: "profile",
    theme: monitorTheme,
    params: { wallet: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" },
    render: async () => {
      renderCount += 1
      return Buffer.from("different")
    },
  })
  assert.equal(renderCount, 1)
  assert.equal(first.cacheHit, false)
  assert.equal(second.cacheHit, true)
  assert.equal(first.digest, second.digest)
  assert.equal(Buffer.compare(first.buffer, second.buffer), 0)

  // 3. Token changes affect all surfaces
  const modifiedTheme = {
    ...monitorTheme,
    colors: { ...monitorTheme.colors, primary: "#00ff88" },
  }
  assert.notEqual(computeOgThemeDigest(monitorTheme), computeOgThemeDigest(modifiedTheme))
  assert.notEqual(
    computeOgInputDigest({ surface: "chamber", theme: monitorTheme, params: { tokenId: 1 } }),
    computeOgInputDigest({ surface: "chamber", theme: modifiedTheme, params: { tokenId: 1 } }),
  )
  assert.notEqual(
    computeOgInputDigest({ surface: "profile", theme: monitorTheme, params: { wallet: "GAAA" } }),
    computeOgInputDigest({ surface: "profile", theme: modifiedTheme, params: { wallet: "GAAA" } }),
  )

  // 4. Generation timeout falls back to static template
  clearOgImageCache()
  const timedOut = await renderOgWithTimeoutAndCache({
    surface: "chamber",
    theme: monitorTheme,
    params: { kind: "token", tokenId: 999 },
    timeoutMs: 10,
    render: () => new Promise<Buffer>((resolve) => setTimeout(() => resolve(Buffer.from("late")), 200)),
  })
  assert.equal(timedOut.fallbackReason, "timeout")
  assert.equal(Buffer.compare(timedOut.buffer, staticBuf), 0)
  console.log("✓ phase-260 deterministic tokens, digest cache, timeout & flag-off fallback verified")
}

async function main() {
  console.log("=== integration tests ===")
  await testOgTemplateExists()
  await testFeatureFlagsRegistered()
  await testOgProfilePinHelper()
  await testOgChamberHelper()
  await testRouteImportsDoNotThrow()
  await testDesignTokenWiring()
  await testDesignTokenModule()
  await testPhase260DeterministicTokensAndFallback()
  console.log("=== integration all passed ===")
}

main().catch((e) => {
  console.error("integration test failed:", e)
  process.exit(1)
})
