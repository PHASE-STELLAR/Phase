/**
 * Albedo full retirement-or-parity plan with flagged sunset.
 * Spike 626 / Issue #489.
 *
 * Albedo is load-bearing across the app: the intent client implicit flow
 * (`lib/albedo-intent-client.ts`), the wallet-provider bottom banner +
 * `syncTxPrep`, the trustline prep card + pre-sign block, the chamber
 * trustline guard, and the `signTransaction` early-return that demands popup
 * permission. `@albedo-link/intent` is pinned at 0.12.0.
 *
 * This module implements the deprecation program, not a feature freeze alone:
 * - "parity-freeze": every existing call site keeps working exactly as today;
 *   no NEW Albedo call sites may be registered and the intent version stays
 *   pinned (parity is frozen, never deepened).
 * - "retired": every Albedo call site is blocked fail-closed; signing paths
 *   surface migration copy guiding the user to Freighter / Ledger /
 *   WalletConnect. No popup is opened and the intent bundle is not loaded.
 *
 * Not spikes 520/537 (keep Albedo first-class with guards) — this is the
 * removal path with a reversible flag.
 *
 * Feature flag: phase-170.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_170 / FEATURE_PHASE_170; every
 * call site reverts to the legacy guarded Albedo behavior (zero regression).
 */

import { isFeatureEnabled } from "@/lib/feature-flags";
import type {
  AlbedoCallSite,
  AlbedoCallSiteId,
  AlbedoSunsetMode,
} from "@/lib/types/albedo-sunset";

/** Pinned `@albedo-link/intent` version — parity freeze forbids drift. */
export const ALBEDO_INTENT_PINNED_VERSION = "0.12.0";

export class AlbedoSunsetError extends Error {
  code: "ALBEDO_RETIRED" | "CALL_SITE_FROZEN" | "PARITY_VERSION_DRIFT";
  site?: AlbedoCallSiteId;

  constructor(
    code: AlbedoSunsetError["code"],
    message: string,
    site?: AlbedoCallSiteId,
  ) {
    super(message);
    this.name = "AlbedoSunsetError";
    this.code = code;
    this.site = site;
  }
}

export function isAlbedoSunset170Enabled(): boolean {
  return isFeatureEnabled("phase-170");
}

/**
 * Registry of every Albedo call site in the app. The retirement program is
 * only complete when every entry here has a migrated replacement; the status
 * endpoint surfaces this list verbatim.
 */
export const ALBEDO_CALL_SITES: readonly AlbedoCallSite[] = [
  {
    id: "intent-implicit-flow",
    surface: "Albedo implicit flow popup (tx + trust intents)",
    file: "lib/albedo-intent-client.ts",
    replacement: "kit-native per-module signing (Freighter / WalletConnect / Ledger)",
  },
  {
    id: "intent-session-check",
    surface: "isImplicitSessionAllowed pre-sign session probe",
    file: "lib/albedo-intent-client.ts",
    replacement: "kit signTransaction capability probe (no implicit session)",
  },
  {
    id: "kit-sign-guard",
    surface: "signTransaction early-return demanding popup permission",
    file: "lib/stellar-wallet-kit.ts",
    replacement: "retired error copy directing reconnect to supported wallets",
  },
  {
    id: "provider-banner",
    surface: "wallet-provider bottom banner + syncTxPrep",
    file: "components/wallet-provider.tsx",
    replacement: "Albedo sunset banner (parity-freeze / retired copy)",
  },
  {
    id: "trustline-prep-card",
    surface: "trustline prep card + pre-sign block",
    file: "components/trustline-button.tsx",
    replacement: "direct changeTrust signing via kit (no Albedo prep step)",
  },
  {
    id: "chamber-trustline-guard",
    surface: "chamber / liquidity faucet reward-trustline guard",
    file: "components/fusion-chamber.tsx, components/liquidity-faucet-control.tsx",
    replacement: "kit-native trustline signing without implicit-session gate",
  },
] as const;

const CALL_SITE_IDS = new Set<string>(ALBEDO_CALL_SITES.map((c) => c.id));

/**
 * Resolves the active sunset mode.
 * Returns null while the flag is off (Albedo active, legacy behavior).
 * `ALBEDO_SUNSET_MODE` selects `parity-freeze` (default) or `retired`;
 * `full` is an alias for `parity-freeze` until the parity checklist lands.
 * Unknown values fail safe to `parity-freeze` — never to `retired`.
 */
