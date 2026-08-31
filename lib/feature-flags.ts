/**
 * Feature flags — PHASE rolling delivery.
 *
 * Each flag is opt-in via env. Supports both server and client where needed.
 * Rollback: unset the env var or set to "0"/"false" and restart. No migration to undo.
 *
 * Flags:
 * - phase-79: watchlist notifications for price drops
 * - phase-88: on-chain follow suggestions
 * - phase-89: scheduled signal broadcast queues
 * - phase-90: community polls as a signal subtype
 * - phase-91: moderator-attributed signal audit log
 * - phase-107: AI story-arc continuity validator across artifacts
 * - phase-111: localized narrative caching per language pack
 * - phase-113: narrative content moderation with takedown flow
 * - phase-114: timeline visualization for world events (achievements)
 * - phase-121: gateway health dashboard with latency scoring
 * - phase-122: off-chain metadata delta storage
 * - phase-123: IPFS timeout fallback chain
 * - phase-124: metadata version migration tool
 * - phase-100: creator profile view analytics
 * - phase-118: SEP-50 metadata validation before pin
 * - phase-127: content-hash deduplication for repeated assets
 * - phase-128: IPFS gateway auth rotation for private pinning tiers
 * - phase-130: quest progress snapshotting to survive serverless cold starts
 * - phase-131: quest streak daily-claim multiplier with decay rules
 * - phase-132: referral-quest attribution with anti-gaming caps
 * - phase-133: faucet distributor balance auto-top-up via Mercury
 * - phase-134: rate-limit-aware batch trustline submission to Horizon
 * - phase-135: cached wallet/explore NFT ownership index with stale-on-error fallback
 * - phase-136: per-CID IPFS gateway resolution cache with TTL + gateway health scoring
 * - phase-137: structured error taxonomy for profile avatar / x402 invoice failures
 * - phase-138: cost attribution ledger per follow/forge request for treasury accounting
 * - phase-82: signal edit history with word-level version diffing
 * - phase-83: emoji-reaction aggregation on signals with per-wallet rate limits
 * - phase-139: collection-level offer books aggregated from token offers + bulk bid
 * - phase-140: royalty enforcement on secondary sales via a creator/seller split
 */

export type PhaseFeatureFlag =
  | "phase-66"
  | "phase-77"
  | "phase-78"
  | "phase-79"
  | "phase-84"
  | "phase-85"
  | "phase-86"
  | "phase-87"
  | "phase-88"
  | "phase-89"
  | "phase-90"
  | "phase-91"
  | "phase-92"
  | "phase-93"
  | "phase-94"
  | "phase-98"
  | "phase-100"
  | "phase-104"
  | "phase-105"
  | "phase-106"
  | "phase-107"
  | "phase-108"
  | "phase-109"
  | "phase-110"
  | "phase-111"
  | "phase-112"
  | "phase-113"
  | "phase-114"
  | "phase-115"
  | "phase-116"
  | "phase-117"
  | "phase-118"
  | "phase-119"
  | "phase-120"
  | "phase-121"
  | "phase-122"
  | "phase-123"
  | "phase-124"
  | "phase-127"
  | "phase-128"
  | "phase-128"
  | "phase-130"
  | "phase-131"
  | "phase-132"
  | "phase-133"
  | "phase-134"
  | "phase-135"
  | "phase-136"
  | "phase-137"
  | "phase-138"
  | "phase-82"
  | "phase-83"
  | "phase-139"
  | "phase-140";

