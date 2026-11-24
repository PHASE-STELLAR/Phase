import { createHash } from "node:crypto";
import { incSecurityCounter } from "@/lib/security-counters";
import { readStore, updateJsonFile } from "@/lib/json-store";
import { serverDataJsonPath } from "@/lib/server-data-paths";

export type DormancyTier =
  | "active"
  | "at_risk"
  | "dormant_mild"
  | "dormant_deep"
  | "churned";

export type WinbackHookType =
  | "unfinished_quest"
  | "streak_recovery"
  | "new_world_drop"
  | "watchlist_discount"
  | "general_digest";

export type WinbackExperimentCohort =
  | "control"
  | "quest_bonus"
  | "fee_discount"
  | "social_digest";

export type WinbackEvaluation = {
  wallet: string;
  tier: DormancyTier;
  daysDormant: number;
  eligible: boolean;
  cohort: WinbackExperimentCohort;
  hook: WinbackHookType;
  title: string;
  body: string;
  fatigueSuppressed: boolean;
  cooldownRemainingDays: number;
};

export type WinbackHistoryEntry = {
  wallet: string;
  dispatchedAt: number;
  cohort: WinbackExperimentCohort;
  hook: WinbackHookType;
  experimentId: string;
};

export type WinbackStore = {
  entries: Record<string, WinbackHistoryEntry>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FATIGUE_COOLDOWN_DAYS = 7;

/**
 * Classifies a wallet into a dormancy tier based on time elapsed since last activity.
 */
export function classifyWalletDormancy(
  lastActiveMs: number,
  nowMs = Date.now(),
): { tier: DormancyTier; daysDormant: number } {
  const elapsed = Math.max(0, nowMs - lastActiveMs);
  const daysDormant = Math.floor(elapsed / DAY_MS);

  let tier: DormancyTier = "active";
  if (daysDormant >= 60) {
    tier = "churned";
  } else if (daysDormant >= 30) {
    tier = "dormant_deep";
  } else if (daysDormant >= 14) {
    tier = "dormant_mild";
  } else if (daysDormant >= 7) {
    tier = "at_risk";
  }

  if (tier !== "active") {
    incSecurityCounter("winback_dormant_detected");
  }

  return { tier, daysDormant };
}

/**
 * Assigns a wallet deterministically to an experiment cohort via salted hash.
 */
export function assignExperimentCohort(
  wallet: string,
  experimentId = "winback_v1",
  cohorts: WinbackExperimentCohort[] = ["control", "quest_bonus", "fee_discount", "social_digest"],
): WinbackExperimentCohort {
  const norm = wallet.trim().toLowerCase();
  const hash = createHash("sha256")
    .update(`${norm}:${experimentId}`)
    .digest("hex");
  const num = parseInt(hash.slice(0, 8), 16);
  return cohorts[num % cohorts.length] ?? "control";
}

/**
 * Verifies fatigue caps (cooldown window) to prevent spamming dormant users.
 */
export function checkFatigueCap(
  lastNotifiedMs: number | null | undefined,
  nowMs = Date.now(),
  cooldownDays = DEFAULT_FATIGUE_COOLDOWN_DAYS,
): { allowed: boolean; waitDaysRemaining: number } {
  if (!lastNotifiedMs || lastNotifiedMs <= 0) {
    return { allowed: true, waitDaysRemaining: 0 };
  }

  const elapsed = Math.max(0, nowMs - lastNotifiedMs);
  const cooldownMs = cooldownDays * DAY_MS;

  if (elapsed >= cooldownMs) {
    return { allowed: true, waitDaysRemaining: 0 };
  }

  const remainingMs = cooldownMs - elapsed;
  const waitDaysRemaining = Math.ceil(remainingMs / DAY_MS);
  return { allowed: false, waitDaysRemaining };
}

/**
 * Derives a personalized reactivation hook grounded in the user's prior activity.
 */
export function determineWinbackHook(
  wallet: string,
  activity: {
    hasUnfinishedQuest?: boolean;
    brokenStreakDays?: number;
    favoritedCollections?: number[];
    unreadSignals?: number;
  } = {},
): { hook: WinbackHookType; title: string; body: string } {
  if (activity.brokenStreakDays && activity.brokenStreakDays > 0) {
    return {
      hook: "streak_recovery",
      title: "Restore your PHASE streak",
      body: `Your ${activity.brokenStreakDays}-day streak is waiting to be rekindled. Return today for bonus rewards.`,
    };
  }

  if (activity.hasUnfinishedQuest) {
    return {
      hook: "unfinished_quest",
      title: "Your active quest awaits",
      body: "You have uncompleted quest objectives in the Forge. Complete your arc to claim PHASELQ.",
    };
  }

  if (activity.favoritedCollections && activity.favoritedCollections.length > 0) {
    return {
      hook: "new_world_drop",
      title: "New artifacts in worlds you follow",
      body: "New lore entries and editions have been forged in worlds in your collection.",
    };
  }

  return {
    hook: "general_digest",
    title: "What's new in the PHASE ecosystem",
    body: "Explore fresh drops, gauge emission votes, and community signals.",
  };
}

/**
 * Evaluates a wallet for winback campaign eligibility, cohort, and copy.
 */
export function evaluateWinbackCampaign(
  wallet: string,
  userState: {
    lastActiveMs: number;
    lastNotifiedMs?: number;
    activity?: {
      hasUnfinishedQuest?: boolean;
      brokenStreakDays?: number;
      favoritedCollections?: number[];
      unreadSignals?: number;
    };
  },
  experimentId = "winback_v1",
  nowMs = Date.now(),
): WinbackEvaluation {
  const { tier, daysDormant } = classifyWalletDormancy(userState.lastActiveMs, nowMs);
  const fatigue = checkFatigueCap(userState.lastNotifiedMs, nowMs);
  const cohort = assignExperimentCohort(wallet, experimentId);
  const hookInfo = determineWinbackHook(wallet, userState.activity);

  const isDormant = tier !== "active";
  const eligible = isDormant && fatigue.allowed;

  if (isDormant && !fatigue.allowed) {
    incSecurityCounter("winback_fatigue_suppressed");
  }

  if (eligible && cohort !== "control") {
    incSecurityCounter("winback_experiment_dispatched");
  }

  return {
    wallet,
    tier,
    daysDormant,
    eligible,
    cohort,
    hook: hookInfo.hook,
    title: hookInfo.title,
    body: hookInfo.body,
    fatigueSuppressed: !fatigue.allowed,
    cooldownRemainingDays: fatigue.waitDaysRemaining,
  };
}

/**
 * Reads historical winback dispatches from sidecar store.
 */
export async function getWinbackStore(): Promise<WinbackStore> {
  return readStore<WinbackStore>("winbackExperiments", () => ({ entries: {} }));
}

/**
 * Records a dispatched winback experiment notification for fatigue management.
 */
export async function recordWinbackDispatch(
  wallet: string,
  cohort: WinbackExperimentCohort,
  hook: WinbackHookType,
  experimentId = "winback_v1",
  dispatchedAt = Date.now(),
): Promise<WinbackHistoryEntry> {
  const filePath = serverDataJsonPath("winbackExperiments");
  const entry: WinbackHistoryEntry = {
    wallet,
    dispatchedAt,
    cohort,
    hook,
    experimentId,
  };

  await updateJsonFile<WinbackStore, void>(filePath, {
    read: (raw) => {
      const s = raw as WinbackStore | undefined;
      return { entries: s?.entries ?? {} };
    },
    mutate: (store) => {
      store.entries[wallet.toLowerCase()] = entry;
    },
  });

  return entry;
}
