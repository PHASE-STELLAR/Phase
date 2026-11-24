/**
 * Feature flags — PHASE rolling delivery.
 *
 * Each flag is opt-in via env. Supports both server and client where needed.
 * Rollback: unset the env var or set to "0"/"false" and restart. No migration to undo.
 *
 * Flags:
 * - phase-121: gateway health dashboard with latency scoring
 * - phase-122: off-chain metadata delta storage
 * - phase-123: IPFS timeout fallback chain
 * - phase-124: metadata version migration tool
 * - phase-167: WalletConnect session resilience (Spike 623)
 * - phase-182: liquidity pools + Soroswap router adapter (Spike 574)
 * - phase-220: Stellar Expert explorer links + read-only enrichment (Spike 648)
 * - phase-221: Albedo sunset / retirement program (Spike 626)
 */

export type PhaseFeatureFlag =
  | "phase-121"
  | "phase-122"
  | "phase-123"
  | "phase-124"
  | "phase-167"
  | "phase-182"
  | "phase-220"
  | "phase-221"

const FLAG_ENV_MAP: Record<PhaseFeatureFlag, string[]> = {
  "phase-121": ["NEXT_PUBLIC_FEATURE_PHASE_121", "FEATURE_PHASE_121"],
  "phase-122": ["NEXT_PUBLIC_FEATURE_PHASE_122", "FEATURE_PHASE_122"],
  "phase-123": ["NEXT_PUBLIC_FEATURE_PHASE_123", "FEATURE_PHASE_123"],
  "phase-124": ["NEXT_PUBLIC_FEATURE_PHASE_124", "FEATURE_PHASE_124"],
  "phase-167": ["NEXT_PUBLIC_FEATURE_PHASE_167", "FEATURE_PHASE_167"],
  "phase-182": ["NEXT_PUBLIC_FEATURE_PHASE_182", "FEATURE_PHASE_182"],
  "phase-220": ["NEXT_PUBLIC_FEATURE_PHASE_220", "FEATURE_PHASE_220"],
  "phase-221": ["NEXT_PUBLIC_FEATURE_PHASE_221", "FEATURE_PHASE_221"],
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

export function isFeatureEnabled(flag: PhaseFeatureFlag): boolean {
  const keys = FLAG_ENV_MAP[flag]
  for (const k of keys) {
    const v = (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>)[k] : undefined)
    if (isTruthy(v)) return true
  }
  return false
}

export function featureFlagEnvKeys(flag: PhaseFeatureFlag): string[] {
  return [...FLAG_ENV_MAP[flag]]
}

export function getEnabledFeatureFlags(): PhaseFeatureFlag[] {
  const all: PhaseFeatureFlag[] = [
    "phase-121",
    "phase-122",
    "phase-123",
    "phase-124",
    "phase-167",
    "phase-182",
    "phase-220",
    "phase-221",
  ]
  return all.filter(isFeatureEnabled)
}

export function flagRollbackNote(flag: PhaseFeatureFlag): string {
  const keys = FLAG_ENV_MAP[flag].join(" / ")
  return `Rollback ${flag}: unset ${keys} or set to 0/false and restart. No data migration to revert.`
}