const FLAG_ENV_MAP: Record<PhaseFeatureFlag, string[]> = {
  "phase-66": ["NEXT_PUBLIC_FEATURE_PHASE_66", "FEATURE_PHASE_66"],
  "phase-77": ["NEXT_PUBLIC_FEATURE_PHASE_77", "FEATURE_PHASE_77"],
  "phase-78": ["NEXT_PUBLIC_FEATURE_PHASE_78", "FEATURE_PHASE_78"],
  "phase-79": ["NEXT_PUBLIC_FEATURE_PHASE_79", "FEATURE_PHASE_79"],
  "phase-84": ["NEXT_PUBLIC_FEATURE_PHASE_84", "FEATURE_PHASE_84"],
  "phase-85": ["NEXT_PUBLIC_FEATURE_PHASE_85", "FEATURE_PHASE_85"],
  "phase-86": ["NEXT_PUBLIC_FEATURE_PHASE_86", "FEATURE_PHASE_86"],
  "phase-87": ["NEXT_PUBLIC_FEATURE_PHASE_87", "FEATURE_PHASE_87"],
  "phase-88": ["NEXT_PUBLIC_FEATURE_PHASE_88", "FEATURE_PHASE_88"],
  "phase-89": ["NEXT_PUBLIC_FEATURE_PHASE_89", "FEATURE_PHASE_89"],
  "phase-90": ["NEXT_PUBLIC_FEATURE_PHASE_90", "FEATURE_PHASE_90"],
  "phase-91": ["NEXT_PUBLIC_FEATURE_PHASE_91", "FEATURE_PHASE_91"],
  "phase-92": ["NEXT_PUBLIC_FEATURE_PHASE_92", "FEATURE_PHASE_92"],
  "phase-93": ["NEXT_PUBLIC_FEATURE_PHASE_93", "FEATURE_PHASE_93"],
  "phase-94": ["NEXT_PUBLIC_FEATURE_PHASE_94", "FEATURE_PHASE_94"],
  "phase-98": ["NEXT_PUBLIC_FEATURE_PHASE_98", "FEATURE_PHASE_98"],
  "phase-100": ["NEXT_PUBLIC_FEATURE_PHASE_100", "FEATURE_PHASE_100"],
  "phase-104": ["NEXT_PUBLIC_FEATURE_PHASE_104", "FEATURE_PHASE_104"],
  "phase-105": ["NEXT_PUBLIC_FEATURE_PHASE_105", "FEATURE_PHASE_105"],
  "phase-106": ["NEXT_PUBLIC_FEATURE_PHASE_106", "FEATURE_PHASE_106"],
  "phase-107": ["NEXT_PUBLIC_FEATURE_PHASE_107", "FEATURE_PHASE_107"],
  "phase-108": ["NEXT_PUBLIC_FEATURE_PHASE_108", "FEATURE_PHASE_108"],
  "phase-109": ["NEXT_PUBLIC_FEATURE_PHASE_109", "FEATURE_PHASE_109"],
  "phase-110": ["NEXT_PUBLIC_FEATURE_PHASE_110", "FEATURE_PHASE_110"],
  "phase-111": ["NEXT_PUBLIC_FEATURE_PHASE_111", "FEATURE_PHASE_111"],
  "phase-112": ["NEXT_PUBLIC_FEATURE_PHASE_112", "FEATURE_PHASE_112"],
  "phase-113": ["NEXT_PUBLIC_FEATURE_PHASE_113", "FEATURE_PHASE_113"],
  "phase-114": ["NEXT_PUBLIC_FEATURE_PHASE_114", "FEATURE_PHASE_114"],
  "phase-115": ["NEXT_PUBLIC_FEATURE_PHASE_115", "FEATURE_PHASE_115"],
  "phase-116": ["NEXT_PUBLIC_FEATURE_PHASE_116", "FEATURE_PHASE_116"],
  "phase-117": ["NEXT_PUBLIC_FEATURE_PHASE_117", "FEATURE_PHASE_117"],
  "phase-118": ["NEXT_PUBLIC_FEATURE_PHASE_118", "FEATURE_PHASE_118"],
  "phase-119": ["NEXT_PUBLIC_FEATURE_PHASE_119", "FEATURE_PHASE_119"],
  "phase-120": ["NEXT_PUBLIC_FEATURE_PHASE_120", "FEATURE_PHASE_120"],
  "phase-121": ["NEXT_PUBLIC_FEATURE_PHASE_121", "FEATURE_PHASE_121"],
  "phase-122": ["NEXT_PUBLIC_FEATURE_PHASE_122", "FEATURE_PHASE_122"],
  "phase-123": ["NEXT_PUBLIC_FEATURE_PHASE_123", "FEATURE_PHASE_123"],
  "phase-124": ["NEXT_PUBLIC_FEATURE_PHASE_124", "FEATURE_PHASE_124"],
  "phase-127": ["NEXT_PUBLIC_FEATURE_PHASE_127", "FEATURE_PHASE_127"],
  "phase-128": ["NEXT_PUBLIC_FEATURE_PHASE_128", "FEATURE_PHASE_128"],
  "phase-130": ["NEXT_PUBLIC_FEATURE_PHASE_130", "FEATURE_PHASE_130"],
  "phase-131": ["NEXT_PUBLIC_FEATURE_PHASE_131", "FEATURE_PHASE_131"],
  "phase-132": ["NEXT_PUBLIC_FEATURE_PHASE_132", "FEATURE_PHASE_132"],
  "phase-133": ["NEXT_PUBLIC_FEATURE_PHASE_133", "FEATURE_PHASE_133"],
  "phase-134": ["NEXT_PUBLIC_FEATURE_PHASE_134", "FEATURE_PHASE_134"],
  "phase-135": ["NEXT_PUBLIC_FEATURE_PHASE_135", "FEATURE_PHASE_135"],
  "phase-136": ["NEXT_PUBLIC_FEATURE_PHASE_136", "FEATURE_PHASE_136"],
  "phase-137": ["NEXT_PUBLIC_FEATURE_PHASE_137", "FEATURE_PHASE_137"],
  "phase-138": ["NEXT_PUBLIC_FEATURE_PHASE_138", "FEATURE_PHASE_138"],
  "phase-82": ["NEXT_PUBLIC_FEATURE_PHASE_82", "FEATURE_PHASE_82"],
  "phase-83": ["NEXT_PUBLIC_FEATURE_PHASE_83", "FEATURE_PHASE_83"],
  "phase-139": ["NEXT_PUBLIC_FEATURE_PHASE_139", "FEATURE_PHASE_139"],
  "phase-140": ["NEXT_PUBLIC_FEATURE_PHASE_140", "FEATURE_PHASE_140"],
};

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function isFeatureEnabled(flag: PhaseFeatureFlag): boolean {
  const keys = FLAG_ENV_MAP[flag] ?? [
    `NEXT_PUBLIC_FEATURE_${flag.replace(/-/g, "_").toUpperCase()}`,
    `FEATURE_${flag.replace(/-/g, "_").toUpperCase()}`,
  ];
  for (const k of keys) {
    const v =
      typeof process !== "undefined"
        ? (process.env as Record<string, string | undefined>)[k]
        : undefined;
    if (isTruthy(v)) return true;
  }
  return false;
}

