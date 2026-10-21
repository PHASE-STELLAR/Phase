export type AlbedoSunsetMode = "parity-freeze" | "retired";

export type AlbedoCallSiteId =
  | "intent-implicit-flow"
  | "intent-session-check"
  | "kit-sign-guard"
  | "provider-banner"
  | "trustline-prep-card"
  | "chamber-trustline-guard";

export interface AlbedoCallSite {
  id: AlbedoCallSiteId;
  /** Human surface name used in status dashboards and audit output. */
  surface: string;
  /** File carrying the call site (kept in sync with the migration registry). */
  file: string;
  /** What replaces this call site when Albedo is fully removed. */
  replacement: string;
}

export interface AlbedoSunsetCheckResult {
  allowed: boolean;
  mode: AlbedoSunsetMode | null;
  reason?: string;
}

export interface AlbedoSunsetStatus {
  enabled: boolean;
  mode: AlbedoSunsetMode | null;
  pinned_version: string;
  call_sites: AlbedoCallSite[];
}
