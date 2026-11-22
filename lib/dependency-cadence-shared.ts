/**
 * Toolchain constants and the phase-175 gate, split from
 * `lib/dependency-cadence.ts` (which hashes WASM with `node:crypto`) so that
 * `lib/phase-protocol.ts`, loaded by client and edge code, stays Node-free.
 */

import { flagRollbackNote, isFeatureEnabled } from "./feature-flags";

export const CANONICAL_WASM_TARGET = "wasm32-unknown-unknown" as const;
export const CANONICAL_SOROBAN_SDK_MAJOR = 22 as const;
export const CANONICAL_SOROBAN_ABI_VERSION = 22_000 as const;
export const CANONICAL_STELLAR_SDK_MAJOR = 15 as const;
export const CANONICAL_STELLAR_CLI_VERSION = "23.0.0" as const;

export function isDependencyCadenceEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-175", wallet ? { wallet } : undefined);
}

export function flag175RollbackNote(): string {
  return flagRollbackNote("phase-175");
}
