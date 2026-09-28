import { readJsonFile, updateStore, updateStoreWithReader } from "@/lib/json-store";
import { serverDataJsonPath } from "@/lib/server-data-paths";
import { createNotification } from "@/lib/notification-store";

export type AchievementId =
  | "first_mint"
  | "collector_5"
  | "collector_10"
  | "first_collection"
  | "world_builder"
  | "narrator_10"
  | "signal_pioneer"
  | "community_voice"
  | "connector_10"
  | "daily_streak_7"
  | "daily_streak_30"
  | "phaselq_100";

export type Achievement = {
  id: AchievementId;
  unlocked_at: number;
  tx_evidence?: string;
};

type WalletAchievements = {
  unlocked: Achievement[];
  // counters for progress tracking
  mint_count?: number;
  daily_streak?: number;
  last_daily?: number;
  total_upvotes?: number;
  follower_count?: number;
  narrator_count?: number;
};

type AchievementStore = Record<string, WalletAchievements>;

const ACHIEVEMENT_NAMES: Record<AchievementId, string> = {
  first_mint: "First Artifact",
  collector_5: "Collector ×5",
  collector_10: "Collector ×10",
  first_collection: "Forge Master",
  world_builder: "World Builder",
  narrator_10: "Narrator ×10",
  signal_pioneer: "Signal Pioneer",
  community_voice: "Community Voice",
  connector_10: "Connector ×10",
  daily_streak_7: "Streak ×7",
  daily_streak_30: "Streak ×30",
  phaselq_100: "PHASELQ ×100",
};

/** Stellar G-addresses are case-insensitive on input; store them under one canonical uppercase key. */
function walletKey(wallet: string): string {
  return wallet.trim().toUpperCase();
}

function mergeEntries(
  a: WalletAchievements,
  b: WalletAchievements,
): WalletAchievements {
  const byId = new Map<AchievementId, Achievement>();
  for (const ach of [...a.unlocked, ...b.unlocked]) {
    const prev = byId.get(ach.id);
    if (!prev || ach.unlocked_at < prev.unlocked_at) byId.set(ach.id, ach);
  }
  const max = (x?: number, y?: number) =>
    x === undefined ? y : y === undefined ? x : Math.max(x, y);
  const latest = (b.last_daily ?? 0) > (a.last_daily ?? 0) ? b : a;
  return {
    unlocked: [...byId.values()],
    mint_count: max(a.mint_count, b.mint_count),
    daily_streak: latest.daily_streak,
    last_daily: latest.last_daily,
    total_upvotes: max(a.total_upvotes, b.total_upvotes),
    follower_count: max(a.follower_count, b.follower_count),
    narrator_count: max(a.narrator_count, b.narrator_count),
  };
}

/** Normalizes wallet keys and merges duplicate-cased rows, as the old reader did. */
function readAchievementStore(raw: unknown): AchievementStore {
  if (!raw || typeof raw !== "object") return {};
  const store: AchievementStore = {};
  for (const [wallet, entry] of Object.entries(raw as AchievementStore)) {
    const key = walletKey(wallet);
    store[key] = store[key] ? mergeEntries(store[key]!, entry) : entry;
  }
  return store;
}

async function readStore(): Promise<AchievementStore> {
  return readJsonFile<unknown>(
    serverDataJsonPath("achievements"),
    undefined,
  ).then(readAchievementStore);
}

/** Locked read-modify-write that normalizes wallet keys before mutating. */
function updateAchievementStore<R>(
  mutate: (store: AchievementStore) => R | Promise<R>,
): Promise<R> {
  return updateStoreWithReader<AchievementStore, R>(
    "achievements",
    readAchievementStore,
    mutate,
  );
}

function ensureEntry(
  store: AchievementStore,
  wallet: string,
): WalletAchievements {
  const key = walletKey(wallet);
  if (!store[key]) store[key] = { unlocked: [] };
  return store[key]!;
}

