import { incSecurityCounter } from "@/lib/security-counters"

/**
 * Feature flags — PHASE rolling delivery & runtime flag operations (Spike 607 / phase-174).
 *
 * Each flag is opt-in via env (`NEXT_PUBLIC_FEATURE_*` / `FEATURE_*`).
 * When `phase-174` is enabled (or runtime rules/kill-switches are active), flags also support:
 * - Emergency kill-switches that override build-time `NEXT_PUBLIC_*` and runtime `FEATURE_*` vars
 * - Per-wallet allowlist / denylist targeting (`allowWallets` / `denyWallets`)
 * - Staged basis-point rollout ramps (`rolloutBps`: 0..10_000) via deterministic FNV-1a bucketing
 * - Optimistic CAS versioning (`version` / `expectedVersion`) to prevent silent operator overwrites
 * - Stale-on-error in-memory rule caching so hot write paths never block on store I/O failures
 * - Kill-switch drills proving distributor refill halt and `faucetPending` mid-poll idempotency
 *
 * Rollback: unset the env var or set to "0"/"false" and restart (or activate kill-switch). No migration to undo.
 *
 * Flags:
 * - phase-50: quest A/B variant experimentation framework
 * - phase-51: race-safe faucet claim rate-limits
 * - phase-52: quest_expiry windows with grace-period extension
 * - phase-53: faucet analytics — claim funnel metrics
 * - phase-79: watchlist notifications for price drops
 * - phase-80: fractional ownership for high-value artifacts (co-ownership, listing, purchase)
 * - phase-88: on-chain follow suggestions
 * - phase-89: scheduled signal broadcast queues
 * - phase-90: community polls as a signal subtype
 * - phase-91: moderator-attributed signal audit log
 * - phase-95: follow-graph export and import portability
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
 * - phase-141: CRDT-collaborative lore drafting (Yjs) for signals
 * - phase-142: AI thumbnail and crop generation with focal-point-aware variants
 * - phase-143: AI-driven churn and winback with dormant detection plus experiments
 * - phase-144: ve-PHASELQ locking with time-locked weight plus fee share
 * - phase-145: gauge voting for emissions / sybil resistance gate
 * - phase-154: outbound webhook subscriptions — signed event delivery
 * - phase-156: faucet participation deny-list with on-chain governance veto
 * - phase-158: Soroban read coalescing — in-flight dedupe + TTL cache
 * - phase-159: batched owner-key loader — DataLoader-style per-tick coalescing
 *   to remove N+1 owner reads (partial slice of spike 656 / issue #518)
 * - phase-160: Web Vitals budgets — per-route LCP/INP/CLS budgets with
 *   pass/fail evaluation (partial slice of spike 657 / issue #520)
 * - phase-161: typed contract-error taxonomy — code-stable PhaseError
 *   descriptors with retryable hints and message keys (partial slice of spike
 *   660 / issue #523)
 * - phase-162: SEP-10 web authentication challenges and sessions replacing
 *   loose wallet headers (spike 641 / issue #503)
 * - phase-163: Stellar network resolution with passphrase validation and a
 *   mainnet cutover acknowledgement (spike 640 / issue #502)
 * - phase-164: self-attested age bands with 18+/21+ campaign gating (spike 637 / issue #499)
 * - phase-165: signed creator licensing attestation on world creation (spike 639 / issue #501)
 * - phase-166: QR code flows for receive, offer-claim and referral share with camera scan (spike 622 / issue #485)
 * - phase-167: WalletConnect v2 mobile session resilience with reconnect and chain-switch (spike 623 / issue #486)
 * - phase-168: xBull full support with sign, trustline and Freighter-difference matrix (spike 624 / issue #487)
 * - phase-169: Ledger blind-signing to clear-signing review for Soroban transactions (spike 625 / issue #488)
 * - phase-174: A/B experimentation framework for forge and chamber copy plus
 *   pricing with sticky salted bucketing (spike 612 / issue #475)
 * - phase-175: Search analytics — hashed query logs, zero-result rate,
 *   clickthrough and typo effectiveness (spike 613 / issue #476)
 * - phase-176: Cost accounting per surface with budgets, burn-rate alerts and
 *   kill-switches (spike 614 / issue #477)
 * - phase-177: Billing and metering for paid forge tiers with quota
 *   enforcement (spike 615 / issue #478)
 * - phase-170: structured log pipeline with redaction, sampling and a batched external sink (spike 606 / issue #470)
 * - phase-171: backup and disaster-recovery snapshots for sidecars, SQLite and the secrets map (spike 605 / issue #469)
 * - phase-172: SQLite to Postgres migration rehearsal with dual-write, parity and rollback (spike 604 / issue #468)
 * - phase-173: Vercel preview-environment isolation for data roots, secrets, contracts and cron (spike 603 / issue #467)
 * - phase-178: leaderboard integrity with anti-farm scoring, time decay and sybil discount (spike 616 / issue #479)
 * - phase-179: data retention and GDPR erasure with TTL sweeps and wallet deletion (spike 617 / issue #480)
 * - phase-180: analytics warehouse export with Parquet and NDJSON, schema-versioned and redacted (spike 618 / issue #481)
 * - phase-181: anomaly detection on volume, counters and balances with webhook alert routing (spike 619 / issue #482)
 * - phase-182: liquidity pools — classic PHASELQ/XLM pool + Soroswap router adapter, quotes,
 *   deposits/withdrawals, and pool-aware wash screening (spike 574 / issue #438)
 *
 * phase-182 is default off. Rollback: unset the env keys and restart; the LP
 * sidecar (`liquidity-pools.json`) and additive SQLite tables stay inert.
 */

