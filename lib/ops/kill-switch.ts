/**
 * Ops kill-switch primitives.
 *
 * The switch is read once, statically, at module load. Turning it on halts
 * privileged background work without deleting, moving or minting any funds.
 */

export const KILL_SWITCH_ENV_VAR = "PHASE_OPS_KILL_SWITCH";

export type KillSwitchTarget = "auto_refill" | "all";

export type KillSwitchSnapshot = ReadonlySet<KillSwitchTarget>;

const VALID_TARGETS: readonly KillSwitchTarget[] = ["auto_refill", "all"];

export function parseKillSwitch(value: string | undefined): KillSwitchSnapshot {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "" || raw === "none" || raw === "off") return new Set();
  const tokens = raw.split(",").map((token) => token.trim());
  return new Set(tokens.filter((token): token is KillSwitchTarget =>
    (VALID_TARGETS as readonly string[]).includes(token),
  ));
}

/** Static snapshot. Later process.env changes do not affect the switch. */
export const KILL_SWITCH_SNAPSHOT: KillSwitchSnapshot = parseKillSwitch(
  process.env[KILL_SWITCH_ENV_VAR],
);

export function isTargetHalted(
  target: Exclude<KillSwitchTarget, "all">,
  snapshot: KillSwitchSnapshot = KILL_SWITCH_SNAPSHOT,
): boolean {
  return snapshot.has("all") || snapshot.has(target);
}

export class AutoRefillHaltedError extends Error {
  readonly code = "AUTO_REFILL_HALTED";

  constructor() {
    super("Distributor auto-refill is halted by the ops kill switch.");
    this.name = "AutoRefillHaltedError";
  }
}

export function assertAutoRefillAllowed(
  snapshot: KillSwitchSnapshot = KILL_SWITCH_SNAPSHOT,
): void {
  if (isTargetHalted("auto_refill", snapshot)) throw new AutoRefillHaltedError();
}
