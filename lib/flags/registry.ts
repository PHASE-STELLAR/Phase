/**
 * Canonical feature-flag registry.
 *
 * The IDs phase-170..phase-174 were historically reused for two different
 * features each. Every feature now owns a unique canonical ID; the old,
 * ambiguous IDs survive only as *aliases* in FLAG_ENV_MAP so a rollback can be
 * performed by restoring an alias without renaming code again.
 *
 * Flags are evaluated once, statically, from the environment snapshot taken at
 * module load. Mutating process.env afterwards never changes a flag value.
 */

export const FLAG_ENV_PREFIX = "PHASE_FLAG_";

export interface FlagDefinition {
  readonly id: string;
  readonly envVar: string;
  readonly feature: string;
  readonly rollback: string;
  readonly aliases: readonly string[];
}

export const FLAG_DEFINITIONS: readonly FlagDefinition[] = [
  {
    id: "phase-170",
    envVar: "PHASE_FLAG_LOG_PIPELINE",
    feature: "Structured log pipeline",
    rollback: "Unset PHASE_FLAG_LOG_PIPELINE; sink falls back to console transport.",
    aliases: ["phase-170:log-pipeline", "phase-log-pipeline"],
  },
  {
    id: "phase-184",
    envVar: "PHASE_FLAG_ALBEDO_SUNSET",
    feature: "Albedo sunset / deprecation notice",
    rollback: "Unset PHASE_FLAG_ALBEDO_SUNSET; Albedo adapter stays active.",
    aliases: ["phase-170:albedo-sunset", "phase-albedo-sunset"],
  },
  {
    id: "phase-171",
    envVar: "PHASE_FLAG_BACKUP_DR",
    feature: "Backup and disaster-recovery export",
    rollback: "Unset PHASE_FLAG_BACKUP_DR; export endpoints stay inert.",
    aliases: ["phase-171:backup-dr", "phase-backup-dr"],
  },
  {
    id: "phase-185",
    envVar: "PHASE_FLAG_FREIGHTER_MOBILE",
    feature: "Freighter deep-link / mobile wallet flow",
    rollback: "Unset PHASE_FLAG_FREIGHTER_MOBILE; desktop flow only.",
    aliases: ["phase-171:freighter-mobile", "phase-freighter-mobile"],
  },
  {
    id: "phase-172",
    envVar: "PHASE_FLAG_DB_PARITY",
    feature: "Database parity assertions",
    rollback: "Unset PHASE_FLAG_DB_PARITY; parity checks are skipped.",
    aliases: ["phase-172:db-parity", "phase-db-parity"],
  },
  {
    id: "phase-186",
    envVar: "PHASE_FLAG_BIOMETRIC_UNLOCK",
    feature: "Biometric trust-gate unlock",
    rollback: "Unset PHASE_FLAG_BIOMETRIC_UNLOCK; gate error #13 remains closed.",
    aliases: ["phase-172:biometric-unlock", "phase-biometric-unlock"],
  },
  {
    id: "phase-173",
    envVar: "PHASE_FLAG_PREVIEW_ISOLATION",
    feature: "Docs preview isolation",
    rollback: "Unset PHASE_FLAG_PREVIEW_ISOLATION; preview uses shared data dir.",
    aliases: ["phase-173:preview-isolation", "phase-preview-isolation"],
  },
  {
    id: "phase-187",
    envVar: "PHASE_FLAG_WALLET_HISTORY",
    feature: "Wallet history indexing",
    rollback: "Unset PHASE_FLAG_WALLET_HISTORY; history indexer is disabled.",
    aliases: ["phase-173:wallet-history", "phase-wallet-history"],
  },
  {
    id: "phase-174",
    envVar: "PHASE_FLAG_KILL_SWITCH_DRILLS",
    feature: "Non-destructive kill-switch drills",
    rollback: "Unset PHASE_FLAG_KILL_SWITCH_DRILLS; drill endpoints stay inert.",
    aliases: ["phase-174:kill-switch-drills", "phase-kill-switch-drills"],
  },
  {
    id: "phase-217",
    envVar: "PHASE_FLAG_SEP50_ADAPTER",
    feature: "SEP-50 attestation adapter",
    rollback: "Unset PHASE_FLAG_SEP50_ADAPTER; SEP-50 checks are skipped.",
    aliases: ["phase-sep50-adapter"],
  },
  {
    id: "phase-218",
    envVar: "PHASE_FLAG_EVM_BRIDGE",
    feature: "PHASELQ EVM bridge (testnet only)",
    rollback: "Unset PHASE_FLAG_EVM_BRIDGE; bridge routes disappear, locked funds stay recoverable.",
    aliases: ["phase-evm-bridge"],
  },
  {
    id: "phase-219",
    envVar: "PHASE_FLAG_CROSSCHAIN_VERIFY",
    feature: "Cross-chain proof verifier (read-only)",
    rollback: "Unset PHASE_FLAG_CROSSCHAIN_VERIFY; verification is skipped.",
    aliases: ["phase-crosschain-verify"],
  },
] as const;

export interface FlagMapEntry {
  readonly id: string;
  readonly envVar: string;
  readonly canonical: boolean;
}

export type FlagEnvMap = Readonly<Record<string, FlagMapEntry>>;

function buildFlagEnvMap(): FlagEnvMap {
  const map: Record<string, FlagMapEntry> = {};
  for (const definition of FLAG_DEFINITIONS) {
    const canonical: FlagMapEntry = {
      id: definition.id,
      envVar: definition.envVar,
      canonical: true,
    };
    if (map[definition.id]) {
      throw new Error(`Duplicate flag id in registry: ${definition.id}`);
    }
    map[definition.id] = canonical;
    for (const alias of definition.aliases) {
      if (map[alias]) {
        throw new Error(`Duplicate flag alias in registry: ${alias}`);
      }
      map[alias] = { ...canonical, canonical: false };
    }
  }
  return Object.freeze(map);
}

/** Single lookup surface: canonical IDs plus every rollback alias. */
export const FLAG_ENV_MAP: FlagEnvMap = buildFlagEnvMap();

export function resolveFlagId(input: string): string | null {
  return FLAG_ENV_MAP[input]?.id ?? null;
}

export function flagEnvVar(input: string): string | null {
  return FLAG_ENV_MAP[input]?.envVar ?? null;
}

export function isTruthyFlagValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

function evaluateSnapshot(env: EnvLike): Readonly<Record<string, boolean>> {
  const snapshot: Record<string, boolean> = {};
  for (const definition of FLAG_DEFINITIONS) {
    snapshot[definition.id] = isTruthyFlagValue(env[definition.envVar]);
  }
  return Object.freeze(snapshot);
}

/** Static snapshot: computed once, never re-read from process.env. */
export const FLAG_SNAPSHOT: Readonly<Record<string, boolean>> = evaluateSnapshot(process.env);

export function getFlagSnapshot(): Readonly<Record<string, boolean>> {
  return FLAG_SNAPSHOT;
}

export function isFlagEnabled(input: string): boolean {
  const id = resolveFlagId(input);
  if (id === null) return false;
  return FLAG_SNAPSHOT[id] === true;
}

/** Testable pure form of the static evaluation, with an injected env object. */
export function evaluateFlagFromEnv(input: string, env: EnvLike): boolean {
  const id = resolveFlagId(input);
  if (id === null) return false;
  const entry = FLAG_DEFINITIONS.find((definition) => definition.id === id);
  return entry !== undefined && isTruthyFlagValue(env[entry.envVar]);
}