export async function getAchievements(wallet: string): Promise<Achievement[]> {
  const store = await readStore();
  return store[walletKey(wallet)]?.unlocked ?? [];
}

export async function getWalletData(
  wallet: string,
): Promise<WalletAchievements> {
  const store = await readStore();
  return store[walletKey(wallet)] ?? { unlocked: [] };
}

export async function unlockAchievement(
  wallet: string,
  id: AchievementId,
  evidence?: string,
): Promise<boolean> {
  const didUnlock = await updateAchievementStore((store) => {
    const entry = ensureEntry(store, wallet);
    if (entry.unlocked.some((a) => a.id === id)) return false; // idempotent
    entry.unlocked.push({ id, unlocked_at: Date.now(), tx_evidence: evidence });
    store[walletKey(wallet)] = entry;
    return true;
  });
  if (didUnlock) {
    // Notify (fire-and-forget) after the store lock is released.
    void createNotification(wallet, "achievement_unlocked", {
      achievement_id: id,
      achievement_name: ACHIEVEMENT_NAMES[id] ?? id,
    }).catch(() => {
      /* silent */
    });
  }
  return didUnlock;
}

/** Checks counters and unlocks newly earned achievements. Returns newly unlocked IDs. */
export async function checkAndUnlock(
  wallet: string,
  hints?: {
    mints?: number;
    has_collection?: boolean;
    has_world?: boolean;
    signal_posted?: boolean;
    upvote_delta?: number;
    follower_delta?: number;
    narrator_delta?: number;
    daily_claim?: boolean;
    phaselq_earned?: number;
  },
): Promise<AchievementId[]> {
  // The whole counter update and every unlock it triggers happen in ONE locked
  // mutation. Previously this read the store, let tryUnlock call
  // unlockAchievement (its own read-modify-write), then wrote this stale
  // snapshot back over the top — so checkAndUnlock reported unlocks to its
  // caller and sent "achievement unlocked" notifications for achievements that
  // were never persisted. Re-entering the store lock from inside a locked
  // mutation would deadlock, so unlocks are applied to the in-flight store.
  const newUnlocks = await updateAchievementStore((store) => {
    const entry = ensureEntry(store, wallet);
    const unlocked = new Set(entry.unlocked.map((a) => a.id));
    const newlyUnlocked: AchievementId[] = [];

    function tryUnlock(id: AchievementId) {
      if (unlocked.has(id)) return;
      entry.unlocked.push({ id, unlocked_at: Date.now() });
      unlocked.add(id);
      newlyUnlocked.push(id);
    }

    // Mint counts
    if (hints?.mints !== undefined) {
      entry.mint_count = (entry.mint_count ?? 0) + hints.mints;
      if (entry.mint_count >= 1) tryUnlock("first_mint");
      if (entry.mint_count >= 5) tryUnlock("collector_5");
      if (entry.mint_count >= 10) tryUnlock("collector_10");
    }

    // First collection
    if (hints?.has_collection) tryUnlock("first_collection");

    // World builder
    if (hints?.has_world) tryUnlock("world_builder");

    // Signal pioneer
    if (hints?.signal_posted) tryUnlock("signal_pioneer");

    // Upvotes
    if (hints?.upvote_delta !== undefined) {
      entry.total_upvotes = (entry.total_upvotes ?? 0) + hints.upvote_delta;
      if (entry.total_upvotes >= 25) tryUnlock("community_voice");
    }

    // Followers
    if (hints?.follower_delta !== undefined) {
      entry.follower_count = (entry.follower_count ?? 0) + hints.follower_delta;
      if (entry.follower_count >= 10) tryUnlock("connector_10");
    }

    // Narrator
    if (hints?.narrator_delta !== undefined) {
      entry.narrator_count = (entry.narrator_count ?? 0) + hints.narrator_delta;
      if (entry.narrator_count >= 10) tryUnlock("narrator_10");
    }

    // Daily streak
    if (hints?.daily_claim) {
      const now = Date.now();
      const last = entry.last_daily ?? 0;
      const dayMs = 86_400_000;
      const withinWindow = last > 0 && now - last < dayMs * 2;
      entry.daily_streak = withinWindow ? (entry.daily_streak ?? 0) + 1 : 1;
      entry.last_daily = now;
      if (entry.daily_streak >= 7) tryUnlock("daily_streak_7");
      if (entry.daily_streak >= 30) tryUnlock("daily_streak_30");
    }

    // PHASELQ (placeholder — would need tracking from faucet totals)
    // For now just check if they've earned any
    if (hints?.phaselq_earned !== undefined && hints.phaselq_earned >= 100) {
      tryUnlock("phaselq_100");
    }

    store[walletKey(wallet)] = entry;
    return newlyUnlocked;
  });

  // Notify after the store lock is released, matching unlockAchievement.
  for (const id of newUnlocks) {
    void createNotification(wallet, "achievement_unlocked", {
      achievement_id: id,
      achievement_name: ACHIEVEMENT_NAMES[id] ?? id,
    }).catch(() => { /* silent */ });
  }

  return newUnlocks;
}

