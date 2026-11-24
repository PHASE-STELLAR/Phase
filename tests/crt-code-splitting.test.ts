/**
 * phase-66: component-level code-splitting for heavy CRT widgets — tests
 * Run: npx tsx tests/crt-code-splitting.test.ts
 */
import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_66 = "1"
process.env.FEATURE_PHASE_66 = "1"

import {
  CRT_CHUNK_REGISTRY,
  CRT_WIDGET_TYPES,
  CrtWidgetCodeSplitError,
  auditCrtWidgetWiring,
  getCrtBundleSavingsSummary,
  isPhase66Enabled,
  resolveCrtWidgetChunk,
} from "@/lib/profile-store"

async function testFlagEnabled() {
  assert.equal(isPhase66Enabled(), true)
  console.log("✓ phase-66 flag enabled via env")
}

async function testResolveAllWidgetChunks() {
  for (const type of CRT_WIDGET_TYPES) {
    const res = resolveCrtWidgetChunk(type)
    assert.equal(res.widgetType, type)
    assert.equal(res.chunkId, CRT_CHUNK_REGISTRY[type].chunkId)
    assert.ok(res.estimatedBytesSaved > 0)
    assert.equal(res.lazy, true)
    assert.ok(res.modulePath.startsWith("@/components/crt/"))
  }
  console.log("✓ all CRT widget types resolve valid chunks")
}

async function testDeviceAwareDeferral() {
  // Desktop high-priority cursor
  const desktop = resolveCrtWidgetChunk("terminal-cursor", { isMobile: false, priority: "high" })
  assert.equal(desktop.shouldDefer, false)

  // Mobile always defers
  const mobile = resolveCrtWidgetChunk("terminal-cursor", { isMobile: true, priority: "high" })
  assert.equal(mobile.shouldDefer, true)

  // Heavy widgets (e.g. scanline, glitch) default to deferred
  const scanline = resolveCrtWidgetChunk("scanline-overlay", { isMobile: false, priority: "medium" })
  assert.equal(scanline.shouldDefer, true)

  console.log("✓ device and priority-aware bundle deferral works as expected")
}

async function testBundleSavingsSummary() {
  const summary = getCrtBundleSavingsSummary()
  assert.equal(summary.totalWidgetTypes, CRT_WIDGET_TYPES.length)
  assert.ok(summary.totalEstimatedBytes > 200_000)
  assert.equal(typeof summary.chunks["glitch-distortion"], "number")
  console.log(`✓ bundle savings summary computes total (${summary.totalEstimatedBytes} bytes saved across ${summary.totalWidgetTypes} widgets)`)
}

async function testUnknownWidgetThrows() {
  let threw = false
  try {
    resolveCrtWidgetChunk("non-existent-widget")
  } catch (e) {
    threw = e instanceof CrtWidgetCodeSplitError && e.code === "WIDGET_NOT_FOUND"
  }
  assert.equal(threw, true)
  console.log("✓ unknown widget type throws WIDGET_NOT_FOUND error")
}

async function testFlagDisabledBlocksResolution() {
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_66
  delete process.env.FEATURE_PHASE_66
  assert.equal(isPhase66Enabled(), false)

  let threw = false
  try {
    resolveCrtWidgetChunk("scanline-overlay")
  } catch (e) {
    threw = e instanceof CrtWidgetCodeSplitError && e.code === "FLAG_DISABLED"
  }
  assert.equal(threw, true)

  // Can bypass with force: true
  const forced = resolveCrtWidgetChunk("scanline-overlay", { force: true })
  assert.equal(forced.chunkId, "chunk-crt-scanline")

  process.env.NEXT_PUBLIC_FEATURE_PHASE_66 = "1"
  process.env.FEATURE_PHASE_66 = "1"
  console.log("✓ resolution blocked when phase-66 disabled unless force option provided")
}

async function testWiringAudit() {
  const audit = auditCrtWidgetWiring()
  assert.equal(audit.ok, true)
  assert.ok(audit.note.includes("chunk-crt-scanline"))
  console.log("✓ wiring audit succeeds")
}

async function run() {
  await testFlagEnabled()
  await testResolveAllWidgetChunks()
  await testDeviceAwareDeferral()
  await testBundleSavingsSummary()
  await testUnknownWidgetThrows()
  await testFlagDisabledBlocksResolution()
  await testWiringAudit()
  console.log("\nAll CRT code-splitting (phase-66) tests passed.\n")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
