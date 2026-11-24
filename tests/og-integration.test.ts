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

async function main() {
  console.log("=== integration tests ===")
  await testOgTemplateExists()
  await testFeatureFlagsRegistered()
  await testOgProfilePinHelper()
  await testOgChamberHelper()
  await testRouteImportsDoNotThrow()
  await testDesignTokenWiring()
  await testDesignTokenModule()
  console.log("=== integration all passed ===")
}

main().catch((e) => {
  console.error("integration test failed:", e)
  process.exit(1)
})
