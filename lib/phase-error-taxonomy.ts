/**
 * Typed contract-error taxonomy — partial slice of spike 660 (issue #523).
 *
 * The SDK-facing error surface is currently the free-form
 * `parsePhaseContractErrorCode` / `humanizePhaseHostErrorMessage` pair. This
 * adds a typed, code-stable descriptor layer that mirrors the contract's
 * `PhaseError` discriminants 1:1 (with a stable `userMessageKey` and a
 * `retryable` hint), so a public consumer can branch on an enum instead of
 * matching strings.
 *
 * Scope: the contract `PhaseError` taxonomy + typed lookup. Horizon result
 * codes, JSON-RPC transport errors, retry/circuit policy, and dual-CJS/ESM
 * packaging remain spike 660 follow-ups.
 *
 * Feature flag: phase-161. Rollback: unset → callers keep using the existing
 * string helpers; this module stays inert (no persisted state).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { parsePhaseContractErrorCode } from "@/lib/phase-host-error"

export function isPhaseErrorTaxonomyEnabled(): boolean {
  return isFeatureEnabled("phase-161")
}

export type PhaseErrorDescriptor = {
  code: number
  discriminant: string
  /** Transient failures a caller may safely retry. */
  retryable: boolean
  /** Stable key into `lib/phase-copy.ts` for the user-facing message. */
  userMessageKey: string
}

const DISCRIMINANTS: Record<number, string> = {
  1: "AlreadyPhased",
  2: "InsufficientBalance",
  3: "TransferFailed",
  4: "UnauthorizedToken",
  5: "SettlementFailed",
  6: "InvalidInvoice",
  7: "InvalidCollection",
  8: "CreatorAlreadyHasCollection",
  9: "AmountBelowCollectionPrice",
  10: "InvalidCollectionMetadata",
  11: "NftNotFound",
  12: "NotNftOwner",
  13: "SelfTransfer",
  14: "UnauthorizedApprover",
  15: "NotApproved",
  16: "InvalidApproval",
  17: "InvalidOwnerTokenList",
  18: "CoinAlreadyRegistered",
  19: "CoinNotRegistered",
  20: "CoinNotVerified",
  21: "RewardAlreadyClaimed",
  22: "InvalidSplit",
  23: "TipBelowMinimum",
  24: "SelfDeal",
  25: "TipReplay",
  26: "EndowmentNotFound",
  27: "NothingToClaim",
  28: "EndowmentLocked",
  29: "EndowmentClosed",
  30: "DisputeOpen",
  31: "BondNotFound",
  32: "BondNotActive",
  33: "BondChallengeOpen",
  34: "BondLocked",
  35: "NotAuthorized",
  36: "InvalidAmount",
  37: "BondAlreadyPosted",
  38: "NoOpenChallenge",
  39: "InvalidSchedule",
}

/** Discriminants that are transient (retry-safe) rather than caller errors. */
const RETRYABLE_CODES = new Set<number>([3, 5])

function userMessageKey(discriminant: string): string {
  const snake = discriminant.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
  return `phase.error.${snake}`
}

export const PHASE_ERROR_TAXONOMY: Record<number, PhaseErrorDescriptor> = Object.fromEntries(
  Object.entries(DISCRIMINANTS).map(([code, discriminant]) => {
    const numeric = Number(code)
    return [
      numeric,
      {
        code: numeric,
        discriminant,
        retryable: RETRYABLE_CODES.has(numeric),
        userMessageKey: userMessageKey(discriminant),
      } satisfies PhaseErrorDescriptor,
    ]
  }),
)

export function describePhaseErrorCode(code: number): PhaseErrorDescriptor | null {
  return PHASE_ERROR_TAXONOMY[code] ?? null
}

/**
 * Parse a raw host/RPC error into a typed descriptor. Returns `null` when the
 * input carries no recognizable PHASE contract code, so callers fall back to
 * their generic error path.
 */
export function mapPhaseContractError(raw: unknown): PhaseErrorDescriptor | null {
  const code = parsePhaseContractErrorCode(raw)
  if (code == null) return null
  return describePhaseErrorCode(code)
}

export const PHASE_ERROR_CODES: readonly number[] = Object.keys(PHASE_ERROR_TAXONOMY).map(Number)

export function phaseErrorTaxonomyRollbackNote(): string {
  return "Rollback phase-161: unset NEXT_PUBLIC_FEATURE_PHASE_161 / FEATURE_PHASE_161 or set 0/false and restart. No persisted state."
}
