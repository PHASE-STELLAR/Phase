import { readJsonFile, updateStore, updateStoreWithReader } from "@/lib/json-store";
import { serverDataJsonPath } from "@/lib/server-data-paths";
import { createNotification } from "@/lib/notification-store";
import { isAnalyticsWarehouseEnabled, recordWarehouseEvent } from "@/lib/analytics-warehouse";

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

    if (isAnalyticsWarehouseEnabled(wallet)) {
      void recordWarehouseEvent({
        surface: "achievements",
        stage: "achievement_unlocked",
        wallet,
        metadata: {
          achievement_id: id,
          achievement_name: ACHIEVEMENT_NAMES[id] ?? id,
          tx_evidence: evidence,
        },
      }).catch(() => {});
    }
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

export type TimelinePage = {
  events: TimelineEvent[];
  /** Opaque cursor for the next page; absent when this is the last page. */
  next_cursor?: string;
  /** Total number of achievements unlocked (all time). */
  closed_count: number;
};

export class AchievementVersionConflictError extends Error {
  constructor(message = "stale achievement store version") {
    super(message);
    this.name = "AchievementVersionConflictError";
  }
}

/** Stable comparator: oldest first; tie-break by lexicographic achievement id. */
function compareTimelineEvents(a: Achievement, b: Achievement): number {
  const dt = a.unlocked_at - b.unlocked_at;
  if (dt !== 0) return dt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Returns a paginated, chronologically ordered timeline of achievement unlocks.
 *
 * Pagination uses an opaque base64-encoded cursor that encodes
 * `{unlocked_at, id}` of the last-seen event. This guarantees no duplicates
 * across pages even when new achievements are unlocked between requests.
 *
 * Flag off → returns `{ events: [], closed_count: 0 }` with no next_cursor.
 */
export async function getAchievementTimeline(
  wallet: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<TimelinePage> {
  if (!isTimelineVisualizationEnabled()) {
    return { events: [], closed_count: 0 };
  }

  const achievements = await getAchievements(wallet);
  const sorted = achievements.slice().sort(compareTimelineEvents);
  const closed_count = sorted.length;

  const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 20)));

  // Decode cursor: { unlocked_at: number; id: string }
  let startAfter: { unlocked_at: number; id: string } | null = null;
  if (opts.cursor) {
    try {
      startAfter = JSON.parse(
        Buffer.from(opts.cursor, "base64url").toString("utf-8"),
      ) as { unlocked_at: number; id: string };
    } catch {
      startAfter = null;
    }
  }

  // Find the index to start from (exclusive of the cursor event).
  let startIdx = 0;
  if (startAfter) {
    const idx = sorted.findIndex(
      (a) =>
        a.unlocked_at === startAfter!.unlocked_at && a.id === startAfter!.id,
    );
    startIdx = idx === -1 ? 0 : idx + 1;
  }

  const page = sorted.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < sorted.length;

  const events: TimelineEvent[] = page.map((a) => ({
    id: a.id,
    name: ACHIEVEMENT_NAMES[a.id] ?? a.id,
    unlocked_at: a.unlocked_at,
  }));

  let next_cursor: string | undefined;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    next_cursor = Buffer.from(
      JSON.stringify({ unlocked_at: last.unlocked_at, id: last.id }),
    ).toString("base64url");
  }

  return { events, closed_count, next_cursor };
}

/**
 * Version-guarded unlock: writes `id` to `wallet`'s achievement list only if
 * the store's current version matches `expectedVersion`.  Throws
 * `AchievementVersionConflictError` (HTTP 409) on a mismatch.
 *
 * Version is a monotonic counter stored alongside the wallet entry.  Callers
 * read the version with `getAchievementVersion`, then pass it back here.
 */
export async function unlockAchievementVersioned(
  wallet: string,
  id: AchievementId,
  expectedVersion: number,
  evidence?: string,
): Promise<{ unlocked: boolean; version: number }> {
  return updateAchievementStore((store) => {
    const key = walletKey(wallet);
    const entry = ensureEntry(store, wallet);
    const currentVersion: number = (store as any)[`${key}__v`] ?? 0;
    if (currentVersion !== expectedVersion) {
      throw new AchievementVersionConflictError(
        `expected version ${expectedVersion}, current is ${currentVersion}`,
      );
    }
    const alreadyUnlocked = entry.unlocked.some((a) => a.id === id);
    if (!alreadyUnlocked) {
      entry.unlocked.push({ id, unlocked_at: Date.now(), tx_evidence: evidence });
      store[key] = entry;
    }
    const nextVersion = currentVersion + 1;
    (store as any)[`${key}__v`] = nextVersion;
    return { unlocked: !alreadyUnlocked, version: nextVersion };
  });
}

/** Returns the current version for a wallet's achievement entry (0 if never written). */
export async function getAchievementVersion(wallet: string): Promise<number> {
  const store = await readStore();
  return (store as any)[`${walletKey(wallet)}__v`] ?? 0;
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

/** Spike 611: Expose achievement unlock history for retention cohort joins. */
export async function getAchievementCohortData(): Promise<Record<string, Achievement[]>> {
  const store = await readStore();
  const out: Record<string, Achievement[]> = {};
  for (const [w, data] of Object.entries(store)) {
    out[w] = data.unlocked ?? [];
  }
  return out;
}