// ─── phase-114: timeline visualization for world events ────────────────────
// Isolated, flag-gated. Achievement unlocks are the wallet's chronology of
// world events; previously only exposed as an unordered badge grid. When
// enabled, exposes unlocks ordered by unlocked_at for a timeline view.
// When flag off, callers keep using getAchievements() (zero regression).
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_114 / FEATURE_PHASE_114.

export function isTimelineVisualizationEnabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_114 ??
    process.env.FEATURE_PHASE_114 ??
    ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type TimelineEvent = {
  id: AchievementId;
  name: string;
  unlocked_at: number;
};

/** Returns the wallet's achievement unlocks ordered oldest-first, with display names attached. */
export async function getAchievementTimeline(
  wallet: string,
): Promise<TimelineEvent[]> {
  const achievements = await getAchievements(wallet);
  return achievements
    .slice()
    .sort((a, b) => a.unlocked_at - b.unlocked_at)
    .map((a) => ({
      id: a.id,
      name: ACHIEVEMENT_NAMES[a.id] ?? a.id,
      unlocked_at: a.unlocked_at,
    }));
}

// ── Issue #102: Relevance-based Feed Ranking (phase-84) ──────────────────────

export function isPhase84Enabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_84 ??
    process.env.FEATURE_PHASE_84 ??
    ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

type AchievementRelevance = {
  id: AchievementId;
  relevance: number;
  recency: number;
  score: number;
};

export async function getRelevanceRankedAchievements(
  wallet: string,
  viewerWallet?: string,
): Promise<AchievementRelevance[]> {
  if (!isPhase84Enabled()) {
    const achievements = await getAchievements(wallet);
    return achievements.map((a) => ({
      id: a.id,
      relevance: 0,
      recency: a.unlocked_at,
      score: a.unlocked_at,
    }));
  }

  const achievements = await getAchievements(wallet);
  const now = Date.now();
  const dayMs = 86400000;

  return achievements
    .map((achievement) => {
      const ageInDays = (now - achievement.unlocked_at) / dayMs;
      const recencyScore = Math.max(0, 30 - ageInDays) / 30;
      const baseRelevance = getAchievementImportance(achievement.id);
      const relevanceScore = baseRelevance * 0.6 + recencyScore * 0.4;

      return {
        id: achievement.id,
        relevance: baseRelevance,
        recency: achievement.unlocked_at,
        score: relevanceScore * 100,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function getAchievementImportance(id: AchievementId): number {
  const weights: Record<AchievementId, number> = {
    first_mint: 0.9,
    collector_10: 0.8,
    world_builder: 1.0,
    narrator_10: 0.85,
    connector_10: 0.75,
    daily_streak_30: 0.95,
    phaselq_100: 0.7,
    collector_5: 0.6,
    first_collection: 0.85,
    signal_pioneer: 0.7,
    community_voice: 0.65,
    daily_streak_7: 0.6,
  };
  return weights[id] ?? 0.5;
}
