import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
    expect(isAlbedoSunset221Enabled()).toBe(true)
    process.env.FEATURE_PHASE_221 = "0"
    expect(isAlbedoSunset221Enabled()).toBe(false)
  })

  it("returns null mode (legacy guarded behavior) with the flag off", () => {
    process.env.FEATURE_PHASE_221 = "0"
    expect(getAlbedoSunsetMode()).toBeNull()
    expect(isAlbedoRetired()).toBe(false)
    expect(isAlbedoParityFrozen()).toBe(false)
  })

  it("defaults to parity-freeze and fails safe on unknown modes", () => {
    expect(getAlbedoSunsetMode()).toBe("parity-freeze")
    expect(isAlbedoParityFrozen()).toBe(true)
    process.env.ALBEDO_SUNSET_MODE = "full"
    expect(getAlbedoSunsetMode()).toBe("parity-freeze")
    process.env.ALBEDO_SUNSET_MODE = "banana"
    expect(getAlbedoSunsetMode()).toBe("parity-freeze")
    expect(isAlbedoRetired()).toBe(false)
  })

  it("resolves retired mode and blocks every registered call site", () => {
    process.env.ALBEDO_SUNSET_MODE = "retired"
    expect(getAlbedoSunsetMode()).toBe("retired")
    expect(isAlbedoRetired()).toBe(true)
    for (const site of ALBEDO_CALL_SITES) {
      expect(() => assertAlbedoCallSiteAllowed(site.id)).toThrow(AlbedoSunsetError)
    }
    const check = albedoSunsetCheck("kit-sign-guard")
    expect(check.allowed).toBe(false)
    expect(check.mode).toBe("retired")
  })

  it("allows registered call sites under parity-freeze and with the flag off", () => {
    for (const site of ALBEDO_CALL_SITES) {
      expect(() => assertAlbedoCallSiteAllowed(site.id)).not.toThrow()
      expect(albedoSunsetCheck(site.id).allowed).toBe(true)
    }
    process.env.FEATURE_PHASE_221 = "0"
    for (const site of ALBEDO_CALL_SITES) {
      expect(() => assertAlbedoCallSiteAllowed(site.id)).not.toThrow()
    }
  })

  it("freezes new call sites while the program is active", () => {
    expect(() => registerAlbedoCallSite("kit-sign-guard")).not.toThrow()
    expect(() => registerAlbedoCallSite("brand-new-site" as AlbedoCallSiteId)).toThrow(AlbedoSunsetError)
  })

  it("rejects unknown call sites under parity-freeze and retirement", () => {
    process.env.FEATURE_PHASE_221 = "0"
    expect(() => registerAlbedoCallSite("brand-new-site" as AlbedoCallSiteId)).not.toThrow()
    process.env.FEATURE_PHASE_221 = "1"
    expect(() => registerAlbedoCallSite("another-site" as AlbedoCallSiteId)).toThrow(AlbedoSunsetError)
    process.env.ALBEDO_SUNSET_MODE = "retired"
    expect(() => registerAlbedoCallSite("third-site" as AlbedoCallSiteId)).toThrow(AlbedoSunsetError)
  })

  it("enforces the pinned intent version", () => {
    expect(ALBEDO_INTENT_PINNED_VERSION).toBe("0.12.0")
    expect(checkAlbedoParityVersion(ALBEDO_INTENT_PINNED_VERSION)).toBe("pinned")
    expect(checkAlbedoParityVersion(" 0.12.0 ")).toBe("pinned")
    expect(checkAlbedoParityVersion("0.13.0")).toBe("drifted")
    expect(() => assertParityVersionFrozen("0.12.0")).not.toThrow()
    expect(() => assertParityVersionFrozen("0.13.0")).toThrow(AlbedoSunsetError)
  })

  it("produces localized migration copy", () => {
    expect(albedoRetiredMessage("es")).not.toBe(albedoRetiredMessage("en"))
    expect(albedoRetiredMessage("en")).toMatch(/retired/i)
    expect(albedoRetiredMessage("es")).toMatch(/retirado/i)
    expect(albedoParityFreezeNotice("en")).toMatch(/parity-freeze/i)
    expect(albedoRetiredSignMessage()).toContain(albedoRetiredMessage("en"))
    expect(albedoRetiredSignMessage()).toContain(albedoRetiredMessage("es"))
  })

  it("exposes a status payload with the full call-site registry", () => {
    const status = albedoSunsetStatus()
    expect(status.enabled).toBe(true)
    expect(status.mode).toBe("parity-freeze")
    expect(status.pinned_version).toBe(ALBEDO_INTENT_PINNED_VERSION)
    expect(status.call_sites.length).toBe(ALBEDO_CALL_SITES.length)
    expect(status.call_sites.some((c) => c.id === "chamber-trustline-guard")).toBe(true)
    for (const site of status.call_sites) {
      expect(site.file.length).toBeGreaterThan(0)
      expect(site.replacement.length).toBeGreaterThan(0)
    }
  })
})