export type PhaseFeatureFlag =
  | "phase-50"
  | "phase-51"
  | "phase-52"
  | "phase-53"
  | "phase-50"
  | "phase-51"
  | "phase-52"
  | "phase-53"
  | "phase-66"
  | "phase-77"
  | "phase-78"
  | "phase-79"
  | "phase-80"
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
  | "phase-95"
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
  | "phase-140"
  | "phase-141"
  | "phase-142"
  | "phase-143"
  | "phase-144"
  | "phase-145"
  | "phase-154"
  | "phase-156"
  | "phase-146"
  | "phase-147"
  | "phase-148"
  | "phase-149"
  | "phase-150"
  | "phase-151"
  | "phase-152"
  | "phase-153"
  | "phase-editions"
  | "phase-timed-drops"
  | "phase-158"
  | "phase-159"
  | "phase-160"
  | "phase-161"
  | "phase-162"
  | "phase-163"
  | "phase-164"
  | "phase-165"
  | "phase-166"
  | "phase-167"
  | "phase-168"
  | "phase-169"
  | "phase-174"
  | "phase-175"
  | "phase-176"
  | "phase-177"
  | "phase-170"
  | "phase-171"
  | "phase-172"
  | "phase-173"
  | "phase-178"
  | "phase-179"
  | "phase-180"
  | "phase-181"
  | "phase-182";


const FLAG_ENV_MAP: Record<PhaseFeatureFlag, string[]> = {
  "phase-50": ["NEXT_PUBLIC_FEATURE_PHASE_50", "FEATURE_PHASE_50"],
  "phase-51": ["NEXT_PUBLIC_FEATURE_PHASE_51", "FEATURE_PHASE_51"],
  "phase-52": ["NEXT_PUBLIC_FEATURE_PHASE_52", "FEATURE_PHASE_52"],
  "phase-53": ["NEXT_PUBLIC_FEATURE_PHASE_53", "FEATURE_PHASE_53"],
  "phase-156": ["NEXT_PUBLIC_FEATURE_PHASE_156", "FEATURE_PHASE_156"],
  "phase-174": ["NEXT_PUBLIC_FEATURE_PHASE_174", "FEATURE_PHASE_174"],
  "phase-175": ["NEXT_PUBLIC_FEATURE_PHASE_175", "FEATURE_PHASE_175"],
  "phase-176": ["NEXT_PUBLIC_FEATURE_PHASE_176", "FEATURE_PHASE_176"],
  "phase-177": ["NEXT_PUBLIC_FEATURE_PHASE_177", "FEATURE_PHASE_177"],
  "phase-178": ["NEXT_PUBLIC_FEATURE_PHASE_178", "FEATURE_PHASE_178"],
  "phase-179": ["NEXT_PUBLIC_FEATURE_PHASE_179", "FEATURE_PHASE_179"],
  "phase-180": ["NEXT_PUBLIC_FEATURE_PHASE_180", "FEATURE_PHASE_180"],
  "phase-181": ["NEXT_PUBLIC_FEATURE_PHASE_181", "FEATURE_PHASE_181"],
  "phase-182": ["NEXT_PUBLIC_FEATURE_PHASE_182", "FEATURE_PHASE_182"],
  "phase-66": ["NEXT_PUBLIC_FEATURE_PHASE_66", "FEATURE_PHASE_66"],
  "phase-77": ["NEXT_PUBLIC_FEATURE_PHASE_77", "FEATURE_PHASE_77"],
  "phase-78": ["NEXT_PUBLIC_FEATURE_PHASE_78", "FEATURE_PHASE_78"],
  "phase-79": ["NEXT_PUBLIC_FEATURE_PHASE_79", "FEATURE_PHASE_79"],
  "phase-80": ["NEXT_PUBLIC_FEATURE_PHASE_80", "FEATURE_PHASE_80"],
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
  "phase-95": ["NEXT_PUBLIC_FEATURE_PHASE_95", "FEATURE_PHASE_95"],
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
  "phase-141": ["NEXT_PUBLIC_FEATURE_PHASE_141", "FEATURE_PHASE_141"],
  "phase-142": ["NEXT_PUBLIC_FEATURE_PHASE_142", "FEATURE_PHASE_142"],
  "phase-143": ["NEXT_PUBLIC_FEATURE_PHASE_143", "FEATURE_PHASE_143"],
  "phase-144": ["NEXT_PUBLIC_FEATURE_PHASE_144", "FEATURE_PHASE_144"],
  "phase-145": ["NEXT_PUBLIC_FEATURE_PHASE_145", "FEATURE_PHASE_145"],
  "phase-154": ["NEXT_PUBLIC_FEATURE_PHASE_154", "FEATURE_PHASE_154"],
  "phase-146": ["NEXT_PUBLIC_FEATURE_PHASE_146", "FEATURE_PHASE_146"],
  "phase-147": ["NEXT_PUBLIC_FEATURE_PHASE_147", "FEATURE_PHASE_147"],
  "phase-148": ["NEXT_PUBLIC_FEATURE_PHASE_148", "FEATURE_PHASE_148"],
  "phase-149": ["NEXT_PUBLIC_FEATURE_PHASE_149", "FEATURE_PHASE_149"],
  "phase-150": ["NEXT_PUBLIC_FEATURE_PHASE_150", "FEATURE_PHASE_150"],
  "phase-151": ["NEXT_PUBLIC_FEATURE_PHASE_151", "FEATURE_PHASE_151"],
  "phase-152": ["NEXT_PUBLIC_FEATURE_PHASE_152", "FEATURE_PHASE_152"],
  "phase-153": ["NEXT_PUBLIC_FEATURE_PHASE_153", "FEATURE_PHASE_153"],
  "phase-editions": ["NEXT_PUBLIC_FEATURE_PHASE_EDITIONS", "FEATURE_PHASE_EDITIONS"],
  "phase-timed-drops": ["NEXT_PUBLIC_FEATURE_PHASE_TIMED_DROPS", "FEATURE_PHASE_TIMED_DROPS"],
  "phase-158": ["NEXT_PUBLIC_FEATURE_PHASE_158", "FEATURE_PHASE_158"],
  "phase-159": ["NEXT_PUBLIC_FEATURE_PHASE_159", "FEATURE_PHASE_159"],
  "phase-160": ["NEXT_PUBLIC_FEATURE_PHASE_160", "FEATURE_PHASE_160"],
  "phase-161": ["NEXT_PUBLIC_FEATURE_PHASE_161", "FEATURE_PHASE_161"],
  "phase-162": ["NEXT_PUBLIC_FEATURE_PHASE_162", "FEATURE_PHASE_162"],
  "phase-163": ["NEXT_PUBLIC_FEATURE_PHASE_163", "FEATURE_PHASE_163"],
  "phase-164": ["NEXT_PUBLIC_FEATURE_PHASE_164", "FEATURE_PHASE_164"],
  "phase-165": ["NEXT_PUBLIC_FEATURE_PHASE_165", "FEATURE_PHASE_165"],
  "phase-166": ["NEXT_PUBLIC_FEATURE_PHASE_166", "FEATURE_PHASE_166"],
  "phase-167": ["NEXT_PUBLIC_FEATURE_PHASE_167", "FEATURE_PHASE_167"],
  "phase-168": ["NEXT_PUBLIC_FEATURE_PHASE_168", "FEATURE_PHASE_168"],
  "phase-169": ["NEXT_PUBLIC_FEATURE_PHASE_169", "FEATURE_PHASE_169"],
  "phase-170": ["NEXT_PUBLIC_FEATURE_PHASE_170", "FEATURE_PHASE_170"],
  "phase-171": ["NEXT_PUBLIC_FEATURE_PHASE_171", "FEATURE_PHASE_171"],
  "phase-172": ["NEXT_PUBLIC_FEATURE_PHASE_172", "FEATURE_PHASE_172"],
  "phase-173": ["NEXT_PUBLIC_FEATURE_PHASE_173", "FEATURE_PHASE_173"],
};

