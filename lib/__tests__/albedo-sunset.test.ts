import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  isAlbedoSunset170Enabled,
  registerAlbedoCallSite,
} from "@/lib/albedo-sunset";
import type { AlbedoCallSiteId } from "@/lib/types/albedo-sunset";

describe("phase-170 Albedo sunset program", () => {
  const originalFlag = process.env.FEATURE_PHASE_170;
  const originalMode = process.env.ALBEDO_SUNSET_MODE;

  beforeEach(() => {
    process.env.FEATURE_PHASE_170 = "1";
    delete process.env.ALBEDO_SUNSET_MODE;
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_PHASE_170;
    else process.env.FEATURE_PHASE_170 = originalFlag;
    if (originalMode === undefined) delete process.env.ALBEDO_SUNSET_MODE;
    else process.env.ALBEDO_SUNSET_MODE = originalMode;
  });

  it("checks the feature flag", () => {
    expect(isAlbedoSunset170Enabled()).toBe(true);
    process.env.FEATURE_PHASE_170 = "0";
    expect(isAlbedoSunset170Enabled()).toBe(false);
  });

  it("returns null mode (Albedo active) while the flag is off", () => {
    process.env.FEATURE_PHASE_170 = "0";
    expect(getAlbedoSunsetMode()).toBeNull();
    expect(isAlbedoRetired()).toBe(false);
    expect(isAlbedoParityFrozen()).toBe(false);
  });

  it("defaults to parity-freeze when no mode is configured", () => {
    expect(getAlbedoSunsetMode()).toBe("parity-freeze");
    expect(isAlbedoParityFrozen()).toBe(true);
    expect(isAlbedoRetired()).toBe(false);
  });

  it("treats 'full' as parity-freeze until parity lands", () => {
    process.env.ALBEDO_SUNSET_MODE = "full";
    expect(getAlbedoSunsetMode()).toBe("parity-freeze");
  });

  it("resolves 'retired'", () => {
    process.env.ALBEDO_SUNSET_MODE = "retired";
    expect(getAlbedoSunsetMode()).toBe("retired");
    expect(isAlbedoRetired()).toBe(true);
    expect(isAlbedoParityFrozen()).toBe(false);
  });

  it("fails safe to parity-freeze on unknown mode values", () => {
    process.env.ALBEDO_SUNSET_MODE = "banana";
    expect(getAlbedoSunsetMode()).toBe("parity-freeze");
    expect(isAlbedoRetired()).toBe(false);
  });

  it("blocks every registered call site once retired", () => {
    process.env.ALBEDO_SUNSET_MODE = "retired";
    for (const site of ALBEDO_CALL_SITES) {
      expect(() => assertAlbedoCallSiteAllowed(site.id)).toThrow(AlbedoSunsetError);
    }
    const check = albedoSunsetCheck("kit-sign-guard");
    expect(check.allowed).toBe(false);
    expect(check.mode).toBe("retired");
  });

  it("allows registered call sites under parity-freeze and with the flag off", () => {
    for (const site of ALBEDO_CALL_SITES) {
      expect(() => assertAlbedoCallSiteAllowed(site.id)).not.toThrow();
      expect(albedoSunsetCheck(site.id).allowed).toBe(true);
    }
    process.env.FEATURE_PHASE_170 = "0";
    for (const site of ALBEDO_CALL_SITES) {
      expect(() => assertAlbedoCallSiteAllowed(site.id)).not.toThrow();
    }
  });

  it("freezes registration of NEW Albedo call sites while sunset is active", () => {
    // Re-registering a known call site is a no-op in every mode.
    expect(() => registerAlbedoCallSite("kit-sign-guard")).not.toThrow();

    const newSite = "intent-implicit-flow" as AlbedoCallSiteId;
    // Flag off: registration allowed (sunset program not active).
    process.env.FEATURE_PHASE_170 = "0";
    // A genuinely new id would be accepted only while the program is off.
    // Use a known id here because the type union only contains registry ids;
    // the registry check is what matters at runtime.
    expect(() => registerAlbedoCallSite(newSite)).not.toThrow();

    process.env.FEATURE_PHASE_170 = "1";
    // Known ids stay no-ops; the freeze applies to additions, not to the
    // registry itself.
    expect(() => registerAlbedoCallSite(newSite)).not.toThrow();
    // Simulate an unknown id sneaking past the type system:
    expect(() => registerAlbedoCallSite("brand-new-site" as AlbedoCallSiteId)).toThrow(
      AlbedoSunsetError,
    );
    process.env.ALBEDO_SUNSET_MODE = "retired";
    expect(() => registerAlbedoCallSite("brand-new-site" as AlbedoCallSiteId)).toThrow(
      AlbedoSunsetError,
    );
  });

  it("enforces the pinned intent version under parity-freeze", () => {
    expect(checkAlbedoParityVersion(ALBEDO_INTENT_PINNED_VERSION)).toBe("pinned");
    expect(checkAlbedoParityVersion(" 0.12.0 ")).toBe("pinned");
    expect(checkAlbedoParityVersion("0.13.0")).toBe("drifted");
    expect(() => assertParityVersionFrozen("0.12.0")).not.toThrow();
    expect(() => assertParityVersionFrozen("0.13.0")).toThrow(AlbedoSunsetError);
  });

  it("produces localized retirement and freeze copy", () => {
    expect(albedoRetiredMessage("es")).not.toBe(albedoRetiredMessage("en"));
    expect(albedoRetiredMessage("en")).toMatch(/retired/i);
    expect(albedoRetiredMessage("es")).toMatch(/retirado/i);
    expect(albedoParityFreezeNotice("en")).toMatch(/parity-freeze/i);
    expect(albedoRetiredSignMessage()).toContain(albedoRetiredMessage("en"));
    expect(albedoRetiredSignMessage()).toContain(albedoRetiredMessage("es"));
  });

  it("exposes a status payload with the full migration registry", () => {
    const status = albedoSunsetStatus();
    expect(status.enabled).toBe(true);
    expect(status.mode).toBe("parity-freeze");
    expect(status.pinned_version).toBe(ALBEDO_INTENT_PINNED_VERSION);
    expect(status.call_sites.length).toBe(ALBEDO_CALL_SITES.length);
    expect(status.call_sites.map((c) => c.id)).toContain("chamber-trustline-guard");
    for (const site of status.call_sites) {
      expect(site.file.length).toBeGreaterThan(0);
      expect(site.replacement.length).toBeGreaterThan(0);
    }
  });
});
