import { afterEach, beforeEach, describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  ALBEDO_CALL_SITES,
  ALBEDO_INTENT_PINNED_VERSION,
  AlbedoSunsetError,
  albedoParityFreezeNotice,
  albedoRetiredMessage,
  albedoRetiredSignMessage,
  albedoSunsetCheck,
  albedoSunsetStatus,
  assertAlbedoCallSiteAllowed,
  assertParityVersionFrozen,
  checkAlbedoParityVersion,
  getAlbedoSunsetMode,
  isAlbedoParityFrozen,
  isAlbedoRetired,
  isAlbedoSunset221Enabled,
  registerAlbedoCallSite,
} from "@/lib/albedo-sunset"
import type { AlbedoCallSiteId } from "@/lib/types/albedo-sunset"

describe("phase-221 Albedo sunset program", () => {
  const originalFlag = process.env.FEATURE_PHASE_221
  const originalMode = process.env.ALBEDO_SUNSET_MODE

  beforeEach(() => {
    process.env.FEATURE_PHASE_221 = "1"
    delete process.env.ALBEDO_SUNSET_MODE
  })

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_PHASE_221
    else process.env.FEATURE_PHASE_221 = originalFlag
    if (originalMode === undefined) delete process.env.ALBEDO_SUNSET_MODE
    else process.env.ALBEDO_SUNSET_MODE = originalMode
  })

  it("is flag gated", () => {
    assert.equal(isAlbedoSunset221Enabled(), true)
    process.env.FEATURE_PHASE_221 = "0"
    assert.equal(isAlbedoSunset221Enabled(), false)
  })

  it("returns null mode (legacy guarded behavior) with the flag off", () => {
    process.env.FEATURE_PHASE_221 = "0"
    assert.equal(getAlbedoSunsetMode(), null)
    assert.equal(isAlbedoRetired(), false)
    assert.equal(isAlbedoParityFrozen(), false)
  })

  it("defaults to parity-freeze and fails safe on unknown modes", () => {
    assert.equal(getAlbedoSunsetMode(), "parity-freeze")
    assert.equal(isAlbedoParityFrozen(), true)
    process.env.ALBEDO_SUNSET_MODE = "full"
    assert.equal(getAlbedoSunsetMode(), "parity-freeze")
    process.env.ALBEDO_SUNSET_MODE = "banana"
    assert.equal(getAlbedoSunsetMode(), "parity-freeze")
    assert.equal(isAlbedoRetired(), false)
  })

  it("resolves retired mode and blocks every registered call site", () => {
    process.env.ALBEDO_SUNSET_MODE = "retired"
    assert.equal(getAlbedoSunsetMode(), "retired")
    assert.equal(isAlbedoRetired(), true)
    for (const site of ALBEDO_CALL_SITES) {
      assert.throws(() => assertAlbedoCallSiteAllowed(site.id), AlbedoSunsetError)
    }
    const check = albedoSunsetCheck("kit-sign-guard")
    assert.equal(check.allowed, false)
    assert.equal(check.mode, "retired")
  })

  it("allows registered call sites under parity-freeze and with the flag off", () => {
    for (const site of ALBEDO_CALL_SITES) {
      assert.doesNotThrow(() => assertAlbedoCallSiteAllowed(site.id))
      assert.equal(albedoSunsetCheck(site.id).allowed, true)
    }
    process.env.FEATURE_PHASE_221 = "0"
    for (const site of ALBEDO_CALL_SITES) {
      assert.doesNotThrow(() => assertAlbedoCallSiteAllowed(site.id))
    }
  })

  it("freezes new call sites while the program is active", () => {
    // Re-registering a known site is a no-op in every mode.
    assert.doesNotThrow(() => registerAlbedoCallSite("kit-sign-guard"))
    assert.throws(() => registerAlbedoCallSite("brand-new-site" as AlbedoCallSiteId), AlbedoSunsetError)
  })

  it("rejects unknown call sites under parity-freeze and retirement", () => {
    process.env.FEATURE_PHASE_221 = "0"
    assert.doesNotThrow(() => registerAlbedoCallSite("brand-new-site" as AlbedoCallSiteId))
    process.env.FEATURE_PHASE_221 = "1"
    assert.throws(() => registerAlbedoCallSite("another-site" as AlbedoCallSiteId), AlbedoSunsetError)
    process.env.ALBEDO_SUNSET_MODE = "retired"
    assert.throws(() => registerAlbedoCallSite("third-site" as AlbedoCallSiteId), AlbedoSunsetError)
  })

  it("enforces the pinned intent version", () => {
    assert.equal(ALBEDO_INTENT_PINNED_VERSION, "0.12.0")
    assert.equal(checkAlbedoParityVersion(ALBEDO_INTENT_PINNED_VERSION), "pinned")
    assert.equal(checkAlbedoParityVersion(" 0.12.0 "), "pinned")
    assert.equal(checkAlbedoParityVersion("0.13.0"), "drifted")
    assert.doesNotThrow(() => assertParityVersionFrozen("0.12.0"))
    assert.throws(() => assertParityVersionFrozen("0.13.0"), AlbedoSunsetError)
  })

  it("produces localized migration copy", () => {
    assert.notEqual(albedoRetiredMessage("es"), albedoRetiredMessage("en"))
    assert.match(albedoRetiredMessage("en"), /retired/i)
    assert.match(albedoRetiredMessage("es"), /retirado/i)
    assert.match(albedoParityFreezeNotice("en"), /parity-freeze/i)
    assert.ok(albedoRetiredSignMessage().includes(albedoRetiredMessage("en")))
    assert.ok(albedoRetiredSignMessage().includes(albedoRetiredMessage("es")))
  })

  it("exposes a status payload with the full call-site registry", () => {
    const status = albedoSunsetStatus()
    assert.equal(status.enabled, true)
    assert.equal(status.mode, "parity-freeze")
    assert.equal(status.pinned_version, ALBEDO_INTENT_PINNED_VERSION)
    assert.equal(status.call_sites.length, ALBEDO_CALL_SITES.length)
    assert.ok(status.call_sites.some((c) => c.id === "chamber-trustline-guard"))
    for (const site of status.call_sites) {
      assert.ok(site.file.length > 0)
      assert.ok(site.replacement.length > 0)
    }
  })
})