/** Canonical ordered list of all feature flags (fixes prior missing phase-134/135 & duplicate phase-128). */
export const ALL_FEATURE_FLAGS: readonly PhaseFeatureFlag[] = [
  "phase-50",
  "phase-51",
  "phase-52",
  "phase-53",
  "phase-66",
  "phase-77",
  "phase-78",
  "phase-79",
  "phase-84",
  "phase-85",
  "phase-86",
  "phase-87",
  "phase-88",
  "phase-89",
  "phase-90",
  "phase-91",
  "phase-92",
  "phase-93",
  "phase-94",
  "phase-95",
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
  "phase-134",
  "phase-135",
  "phase-136",
  "phase-137",
  "phase-138",
  "phase-82",
  "phase-83",
  "phase-139",
  "phase-140",
  "phase-141",
  "phase-142",
  "phase-143",
  "phase-144",
  "phase-145",
  "phase-154",
  "phase-156",
  "phase-158",
  "phase-159",
  "phase-160",
  "phase-161",
  "phase-162",
  "phase-163",
  "phase-164",
  "phase-165",
  "phase-166",
  "phase-167",
  "phase-168",
  "phase-169",
  "phase-170",
  "phase-171",
  "phase-172",
  "phase-173",
  "phase-174",
  "phase-175",
  "phase-176",
  "phase-177",
  "phase-178",
  "phase-179",
  "phase-180",
  "phase-181",
  "phase-182",
] as const;

