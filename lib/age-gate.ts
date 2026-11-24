/**
 * Self-attested age bands and 18+/21+ campaign gating — spike 637 (issue #499).
 *
 * A declared birth year is bound to a SEP-10 session wallet (see sep10-auth.ts),
 * so the claim belongs to a proven key. Only the derived band is persisted; the
 * birth year is discarded to keep PII out of the sidecar store. The first
 * declaration per wallet is final, so a user cannot retry with other years.
 *
 * Self-attestation is not identity verification. Year-only precision is
 * conservative: a declared year counts as "at least N" only when the earliest
 * possible birthday already reaches N.
 *
 * Feature flag: phase-164. Rollback: unset flag; stored bands stay inert on disk.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { serverDataJsonPath } from "@/lib/server-data-paths"

export const AGE_GATES = ["none", "18+", "21+"] as const
export type AgeGate = (typeof AGE_GATES)[number]

export type AgeBand = "under-18" | "18+" | "21+"

export type AgeDeclaration = { band: AgeBand; declared_at: number }

export class AgeGateError extends Error {
  code: "FLAG_DISABLED" | "INVALID_BIRTH_YEAR" | "AGE_GATE_REQUIRED"
  constructor(code: AgeGateError["code"], message: string) {
    super(message)
    this.name = "AgeGateError"
    this.code = code
  }
}

export function isAge164Enabled(): boolean {
  return isFeatureEnabled("phase-164")
}

export function isAgeGate(value: unknown): value is AgeGate {
  return typeof value === "string" && (AGE_GATES as readonly string[]).includes(value)
}

/** Conservative band from a birth year: counts only years that are certain. */
export function bandFromBirthYear(birthYear: number, nowYear: number = new Date().getFullYear()): AgeBand {
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > nowYear) {
    throw new AgeGateError("INVALID_BIRTH_YEAR", "birth year must be an integer between 1900 and the current year")
  }
  const minimumAge = nowYear - birthYear - 1
  if (minimumAge >= 21) return "21+"
  if (minimumAge >= 18) return "18+"
  return "under-18"
}

export function meetsAgeGate(band: AgeBand | null | undefined, gate: AgeGate): boolean {
  if (gate === "none") return true
  if (!band) return false
  if (gate === "21+") return band === "21+"
  return band === "18+" || band === "21+"
}

type AgeStore = Record<string, AgeDeclaration>

async function readStore(): Promise<AgeStore> {
  try {
    const raw = await readFile(serverDataJsonPath("ageDeclarations"), "utf8")
    return JSON.parse(raw) as AgeStore
  } catch {
    return {}
  }
}

async function writeStore(store: AgeStore): Promise<void> {
  const fp = serverDataJsonPath("ageDeclarations")
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(fp, JSON.stringify(store, null, 2), "utf8")
}

/** Record a band for a session-proven wallet. Existing declarations are returned unchanged. */
export async function declareAge(wallet: string, birthYear: number): Promise<AgeDeclaration> {
  if (!isAge164Enabled()) {
    throw new AgeGateError("FLAG_DISABLED", "age declarations disabled (phase-164 flag off)")
  }
  const store = await readStore()
  if (store[wallet]) return store[wallet]

  const declaration: AgeDeclaration = {
    band: bandFromBirthYear(birthYear),
    declared_at: Math.floor(Date.now() / 1000),
  }
  store[wallet] = declaration
  await writeStore(store)
  return declaration
}

export async function getAgeBand(wallet: string): Promise<AgeBand | null> {
  const store = await readStore()
  return store[wallet]?.band ?? null
}

/** Throws AGE_GATE_REQUIRED unless the wallet's declared band satisfies the gate. */
export async function assertAgeGate(wallet: string, gate: AgeGate): Promise<void> {
  if (gate === "none") return
  if (!isAge164Enabled()) return
  const band = await getAgeBand(wallet)
  if (!meetsAgeGate(band, gate)) {
    throw new AgeGateError("AGE_GATE_REQUIRED", `this action requires a declared age of ${gate}`)
  }
}
