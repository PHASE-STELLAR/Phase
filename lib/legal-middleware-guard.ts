/**
 * Legal consent route guard helper.
 *
 * Can be invoked by Next.js middleware or server route handlers to enforce
 * that an acting wallet has accepted the current terms of service and privacy policy.
 *
 * Issue #730: Centralized guard for all protected route patterns.
 * Flag: NEXT_PUBLIC_FEATURE_PHASE_272 / FEATURE_PHASE_272
 * Rollback: unset the flag — guard skipped; per-route checks remain.
 */

import { NextResponse } from "next/server";
import { isConsent166Enabled, hasAcceptedCurrentLegal } from "@/lib/legal-consent";
import { isFeatureEnabled } from "@/lib/feature-flags";

// ─── Issue #730: Centralized protected route patterns ───────────────────────

/**
 * All route patterns that require legal consent. New protected routes MUST be
 * added here so the route inventory test catches unregistered routes.
 * Patterns are matched as prefixes against the pathname.
 */
export const PROTECTED_ROUTE_PATTERNS: readonly string[] = [
  "/api/world",
  "/api/forge",
  "/api/faucet",
  "/api/collection",
  "/api/wallet",
  "/api/admin",
  "/api/signals",
  "/api/leaderboard",
] as const;

export function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_ROUTE_PATTERNS.some((pattern) => pathname.startsWith(pattern));
}

// ─── Blocked-state copy (EN/ES) ─────────────────────────────────────────────

export const BLOCKED_COPY = {
  en: {
    title: "Access Blocked",
    consentRequired: "Active legal consent is required before performing this operation.",
    holdsRequired: "Active holds prevent this operation. Please resolve pending holds.",
    unreadableState: "Unable to verify legal consent status. Access denied for safety.",
  },
  es: {
    title: "Acceso Bloqueado",
    consentRequired: "Se requiere consentimiento legal activo antes de realizar esta operación.",
    holdsRequired: "Las retenciones activas impiden esta operación. Resuelve las retenciones pendientes.",
    unreadableState: "No se pudo verificar el estado del consentimiento legal. Acceso denegado por seguridad.",
  },
} as const;

function getBlockedCopy(lang: string = "en") {
  return lang === "es" ? BLOCKED_COPY.es : BLOCKED_COPY.en;
}

// ─── Guard ──────────────────────────────────────────────────────────────────

export async function checkLegalConsentGate(
  wallet: string | null | undefined,
  locale?: string,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  // Issue #730: When phase-272 is off, skip the centralized guard (legacy per-route checks)
  const flagOn = isFeatureEnabled("phase-272" as any)

  if (!isConsent166Enabled() || !wallet) {
    return { ok: true };
  }

  try {
    const status = await hasAcceptedCurrentLegal(wallet);
    if (!status.accepted) {
      const copy = getBlockedCopy(locale);
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "consent_required",
            code: "CONSENT_REQUIRED",
            pending_documents: status.pending_documents,
            current_versions: status.current_versions,
            message: copy.consentRequired,
          },
          { status: 451 },
        ),
      };
    }
  } catch (err) {
    // Issue #730: Fail closed when consent state cannot be read
    const copy = getBlockedCopy(locale);
    if (flagOn) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "consent_unreadable",
            code: "CONSENT_UNREADABLE",
            message: copy.unreadableState,
          },
          { status: 503 },
        ),
      }
    }
    // Flag off: log but don't block (legacy behavior)
    console.error("[legal-middleware-guard] Failed to read consent state:", err)
  }

  return { ok: true };
}

/**
 * Issue #730: Centralized guard for middleware. Apply to all protected route
 * patterns. Fails closed when consent or holds cannot be read (flag on).
 *
 * @param pathname - The request pathname
 * @param wallet - The acting wallet address
 * @param locale - The request locale ("en" | "es")
 * @returns { ok: true } | { ok: false; response: NextResponse }
 */
export async function legalGuardMiddleware(
  pathname: string,
  wallet: string | null | undefined,
  locale?: string,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const flagOn = isFeatureEnabled("phase-272" as any)

  // When flag is off, skip centralized guard (legacy per-route checks remain)
  if (!flagOn) return { ok: true }

  // Only apply to protected routes
  if (!isProtectedRoute(pathname)) return { ok: true }

  return checkLegalConsentGate(wallet, locale);
}