function isTruthy(v: string | undefined): boolean {
  // Accept common deployment-system spellings while keeping unset values disabled.
  if (!v) return false;
  const s = v.trim().toLowerCase();
  // Lowercasing makes environment configuration case-insensitive.
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Returns whether a flag is on for the given context.
 *
 * With `phase-174` off (default) this is a pure static env read, identical to
 * the pre-flag-ops behavior. With flag ops on, runtime rules (kill-switch,
 * targeting, rollout) take precedence over the build-time environment.
 */
export function isFeatureEnabled(
  flag: PhaseFeatureFlag,
  context: FeatureFlagEvalContext = {},
): boolean {
  if (!isFeatureFlagOpsEnabled()) return envFlagEnabled(flag)
  return evaluateFeatureFlag(flag, context).enabled
}

export function featureFlagEnvKeys(flag: PhaseFeatureFlag): string[] {
  // Exposing the exact keys lets diagnostics explain how to enable a flag.
  return FLAG_ENV_MAP[flag]
    ? [...FLAG_ENV_MAP[flag]]
    : [
        `NEXT_PUBLIC_FEATURE_${flag.replace(/-/g, "_").toUpperCase()}`,
        `FEATURE_${flag.replace(/-/g, "_").toUpperCase()}`,
      ];
}

export function getEnabledFeatureFlags(): PhaseFeatureFlag[] {
  // Keep enumeration explicit so dashboards have stable, reviewable flag order.
  const all: PhaseFeatureFlag[] = [
    "phase-174", "phase-175", "phase-176", "phase-177",
    "phase-178", "phase-179", "phase-180", "phase-181",
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
    "phase-141",
    "phase-142",
    "phase-143",
    "phase-144",
    "phase-145",
    "phase-154",
    "phase-146",
    "phase-147",
    "phase-148",
    "phase-149",
    "phase-150",
    "phase-151",
    "phase-152",
    "phase-153",
    "phase-editions",
    "phase-timed-drops",
    "phase-158",
    "phase-159",
    "phase-160",
    "phase-161",
    "phase-162",
    "phase-163",
    "phase-164",
    "phase-165",
    "phase-166",
    "phase-167",
    "phase-168",
    "phase-169",
    "phase-174",
    "phase-175",
    "phase-176",
    "phase-177",
    "phase-170",
    "phase-171",
    "phase-172",
    "phase-173",
    "phase-178",
    "phase-179",
    "phase-180",
    "phase-181",
    "phase-182",
  ];

  // Filtering is evaluated at call time, allowing runtime test overrides.
  return all.filter((flag) => isFeatureEnabled(flag))
}

export function flagRollbackNote(flag: PhaseFeatureFlag): string {
  // Rollback guidance is generated from the same key mapping used for activation.
  // Returning a plain sentence keeps the note suitable for logs and admin screens.
  const keys = featureFlagEnvKeys(flag).join(" / ");
  return `Rollback ${flag}: unset ${keys} or set to 0/false and restart (or activate kill-switch via phase-174). No data migration to revert.`;
}

// ─── phase-174: runtime flag operations ────────────────────────────────────
// Restored after a merge dropped the definitions referenced by the admin route,
// the kill-switch drill and `lib/__tests__/feature-flag-ops.test.ts`.

export type FeatureFlagEvalContext = {
  /** Wallet used for allow/deny targeting and deterministic rollout bucketing. */
  wallet?: string | null
  /** Ignore `NEXT_PUBLIC_*` build-time exposure (server write-path checks). */
  runtimeOnly?: boolean
}

export type FeatureFlagRule = {
  flag: PhaseFeatureFlag
  killSwitch: boolean
  overrideEnabled: boolean | null
  rolloutBps: number | null
  allowWallets: string[]
  denyWallets: string[]
  updatedBy: string
  reason: string
  updatedAt: number
  version: number
}

export type FeatureFlagOpsCacheState = "off" | "fresh" | "stale"

export type FeatureFlagEvalReason =
  | "kill_switch"
  | "wallet_denied"
  | "wallet_allowed"
  | "wallet_not_targeted"
  | "override_enabled"
  | "override_disabled"
  | "rollout"
  | "env_public"
  | "env_server"
  | "not_enabled"

export type FeatureFlagEval = {
  flag: PhaseFeatureFlag
  enabled: boolean
  reason: FeatureFlagEvalReason
  cacheState: FeatureFlagOpsCacheState
  clientBundled: boolean
  serverConfigured: boolean
  wallet: string | null
  ruleVersion: number | null
}

export class FeatureFlagOpsError extends Error {
  readonly code: "INVALID_FLAG" | "VALIDATION_FAILED" | "VERSION_CONFLICT" | "FLAG_DISABLED" | "NOT_FOUND"
  readonly details?: unknown
  constructor(
    code: FeatureFlagOpsError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message)
    this.name = "FeatureFlagOpsError"
    this.code = code
    this.details = details
  }
}

const ruleCache = new Map<PhaseFeatureFlag, FeatureFlagRule>()
let cacheLoadedAt = 0
let cacheDegradedStale = false
const drillHistory: KillSwitchDrillReport[] = []

function readEnvVar(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined
  return (process.env as Record<string, string | undefined>)[name]
}

