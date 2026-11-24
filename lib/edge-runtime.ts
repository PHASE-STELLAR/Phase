/**
 * phase-268 (issue #726): edge runtime detection, shared by edge-safe helpers.
 * Must stay free of Node-only imports; `lib/edge-bundle.ts` proves it in CI.
 *
 * Feature flag: phase-268 (NEXT_PUBLIC_FEATURE_PHASE_268 / FEATURE_PHASE_268)
 * gates the degraded in-memory fallback in `lib/edge-store.ts`. Route runtime
 * placement is a static `export const runtime` that Next.js reads at build
 * time, so the flag never moves a route; with it off, edge code that reaches
 * a file-backed store fails exactly as before (EdgeStoreUnavailableError).
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

/** True inside the edge runtime, whether or not Next.js compiled the module. */
export function isEdgeRuntime(): boolean {
  if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime === "string") return true
  return typeof process !== "undefined" && process.env?.NEXT_RUNTIME === "edge"
}

export function isEdgeHardeningEnabled(): boolean {
  return isFeatureEnabled("phase-268")
}
