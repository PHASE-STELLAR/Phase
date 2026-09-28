import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  DEFAULT_PROFILE_LOCALE,
  localizeAvatarName,
  normalizeProfileLocale,
  resolveProfileLocale,
} from "@/lib/profile-store"

describe("phase-102 profile locale preferences", () => {
  it("normalizes supported locale tags case-insensitively", () => {
    assert.equal(normalizeProfileLocale("pt-br"), "pt-BR")
    assert.equal(normalizeProfileLocale("YO"), "yo")
    assert.equal(normalizeProfileLocale("unknown"), null)
  })

  it("guards locale resolution behind the phase-102 feature flag", () => {
    process.env.FEATURE_PHASE_102 = ""
    const disabled = resolveProfileLocale("fr")
    assert.equal(disabled.ok, false)
    assert.equal(disabled.locale, DEFAULT_PROFILE_LOCALE)

    process.env.FEATURE_PHASE_102 = "1"
    const enabled = resolveProfileLocale("fr")
    assert.equal(enabled.ok, true)
    assert.equal(enabled.locale, "fr")
    process.env.FEATURE_PHASE_102 = ""
  })

  it("localizes avatar display names with a safe English fallback", () => {
    assert.equal(localizeAvatarName(42, "es"), "Artefacto Phase #42")
    assert.equal(localizeAvatarName(7), "Phase Artifact #7")
  })
})