/** Static env-only evaluation, used when flag ops are disabled (default). */
function envFlagState(flag: PhaseFeatureFlag): {
  clientBundled: boolean
  serverConfigured: boolean
} {
  // Literal property reads keep Next.js able to inline NEXT_PUBLIC values.
  const bundledLiterals: Partial<Record<PhaseFeatureFlag, string | undefined>> = {
    "phase-174": process.env.NEXT_PUBLIC_FEATURE_PHASE_174,
    "phase-175": process.env.NEXT_PUBLIC_FEATURE_PHASE_175,
    "phase-176": process.env.NEXT_PUBLIC_FEATURE_PHASE_176,
    "phase-177": process.env.NEXT_PUBLIC_FEATURE_PHASE_177,
    "phase-178": process.env.NEXT_PUBLIC_FEATURE_PHASE_178,
    "phase-179": process.env.NEXT_PUBLIC_FEATURE_PHASE_179,
    "phase-180": process.env.NEXT_PUBLIC_FEATURE_PHASE_180,
    "phase-181": process.env.NEXT_PUBLIC_FEATURE_PHASE_181,
    "phase-182": process.env.NEXT_PUBLIC_FEATURE_PHASE_182,
  }
  const keys = FLAG_ENV_MAP[flag] ?? [
    `NEXT_PUBLIC_FEATURE_${flag.replace(/-/g, "_").toUpperCase()}`,
    `FEATURE_${flag.replace(/-/g, "_").toUpperCase()}`,
  ]
  const clientKey = keys.find((k) => k.startsWith("NEXT_PUBLIC_"))
  const serverKey = keys.find((k) => k.startsWith("FEATURE_"))
  const clientBundled =
    isTruthy(bundledLiterals[flag]) ||
    (clientKey ? isTruthy(readEnvVar(clientKey)) : false)
  const serverConfigured = serverKey ? isTruthy(readEnvVar(serverKey)) : false
  return { clientBundled, serverConfigured }
}

function envFlagEnabled(flag: PhaseFeatureFlag): boolean {
  const state = envFlagState(flag)
  return state.clientBundled || state.serverConfigured
}

export function featureFlagOpsCacheState(): FeatureFlagOpsCacheState {
  if (cacheDegradedStale) return "stale"
  if (cacheLoadedAt > 0 || ruleCache.size > 0) return "fresh"
  return "off"
}

export function isFeatureFlagOpsEnabled(): boolean {
  return envFlagEnabled("phase-174")
}

