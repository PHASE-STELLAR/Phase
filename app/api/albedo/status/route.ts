import { NextResponse } from "next/server";
import {
  albedoSunsetStatus,
  isAlbedoSunset170Enabled,
} from "@/lib/albedo-sunset";

export const dynamic = "force-dynamic";

/**
 * Spike 626 / issue #489 — Albedo sunset program status.
 * Public, read-only: exposes the active mode and the call-site migration
 * registry so operators can track parity-freeze / retirement progress.
 */
export async function GET() {
  if (!isAlbedoSunset170Enabled()) {
    return NextResponse.json(
      { error: "Albedo sunset program is disabled (set NEXT_PUBLIC_FEATURE_PHASE_170=1)" },
      { status: 404 },
    );
  }

  return NextResponse.json(albedoSunsetStatus());
}
