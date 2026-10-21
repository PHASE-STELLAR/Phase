/**
 * Legal consent route guard helper.
 *
 * Can be invoked by Next.js middleware or server route handlers to enforce
 * that an acting wallet has accepted the current terms of service and privacy policy.
 */

import { NextResponse } from "next/server";
import { isConsent166Enabled, hasAcceptedCurrentLegal } from "@/lib/legal-consent";

export async function checkLegalConsentGate(
  wallet: string | null | undefined,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  if (!isConsent166Enabled() || !wallet) {
    return { ok: true };
  }

  const status = await hasAcceptedCurrentLegal(wallet);
  if (!status.accepted) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "consent_required",
          code: "CONSENT_REQUIRED",
          pending_documents: status.pending_documents,
          current_versions: status.current_versions,
          message: "Active legal consent required before performing this operation.",
        },
        { status: 451 },
      ),
    };
  }

  return { ok: true };
}