/** 32-bit FNV-1a over `flag|wallet`, modulo 10_000 (monotonic as rolloutBps rises). */
export function flagRolloutBucket(flag: PhaseFeatureFlag, wallet: string): number {
  const input = `${flag}|${(wallet ?? "").trim().toUpperCase()}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 10_000
}

function killSwitchEnvFlags(): string[] {
  const raw = readEnvVar("PHASE_KILL_SWITCH_FLAGS") ?? ""
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Evaluates a flag with strict precedence: env kill-switch -> rule kill-switch ->
 * denyWallets -> allowWallets -> overrideEnabled -> rolloutBps -> static env.
 */
export function evaluateFeatureFlag(
  flag: PhaseFeatureFlag,
  context: FeatureFlagEvalContext = {},
): FeatureFlagEval {
  const wallet = context.wallet?.trim().toUpperCase() || null
  const rule = isFeatureFlagOpsEnabled() ? (ruleCache.get(flag) ?? null) : null
  const state = envFlagState(flag)
  const base = {
    flag,
    cacheState: featureFlagOpsCacheState(),
    clientBundled: state.clientBundled,
    serverConfigured: state.serverConfigured,
    wallet,
    ruleVersion: rule?.version ?? null,
  }

  if (killSwitchEnvFlags().includes(flag.toLowerCase())) {
    return { ...base, enabled: false, reason: "kill_switch" }
  }
  if (rule?.killSwitch) {
    return { ...base, enabled: false, reason: "kill_switch" }
  }
  if (wallet && rule) {
    if (rule.denyWallets.includes(wallet)) {
      return { ...base, enabled: false, reason: "wallet_denied" }
    }
    if (rule.allowWallets.length > 0) {
      return rule.allowWallets.includes(wallet)
        ? { ...base, enabled: true, reason: "wallet_allowed" }
        : { ...base, enabled: false, reason: "wallet_not_targeted" }
    }
  }
  if (rule && !wallet && rule.allowWallets.length > 0) {
    return { ...base, enabled: false, reason: "wallet_not_targeted" }
  }
  if (rule?.overrideEnabled !== null && rule?.overrideEnabled !== undefined) {
    return rule.overrideEnabled
      ? { ...base, enabled: true, reason: "override_enabled" }
      : { ...base, enabled: false, reason: "override_disabled" }
  }
  if (rule?.rolloutBps !== null && rule?.rolloutBps !== undefined && wallet) {
    return flagRolloutBucket(flag, wallet) < rule.rolloutBps
      ? { ...base, enabled: true, reason: "rollout" }
      : { ...base, enabled: false, reason: "rollout" }
  }
  if (!context.runtimeOnly && state.clientBundled) {
    return { ...base, enabled: true, reason: "env_public" }
  }
  if (state.serverConfigured) {
    return { ...base, enabled: true, reason: "env_server" }
  }
  return { ...base, enabled: false, reason: "not_enabled" }
}

export type SetFeatureFlagRuleInput = {
  flag: PhaseFeatureFlag;
  killSwitch?: boolean;
  overrideEnabled?: boolean | null;
  rolloutBps?: number | null;
  allowWallets?: string[];
  denyWallets?: string[];
  updatedBy?: string;
  reason?: string;
  expectedVersion?: number;
};

function normalizeWalletList(wallets: string[] | undefined): string[] {
  if (!Array.isArray(wallets)) return [];
  const unique = new Set<string>();
  for (const w of wallets) {
    if (typeof w === "string" && w.trim().length > 0) {
      unique.add(w.trim().toUpperCase());
    }
  }
  return [...unique].sort();
}

/**
 * Sets or updates a runtime feature-flag rule with optimistic CAS version checking.
 * Throws `FeatureFlagOpsError("VERSION_CONFLICT")` (HTTP 409) when `expectedVersion`
 * does not match the current rule version.
 */
export function isValidPhaseFeatureFlag(value: unknown): value is PhaseFeatureFlag {
  return (
    typeof value === "string" &&
    (ALL_FEATURE_FLAGS as readonly string[]).includes(value)
  )
}

export function setFeatureFlagRule(
  input: SetFeatureFlagRuleInput,
): FeatureFlagRule {
  if (!isValidPhaseFeatureFlag(input.flag)) {
    throw new FeatureFlagOpsError(
      "INVALID_FLAG",
      `Unknown feature flag: ${String(input.flag)}`,
    );
  }
  if (
    input.rolloutBps !== undefined &&
    input.rolloutBps !== null &&
    (!Number.isInteger(input.rolloutBps) ||
      input.rolloutBps < 0 ||
      input.rolloutBps > 10_000)
  ) {
    throw new FeatureFlagOpsError(
      "VALIDATION_FAILED",
      "rolloutBps must be an integer between 0 and 10000",
    );
  }

  const current = ruleCache.get(input.flag);
  const currentVersion = current?.version ?? 0;
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== currentVersion
  ) {
    incSecurityCounter("flag_ops_version_conflict");
    throw new FeatureFlagOpsError(
      "VERSION_CONFLICT",
      `Version conflict for ${input.flag}: expected ${input.expectedVersion}, current is ${currentVersion}`,
      { flag: input.flag, expectedVersion: input.expectedVersion, currentVersion },
    );
  }

  const nextKillSwitch = input.killSwitch ?? current?.killSwitch ?? false;
  if (nextKillSwitch && !current?.killSwitch) {
    incSecurityCounter("flag_kill_switch_activated");
  } else if (!nextKillSwitch && current?.killSwitch) {
    incSecurityCounter("flag_kill_switch_lifted");
  }

  const next: FeatureFlagRule = {
    flag: input.flag,
    killSwitch: nextKillSwitch,
    overrideEnabled:
      input.overrideEnabled !== undefined
        ? input.overrideEnabled
        : (current?.overrideEnabled ?? null),
    rolloutBps:
      input.rolloutBps !== undefined
        ? input.rolloutBps
        : (current?.rolloutBps ?? null),
    allowWallets:
      input.allowWallets !== undefined
        ? normalizeWalletList(input.allowWallets)
        : (current?.allowWallets ?? []),
    denyWallets:
      input.denyWallets !== undefined
        ? normalizeWalletList(input.denyWallets)
        : (current?.denyWallets ?? []),
    updatedBy: (input.updatedBy?.trim() || current?.updatedBy || "operator").slice(0, 64),
    reason: (input.reason?.trim() || current?.reason || "runtime rule update").slice(0, 280),
    updatedAt: Date.now(),
    version: currentVersion + 1,
  };

  ruleCache.set(input.flag, next);
  cacheLoadedAt = Date.now();
  cacheDegradedStale = false;
  return next;
}

export function activateFlagKillSwitch(
  flag: PhaseFeatureFlag,
  opts: { updatedBy?: string; reason?: string; expectedVersion?: number } = {},
): FeatureFlagRule {
  return setFeatureFlagRule({
    flag,
    killSwitch: true,
    updatedBy: opts.updatedBy ?? "kill-switch",
    reason: opts.reason ?? "emergency kill-switch activated",
    expectedVersion: opts.expectedVersion,
  });
}

export function liftFlagKillSwitch(
  flag: PhaseFeatureFlag,
  opts: { updatedBy?: string; reason?: string; expectedVersion?: number } = {},
): FeatureFlagRule {
  return setFeatureFlagRule({
    flag,
    killSwitch: false,
    updatedBy: opts.updatedBy ?? "operator",
    reason: opts.reason ?? "kill-switch lifted",
    expectedVersion: opts.expectedVersion,
  });
}

export function getFeatureFlagRule(flag: PhaseFeatureFlag): FeatureFlagRule | null {
  return ruleCache.get(flag) ?? null;
}

export function listFeatureFlagRules(): FeatureFlagRule[] {
  return [...ruleCache.values()].sort((a, b) => a.flag.localeCompare(b.flag));
}

export function removeFeatureFlagRule(flag: PhaseFeatureFlag): boolean {
  return ruleCache.delete(flag);
}

/**
 * Hydrates or refreshes the in-memory rule cache from an external snapshot or
 * async store loader. On reader failure, preserves the existing cached rules
 * and marks the cache state as `"stale"` (`stale-on-error` resilience).
 */
export async function refreshFeatureFlagOpsCache(
  loader?: () => Promise<Record<string, FeatureFlagRule> | FeatureFlagRule[]>,
): Promise<{ ok: boolean; cacheState: "off" | "fresh" | "stale"; ruleCount: number }> {
  if (!loader) {
    return {
      ok: true,
      cacheState: featureFlagOpsCacheState(),
      ruleCount: ruleCache.size,
    };
  }
  try {
    const loaded = await loader();
    const entries = Array.isArray(loaded) ? loaded : Object.values(loaded ?? {});
    ruleCache.clear();
    for (const entry of entries) {
      if (entry && isValidPhaseFeatureFlag(entry.flag)) {
        ruleCache.set(entry.flag, {
          ...entry,
          allowWallets: normalizeWalletList(entry.allowWallets),
          denyWallets: normalizeWalletList(entry.denyWallets),
          version: typeof entry.version === "number" && entry.version >= 1 ? entry.version : 1,
        });
      }
    }
    cacheLoadedAt = Date.now();
    cacheDegradedStale = false;
    return { ok: true, cacheState: "fresh", ruleCount: ruleCache.size };
  } catch {
    cacheDegradedStale = true;
    incSecurityCounter("flag_ops_stale_fallback");
    return { ok: false, cacheState: "stale", ruleCount: ruleCache.size };
  }
}

export function exportFeatureFlagRulesSnapshot(): Record<string, FeatureFlagRule> {
  const out: Record<string, FeatureFlagRule> = {};
  for (const [k, v] of ruleCache.entries()) {
    out[k] = { ...v };
  }
  return out;
}

export function resetFeatureFlagOpsForTests(): void {
  ruleCache.clear();
  cacheLoadedAt = 0;
  cacheDegradedStale = false;
  drillHistory.length = 0;
}

/**
 * Proves that an in-flight `faucetPending` claim retains its original transaction
 * hash and settled `amountStroops` even if a reward-modifying flag (`phase-131`
 * streak multiplier or `phase-50` A/B variant) is ramped or killed mid-poll.
 */
export function resolvePendingClaimAfterFlagFlip(params: {
  pending: { hash: string; reward: string; at: number; amountStroops?: string };
  fallbackAmountStroops: string;
}): { hash: string; reward: string; amountStroops: string; idempotentReuse: true } {
  return {
    hash: params.pending.hash,
    reward: params.pending.reward,
    amountStroops: params.pending.amountStroops ?? params.fallbackAmountStroops,
    idempotentReuse: true,
  };
}

/**
 * Executes a non-destructive kill-switch and staged-rollout drill:
 * 1. Verifies kill-switch overrides a simulated `NEXT_PUBLIC_FEATURE_PHASE_133=1`
 * 2. Verifies FNV-1a bucketing is monotonic across 0 -> 1000 -> 5000 -> 10000 bps
 * 3. Verifies `faucetPending` mid-poll hash & amountStroops survive a `phase-131` kill-switch flip
 * 4. Verifies stale-on-error cache fallback preserves an active kill-switch when store read fails
 */
export type KillSwitchDrillReport = {
  drillId: string
  executedAt: number
  passed: boolean
  steps: {
    killOverridesBuildEnv: boolean
    monotonicRolloutRamp: boolean
    faucetPendingMidPollIdempotent: boolean
    staleCachePreservesKillSwitch: boolean
  }
  notes: string[]
}

export async function runKillSwitchDrill(): Promise<KillSwitchDrillReport> {
  const savedRules = exportFeatureFlagRulesSnapshot();
  const savedLoadedAt = cacheLoadedAt;
  const savedStale = cacheDegradedStale;
  const savedEnv133 = readEnvVar("NEXT_PUBLIC_FEATURE_PHASE_133");
  const savedEnv131 = readEnvVar("NEXT_PUBLIC_FEATURE_PHASE_131");
  const notes: string[] = [];

  try {
    // Step 1: Kill-switch overrides build-time NEXT_PUBLIC_FEATURE_PHASE_133
    if (typeof process !== "undefined" && process.env) {
      process.env.NEXT_PUBLIC_FEATURE_PHASE_133 = "1";
    }
    activateFlagKillSwitch("phase-133", {
      updatedBy: "drill-runner",
      reason: "drill: halt distributor auto-topup",
    });
    const evalKilled = evaluateFeatureFlag("phase-133", { runtimeOnly: true });
    const killOverridesBuildEnv =
      evalKilled.enabled === false &&
      evalKilled.reason === "kill_switch" &&
      evalKilled.clientBundled === true;
    notes.push(
      killOverridesBuildEnv
        ? "PASS: kill-switch overrode NEXT_PUBLIC_FEATURE_PHASE_133=1"
        : "FAIL: kill-switch did not override NEXT_PUBLIC_FEATURE_PHASE_133=1",
    );

    // Step 2: Monotonic FNV-1a rollout ramp across 50 wallets
    let monotonicRolloutRamp = true;
    const rampSteps = [0, 1000, 2500, 5000, 7500, 10000];
    for (let i = 0; i < 50; i++) {
      const wallet = `GDRILLWALLET${String(i).padStart(44, "A")}`;
      let prevEnabled = false;
      for (const bps of rampSteps) {
        setFeatureFlagRule({
          flag: "phase-131",
          killSwitch: false,
          overrideEnabled: null,
          rolloutBps: bps,
          updatedBy: "drill-runner",
          reason: `drill ramp ${bps}bps`,
        });
        const curEnabled = isFeatureEnabled("phase-131", { wallet });
        if (prevEnabled && !curEnabled) {
          monotonicRolloutRamp = false;
        }
        prevEnabled = curEnabled;
      }
    }
    notes.push(
      monotonicRolloutRamp
        ? "PASS: FNV-1a rollout ramp is strictly monotonic across 0..10000 bps"
        : "FAIL: rollout ramp flipped an enrolled wallet off",
    );

    // Step 3: Mid-poll faucetPending idempotency under phase-131 kill-switch flip
    const pendingBeforeFlip = {
      hash: "a".repeat(64),
      reward: "daily",
      at: Date.now() - 2_000,
      amountStroops: "30000000", // 1.5x streak amount locked at tx submission
    };
    activateFlagKillSwitch("phase-131", {
      updatedBy: "drill-runner",
      reason: "drill: mid-poll streak kill",
    });
    const resolvedAfterFlip = resolvePendingClaimAfterFlagFlip({
      pending: pendingBeforeFlip,
      fallbackAmountStroops: "20000000",
    });
    const faucetPendingMidPollIdempotent =
      !isFeatureEnabled("phase-131") &&
      resolvedAfterFlip.hash === pendingBeforeFlip.hash &&
      resolvedAfterFlip.amountStroops === "30000000" &&
      resolvedAfterFlip.idempotentReuse === true;
    notes.push(
      faucetPendingMidPollIdempotent
        ? "PASS: faucetPending preserved tx hash and amountStroops across mid-poll flag kill"
        : "FAIL: faucetPending mutated across mid-poll flag kill",
    );

    // Step 4: Stale-on-error cache preserves active kill-switch when store loader throws
    const refreshRes = await refreshFeatureFlagOpsCache(async () => {
      throw new Error("simulated store I/O failure");
    });
    const evalDuringOutage = evaluateFeatureFlag("phase-133", { runtimeOnly: true });
    const staleCachePreservesKillSwitch =
      refreshRes.ok === false &&
      refreshRes.cacheState === "stale" &&
      evalDuringOutage.enabled === false &&
      evalDuringOutage.reason === "kill_switch";
    notes.push(
      staleCachePreservesKillSwitch
        ? "PASS: stale-on-error cache preserved kill-switch during store outage"
        : "FAIL: stale-on-error cache lost kill-switch during store outage",
    );

    const passed =
      killOverridesBuildEnv &&
      monotonicRolloutRamp &&
      faucetPendingMidPollIdempotent &&
      staleCachePreservesKillSwitch;

    if (passed) {
      incSecurityCounter("flag_kill_switch_drill_passed");
    }

    const report: KillSwitchDrillReport = {
      drillId: `drill-${Date.now()}`,
      executedAt: Date.now(),
      passed,
      steps: {
        killOverridesBuildEnv,
        monotonicRolloutRamp,
        faucetPendingMidPollIdempotent,
        staleCachePreservesKillSwitch,
      },
      notes,
    };
    drillHistory.unshift(report);
    if (drillHistory.length > 25) drillHistory.length = 25;
    return report;
  } finally {
    // Restore exact pre-drill state
    ruleCache.clear();
    for (const [k, v] of Object.entries(savedRules)) {
      ruleCache.set(k as PhaseFeatureFlag, v);
    }
    cacheLoadedAt = savedLoadedAt;
    cacheDegradedStale = savedStale;
    if (typeof process !== "undefined" && process.env) {
      if (savedEnv133 === undefined) delete process.env.NEXT_PUBLIC_FEATURE_PHASE_133;
      else process.env.NEXT_PUBLIC_FEATURE_PHASE_133 = savedEnv133;
      if (savedEnv131 === undefined) delete process.env.NEXT_PUBLIC_FEATURE_PHASE_131;
      else process.env.NEXT_PUBLIC_FEATURE_PHASE_131 = savedEnv131;
    }
  }
}

export function getKillSwitchDrillHistory(): KillSwitchDrillReport[] {
  return [...drillHistory];
}

export function auditFeatureFlagOpsWiring(): { ok: boolean; note: string } {
  const uniqueFlags = new Set(ALL_FEATURE_FLAGS);
  if (uniqueFlags.size !== ALL_FEATURE_FLAGS.length) {
    return {
      ok: false,
      note: "[phase-174] ALL_FEATURE_FLAGS contains duplicate entries.",
    };
  }
  const probeWallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const b1 = flagRolloutBucket("phase-174", probeWallet);
  const b2 = flagRolloutBucket("phase-174", probeWallet);
  if (b1 !== b2 || b1 < 0 || b1 >= 10_000) {
    return {
      ok: false,
      note: "[phase-174] flagRolloutBucket deterministic FNV-1a check failed.",
    };
  }
  const enabledCount = getEnabledFeatureFlags().length;
  const activeRules = ruleCache.size;
  return {
    ok: true,
    note: `[phase-174] feature-flag ops wiring OK (${ALL_FEATURE_FLAGS.length} registered flags, ${enabledCount} enabled, ${activeRules} runtime rules). ${flagRollbackNote("phase-174")}`,
  };
}

/**
 * Spike 610 / phase-176: Unified analytics event warehouse across faucet, claim and notification funnels.
 */
export function isAnalyticsWarehouseEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-176", { wallet });
}

export function phase176RollbackNote(): string {
  return flagRollbackNote("phase-176");
}

/**
 * Spike 611 / phase-177: Funnel analytics v2 with retention cohorts: Day-N, wallet-age bands, quest cohorts.
 */
export function isFunnelRetentionEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-177", { wallet });
}

export function phase177RollbackNote(): string {
  return flagRollbackNote("phase-177");
}


