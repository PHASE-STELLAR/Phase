import { readFileSync } from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  albedoSunsetStatus,
  ALBEDO_INTENT_PINNED_VERSION,
  isAlbedoSunset221Enabled,
} from "@/lib/albedo-sunset"
import { incSecurityCounter } from "@/lib/security-counters"

export const dynamic = "force-dynamic"

/** Reads the pinned dependency directly from package.json (server-only). */
function installedAlbedoIntentVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    return pkg.dependencies?.["@albedo-link/intent"]?.trim() ?? null
  } catch {
    return null
  }
}

/**
 * phase-221 / Spike 626 — public, read-only sunset status.
 * Exposes the active mode, call-site registry and dependency pin check.
 */
export async function GET() {
  if (!isAlbedoSunset221Enabled()) {
    return NextResponse.json(
      { error: "Albedo sunset program is disabled (set NEXT_PUBLIC_FEATURE_PHASE_221=1)" },
      { status: 404 },
    )
  }

  const installed = installedAlbedoIntentVersion()
  const pinnedVersionOk = installed === ALBEDO_INTENT_PINNED_VERSION
  if (!pinnedVersionOk) incSecurityCounter("albedo_version_drift")
  return NextResponse.json({
    ...albedoSunsetStatus(),
    installed_version: installed,
    pinned_version_ok: pinnedVersionOk,
  })
}
