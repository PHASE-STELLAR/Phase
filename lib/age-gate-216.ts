/**
 * phase-216 — age-gate enforcement on viewer and claim paths.
 *
 * phase-164 shipped age bands and the declaration store but never wired the
 * gate into a viewer or claim path. This module enforces the same `AgeGate`
 * taxonomy on both surfaces and returns HTTP 451 on a denial, with every
 * decision written to the append-only audit log.
 *
 * Flag off: every check is a no-op and no audit row is written — legacy
 * behavior, declarations stay inert on disk.
 */

import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags"
import { isAgeGate, meetsAgeGate, getAgeBand, type AgeGate } from "@/lib/age-gate"
import { appendGatingDecision } from "@/lib/gating-audit"

export const AGE_RESTRICTED_STATUS = 451
export const AGE_RESTRICTED_CODE = "AGE_RESTRICTED"

export class AgeRestrictedError extends Error {
  readonly code = AGE_RESTRICTED_CODE
  readonly status = AGE_RESTRICTED_STATUS
  readonly surface: "viewer" | "claim"
  readonly gate: AgeGate

  constructor(surface: "viewer" | "claim", gate: AgeGate) {
    super(`This content requires a declared age of ${gate}`)
    this.name = "AgeRestrictedError"
    this.surface = surface
    this.gate = gate
  }
}

export function isPhase216Enabled(): boolean {
  return isFeatureEnabled("phase-216")
}

export function phase216RollbackNote(): string {
  return flagRollbackNote("phase-216")
}

/** Reads and validates the configured gate for a surface; defaults to "none". */
export function configuredAgeGate(surface: "viewer" | "claim"): AgeGate {
  const raw = (
    process.env[`PHASE_${surface.toUpperCase()}_AGE_GATE`] ?? ""
  ).trim()
  return isAgeGate(raw) ? raw : "none"
}

/**
 * Enforce the configured gate for a wallet. Resolves silently when the flag
 * is off or the gate is "none"; otherwise audits and throws on denial.
 */
export async function enforceAgeGate216(
  wallet: string,
  surface: "viewer" | "claim",
): Promise<"allowed" | "not-configured"> {
  if (!isPhase216Enabled()) return "not-configured"
  const gate = configuredAgeGate(surface)
  if (gate === "none") return "not-configured"

  const band = await getAgeBand(wallet)
  const allowed = meetsAgeGate(band, gate)
  await appendGatingDecision({
    action: surface === "viewer" ? "age_gate.viewer" : "age_gate.claim",
    subject: wallet,
    wallet,
    decision: allowed ? "allowed" : "denied",
    reason: allowed ? `band ${band ?? "none"} meets ${gate}` : `band ${band ?? "none"} below ${gate}`,
  })
  if (!allowed) throw new AgeRestrictedError(surface, gate)
  return "allowed"
}