export function featureFlagEnvKeys(flag: PhaseFeatureFlag): string[] {
  return FLAG_ENV_MAP[flag]
    ? [...FLAG_ENV_MAP[flag]]
    : [
        `NEXT_PUBLIC_FEATURE_${flag.replace(/-/g, "_").toUpperCase()}`,
        `FEATURE_${flag.replace(/-/g, "_").toUpperCase()}`,
      ];
}

export function getEnabledFeatureFlags(): PhaseFeatureFlag[] {
  const all: PhaseFeatureFlag[] = [
    "phase-66",
    "phase-77",
    "phase-78",
    "phase-79",
    "phase-88",
    "phase-89",
    "phase-90",
    "phase-91",
    "phase-92",
    "phase-93",
    "phase-94",
    "phase-98",
    "phase-100",
    "phase-104",
    "phase-105",
    "phase-106",
    "phase-107",
    "phase-108",
    "phase-109",
    "phase-110",
    "phase-111",
    "phase-112",
    "phase-113",
    "phase-114",
    "phase-115",
    "phase-116",
    "phase-117",
    "phase-118",
    "phase-119",
    "phase-120",
    "phase-121",
    "phase-122",
    "phase-123",
    "phase-124",
    "phase-127",
    "phase-128",
    "phase-130",
    "phase-131",
    "phase-132",
    "phase-133",
    "phase-136",
    "phase-137",
    "phase-138",
    "phase-82",
    "phase-83",
    "phase-139",
    "phase-140",
  ];
  return all.filter(isFeatureEnabled)
}

export function flagRollbackNote(flag: PhaseFeatureFlag): string {
  const keys = featureFlagEnvKeys(flag).join(" / ");
  return `Rollback ${flag}: unset ${keys} or set to 0/false and restart. No data migration to revert.`;
}