export function getAlbedoSunsetMode(): AlbedoSunsetMode | null {
  if (!isAlbedoSunset170Enabled()) return null;
  const raw =
    typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>).ALBEDO_SUNSET_MODE?.trim().toLowerCase()
      : undefined;
  if (raw === "retired") return "retired";
  if (raw === "parity-freeze" || raw === "full") return "parity-freeze";
  if (raw) {
    console.warn(
      `[PHASE] ALBEDO_SUNSET_MODE="${raw}" is not a valid mode (parity-freeze | retired); defaulting to parity-freeze`,
    );
  }
  return "parity-freeze";
}

export function isAlbedoParityFrozen(): boolean {
  return getAlbedoSunsetMode() === "parity-freeze";
}

export function isAlbedoRetired(): boolean {
  return getAlbedoSunsetMode() === "retired";
}

export function albedoRetiredMessage(lang: "en" | "es"): string {
  return lang === "es"
    ? "Albedo fue retirado de PHASE. Conectá Freighter, Ledger o WalletConnect para firmar."
    : "Albedo has been retired on PHASE. Connect Freighter, Ledger or WalletConnect to sign.";
}

/** Bilingual variant for surfaces without lang plumbing (kit errors, toasts). */
export function albedoRetiredSignMessage(): string {
  return `${albedoRetiredMessage("es")} / ${albedoRetiredMessage("en")}`;
}

export function albedoParityFreezeNotice(lang: "en" | "es"): string {
  return lang === "es"
    ? "Albedo está en congelación de paridad: los flujos actuales siguen funcionando, pero no se agregan integraciones nuevas."
    : "Albedo is in parity-freeze: existing flows keep working, but no new integrations are added.";
}

/**
 * Fail-closed gate for every Albedo call site. Throws once the mode is
 * `retired`; passes through under `parity-freeze` and with the flag off.
 */
export function assertAlbedoCallSiteAllowed(site: AlbedoCallSiteId): void {
  if (isAlbedoRetired()) {
    throw new AlbedoSunsetError(
      "ALBEDO_RETIRED",
      `Albedo call site '${site}' is retired. ${albedoRetiredSignMessage()}`,
      site,
    );
  }
}

/**
 * Registering a NEW Albedo integration is forbidden under parity-freeze or
 * retirement — this is the write path of the freeze.
 */
export function registerAlbedoCallSite(id: AlbedoCallSiteId): void {
  if (CALL_SITE_IDS.has(id)) return; // re-registering a known site is a no-op
  if (getAlbedoSunsetMode() !== null) {
    throw new AlbedoSunsetError(
      "CALL_SITE_FROZEN",
      `New Albedo call site '${id}' rejected: the sunset program (${getAlbedoSunsetMode()}) forbids new Albedo integrations.`,
      id,
    );
  }
}

/**
 * Parity freeze: the pinned intent version must not drift. Pure so tests can
 * exercise upgrades without touching package.json.
 */
export function checkAlbedoParityVersion(current: string): "pinned" | "drifted" {
  return current.trim() === ALBEDO_INTENT_PINNED_VERSION ? "pinned" : "drifted";
}

export function assertParityVersionFrozen(current: string): void {
  if (checkAlbedoParityVersion(current) !== "pinned") {
    throw new AlbedoSunsetError(
      "PARITY_VERSION_DRIFT",
      `@albedo-link/intent ${current} drifted from pinned ${ALBEDO_INTENT_PINNED_VERSION}; parity-freeze forbids upgrades.`,
    );
  }
}

export function albedoSunsetCheck(site: AlbedoCallSiteId): {
  allowed: boolean;
  mode: AlbedoSunsetMode | null;
  reason?: string;
} {
  const mode = getAlbedoSunsetMode();
  if (mode === "retired") {
    return { allowed: false, mode, reason: `Call site '${site}' blocked: Albedo retired.` };
  }
  return { allowed: true, mode };
}

/** Status payload for `GET /api/albedo/status` and admin dashboards. */
export function albedoSunsetStatus(): {
  enabled: boolean;
  mode: AlbedoSunsetMode | null;
  pinned_version: string;
  call_sites: AlbedoCallSite[];
} {
  return {
    enabled: isAlbedoSunset170Enabled(),
    mode: getAlbedoSunsetMode(),
    pinned_version: ALBEDO_INTENT_PINNED_VERSION,
    call_sites: [...ALBEDO_CALL_SITES],
  };
}
