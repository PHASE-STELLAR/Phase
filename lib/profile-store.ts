import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { serverDataJsonPath } from "@/lib/server-data-paths";
import { isFeatureEnabled } from "@/lib/feature-flags";

export type ProfileData = {
  display_name?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  avatar_token_id?: number;
  avatar_image_url?: string;
  locale?: ProfileLocale;
  updated_at: number;
};

type ProfileStore = Record<string, ProfileData>;

async function readStore(): Promise<ProfileStore> {
  try {
    const raw = await readFile(serverDataJsonPath("profileSocials"), "utf8");
    return JSON.parse(raw) as ProfileStore;
  } catch {
    return {};
  }
}

async function writeStore(data: ProfileStore): Promise<void> {
  const filePath = serverDataJsonPath("profileSocials");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function getProfile(wallet: string): Promise<ProfileData | null> {
  const store = await readStore();
  return store[wallet] ?? null;
}

export async function saveProfile(
  wallet: string,
  data: Omit<ProfileData, "updated_at">,
): Promise<ProfileData> {
  const store = await readStore();
  const entry: ProfileData = {
    ...data,
    updated_at: Date.now(),
  };
  store[wallet] = entry;
  await writeStore(store);
  return entry;
}

// phase-102: locale preference support for profile localization.
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_102 / FEATURE_PHASE_102 to keep default English presentation.
export const SUPPORTED_PROFILE_LOCALES = [
  "en",
  "es",
  "fr",
  "pt-BR",
  "yo",
  "ig",
] as const;
export type ProfileLocale = (typeof SUPPORTED_PROFILE_LOCALES)[number];
export const DEFAULT_PROFILE_LOCALE: ProfileLocale = "en";

export type ProfileLocaleResolution =
  | { ok: true; locale: ProfileLocale; featureEnabled: boolean }
  | {
      ok: false;
      locale: ProfileLocale;
      error: string;
      code: "FLAG_DISABLED" | "UNSUPPORTED_LOCALE";
      featureEnabled: boolean;
    };

export function isPhase102Enabled(): boolean {
  const value = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_102 ??
    process.env.FEATURE_PHASE_102 ??
    ""
  )
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function normalizeProfileLocale(
  locale: string | null | undefined,
): ProfileLocale | null {
  const normalized = (locale ?? "").trim();
  const match = SUPPORTED_PROFILE_LOCALES.find(
    (candidate) => candidate.toLowerCase() === normalized.toLowerCase(),
  );
  return match ?? null;
}

export function resolveProfileLocale(
  locale: string | null | undefined,
): ProfileLocaleResolution {
  const featureEnabled = isPhase102Enabled();
  if (!featureEnabled) {
    return {
      ok: false,
      locale: DEFAULT_PROFILE_LOCALE,
      error: "phase-102 flag disabled",
      code: "FLAG_DISABLED",
      featureEnabled,
    };
  }

  const normalized = normalizeProfileLocale(locale);
  if (!normalized) {
    return {
      ok: false,
      locale: DEFAULT_PROFILE_LOCALE,
      error: "Unsupported profile locale",
      code: "UNSUPPORTED_LOCALE",
      featureEnabled,
    };
  }

  return { ok: true, locale: normalized, featureEnabled };
}

export function localizeAvatarName(
  tokenId: number,
  locale: ProfileLocale = DEFAULT_PROFILE_LOCALE,
): string {
  const labels: Record<ProfileLocale, string> = {
    en: "Phase Artifact",
    es: "Artefacto Phase",
    fr: "Artefact Phase",
    "pt-BR": "Artefato Phase",
    yo: "Ohun Iranti Phase",
    ig: "Ihe Ncheta Phase",
  };
  return `${labels[locale] ?? labels.en} #${tokenId}`;
}

export async function getProfileLocalePreference(
  wallet: string,
): Promise<ProfileLocale> {
  const profile = await getProfile(wallet);
  return normalizeProfileLocale(profile?.locale) ?? DEFAULT_PROFILE_LOCALE;
}

export async function saveProfileLocalePreference(
  wallet: string,
  locale: string,
): Promise<ProfileLocaleResolution> {
  const resolved = resolveProfileLocale(locale);
  if (!resolved.ok) return resolved;

  const profile = await getProfile(wallet);
  await saveProfile(wallet, {
    ...(profile ?? {}),
    locale: resolved.locale,
  });
  return resolved;
}
// phase-96: human-readable profile handle resolution.
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_96 / FEATURE_PHASE_96 to keep handle lookup passive.
export type ProfileHandleRecord = {
  walletAddress: string;
  handle: string;
  updatedAt: number;
};

export type ProfileHandleResolution =
  | {
      ok: true;
      walletAddress: string;
      handle: string;
      updatedAt: number;
      featureEnabled: boolean;
    }
  | {
      ok: false;
      error: string;
      code: "FLAG_DISABLED" | "NOT_FOUND" | "INVALID_HANDLE" | "HANDLE_TAKEN";
      featureEnabled: boolean;
    };

const PROFILE_HANDLE_MIN = 3;
const PROFILE_HANDLE_MAX = 24;
const PROFILE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;

type ArtistAliasStore = Record<string, { alias: string; updatedAt: number }>;

function isPhase96Enabled(): boolean {
  const value = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_96 ??
    process.env.FEATURE_PHASE_96 ??
    ""
  )
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeProfileHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").replace(/\s+/g, "-").toLowerCase();
}

function validateProfileHandle(handle: string): string | null {
  if (
    handle.length < PROFILE_HANDLE_MIN ||
    handle.length > PROFILE_HANDLE_MAX
  ) {
    return `Handle must be ${PROFILE_HANDLE_MIN}-${PROFILE_HANDLE_MAX} characters.`;
  }
  if (!PROFILE_HANDLE_PATTERN.test(handle)) {
    return "Handle must use lowercase letters, numbers, dot, dash, or underscore and must start/end with a letter or number.";
  }
  return null;
}

async function readArtistAliasStore(): Promise<ArtistAliasStore> {
  try {
    const raw = await readFile(serverDataJsonPath("artistProfiles"), "utf8");
    const parsed = JSON.parse(raw) as ArtistAliasStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeArtistAliasStore(data: ArtistAliasStore): Promise<void> {
  const filePath = serverDataJsonPath("artistProfiles");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function resolveProfileHandle(
  handle: string,
): Promise<ProfileHandleResolution> {
  const featureEnabled = isPhase96Enabled();
  if (!featureEnabled) {
    return {
      ok: false,
      error: "phase-96 flag disabled",
      code: "FLAG_DISABLED",
      featureEnabled,
    };
  }

  const normalized = normalizeProfileHandle(handle);
  const invalid = validateProfileHandle(normalized);
  if (invalid) {
    return {
      ok: false,
      error: invalid,
      code: "INVALID_HANDLE",
      featureEnabled,
    };
  }

  const store = await readArtistAliasStore();
  const match = Object.entries(store).find(
    ([, profile]) => normalizeProfileHandle(profile.alias) === normalized,
  );
  if (!match) {
    return {
      ok: false,
      error: "Handle not found",
      code: "NOT_FOUND",
      featureEnabled,
    };
  }

  const [walletAddress, profile] = match;
  return {
    ok: true,
    walletAddress,
    handle: normalizeProfileHandle(profile.alias),
    updatedAt: profile.updatedAt,
    featureEnabled,
  };
}

export async function getProfileHandle(
  walletAddress: string,
): Promise<ProfileHandleRecord | null> {
  const store = await readArtistAliasStore();
  const profile = store[walletAddress];
  if (!profile) return null;
  return {
    walletAddress,
    handle: normalizeProfileHandle(profile.alias),
    updatedAt: profile.updatedAt,
  };
}

export async function saveProfileHandle(
  walletAddress: string,
  handle: string,
): Promise<ProfileHandleResolution> {
  const featureEnabled = isPhase96Enabled();
  const normalized = normalizeProfileHandle(handle);
  const invalid = validateProfileHandle(normalized);
  if (invalid) {
    return {
      ok: false,
      error: invalid,
      code: "INVALID_HANDLE",
      featureEnabled,
    };
  }

  const store = await readArtistAliasStore();
  const taken = Object.entries(store).find(
    ([wallet, profile]) =>
      wallet !== walletAddress &&
      normalizeProfileHandle(profile.alias) === normalized,
  );
  if (taken) {
    return {
      ok: false,
      error: "Handle is already linked to another wallet",
      code: "HANDLE_TAKEN",
      featureEnabled,
    };
  }

  const updatedAt = Date.now();
  store[walletAddress] = { alias: normalized, updatedAt };
  await writeArtistAliasStore(store);
  return {
    ok: true,
    walletAddress,
    handle: normalized,
    updatedAt,
    featureEnabled,
  };
}
// ??? phase-117: multi-gateway IPFS pinning with redundancy ??????????????????
// Isolated, flag-gated. Single gateway outage drops metadata previously.
// When enabled, avatar pinning uses quorum across gateways and avatar reads
// try fallback gateways with checksum verification. When flag off, legacy
// single-gateway behavior (zero regression).
//
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_117 / FEATURE_PHASE_117.

export function isProfilePinningRedundancyEnabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_117 ??
    process.env.FEATURE_PHASE_117 ??
    ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export const AvatarPinRequestSchema = z.object({
  tokenId: z.number().int().min(1).max(1_000_000),
  imageUrl: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .url()
    .or(
      z
        .string()
        .trim()
        .regex(/^ipfs:\/\//),
    ),
  wallet: z.string().trim().min(10).max(56),
  quorum: z.number().int().min(1).max(3).optional(),
});

export type AvatarPinRequest = z.infer<typeof AvatarPinRequestSchema>;

export type AvatarPinResult =
  | {
      ok: true;
      cid: string;
      uri: string;
      checksum: string;
      quorum: number;
      achieved: number;
      verified: boolean;
    }
  | {
      ok: false;
      error: string;
      code: string;
      achieved?: number;
      quorum?: number;
    };

export const ProfileAvatarFetchSchema = z.object({
  wallet: z.string().trim().min(10).max(56),
});

/**
 * Pins an avatar image with redundancy across gateways.
 * Uses lib/ipfs-pinning pinWithRedundancy under the hood.
 * When flag off, falls back to single Pinata pin (legacy).
 */
export async function pinAvatarWithRedundancy(
  imageBlob: Blob,
  opts: {
    quorum?: number;
    fileName?: string;
    expectedChecksum?: string | null;
  } = {},
): Promise<AvatarPinResult> {
  if (!isProfilePinningRedundancyEnabled()) {
    // legacy: single pin via /api/ipfs style ? return not-enabled code
    return {
      ok: false,
      error: "phase-117 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_117=1)",
      code: "FLAG_DISABLED",
    };
  }
  const jwt = (
    process.env.PINATA_JWT ??
    process.env.PINATA_API_JWT ??
    ""
  ).trim();
  if (!jwt)
    return {
      ok: false,
      error: "PINATA_JWT not configured",
      code: "NOT_CONFIGURED",
    };
  try {
    const { pinWithRedundancy } = await import("@/lib/ipfs-pinning");
    const res = await pinWithRedundancy(imageBlob, jwt, {
      config: opts.quorum != null ? { quorum: opts.quorum } : undefined,
      fileName: opts.fileName ?? "avatar.png",
      expectedChecksum: opts.expectedChecksum ?? null,
    });
    if (!res.ok || !res.cid || !res.uri) {
      return {
        ok: false,
        error: res.results.find((r) => r.error)?.error ?? "All gateways failed",
        code: "PIN_FAILED",
        achieved: res.achieved,
        quorum: res.quorum,
      };
    }
    return {
      ok: true,
      cid: res.cid,
      uri: res.uri,
      checksum: res.checksum ?? "",
      quorum: res.quorum,
      achieved: res.achieved,
      verified: res.verified,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      code: "PIN_ERROR",
    };
  }
}

/**
 * Resolves avatar image URL with multi-gateway fallback when flag enabled.
 * Tries gateways in priority order and checksum-verifies if expected available.
 */
export async function resolveAvatarWithFallback(
  imageUrl: string,
  opts: { expectedChecksum?: string | null; signal?: AbortSignal } = {},
): Promise<
  | { ok: true; url: string; gateway: string; checksum: string }
  | { ok: false; error: string }
> {
  if (!imageUrl) return { ok: false, error: "Empty imageUrl" };
  // non-ipfs URLs pass through
  if (/^https?:\/\//i.test(imageUrl) && !imageUrl.includes("/ipfs/")) {
    return { ok: true, url: imageUrl, gateway: "direct", checksum: "" };
  }
  const ipfsPath = (() => {
    const m = imageUrl.match(/ipfs:\/\/([A-Za-z0-9._\/-]+)/);
    if (m) return m[1]!;
    const g = imageUrl.match(/\/ipfs\/([A-Za-z0-9._\/-]+)/);
    if (g) return g[1]!;
    if (/^[A-Za-z0-9._\/-]+$/.test(imageUrl.trim()))
      return imageUrl.trim().replace(/^\/+/, "");
    return null;
  })();
  if (!ipfsPath)
    return { ok: true, url: imageUrl, gateway: "direct", checksum: "" };

  if (!isProfilePinningRedundancyEnabled()) {
    return { ok: true, url: imageUrl, gateway: "legacy", checksum: "" };
  }
  try {
    const { fetchWithMultiGatewayFallback } =
      await import("@/lib/ipfs-pinning");
    const res = await fetchWithMultiGatewayFallback(ipfsPath, {
      expectedChecksum: opts.expectedChecksum ?? null,
      signal: opts.signal,
    });
    if (!res.ok) return { ok: false, error: res.error };
    // return gateway-routed URL (verified)
    return {
      ok: true,
      url: `${res.gateway.replace(/\/+$/, "")}/${ipfsPath}`,
      gateway: res.gateway,
      checksum: res.checksum,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── phase-66: component-level code-splitting for heavy CRT widgets (isolated, flag-gated) ───
// Initial bundle previously shipped heavy animation/CRT shaders and scanline overlays upfront,
// bloating mobile and first-paint performance. This module provides dynamic code-splitting manifests,
// lazy chunk resolution, and device-aware bundle deferral for CRT visual widgets.
// Flag: NEXT_PUBLIC_FEATURE_PHASE_66 / FEATURE_PHASE_66 — Rollback: unset flag.

export function isPhase66Enabled(): boolean {
  const v = (
    typeof process !== "undefined"
      ? (process.env.NEXT_PUBLIC_FEATURE_PHASE_66 ??
        process.env.FEATURE_PHASE_66 ??
        "")
      : ""
  )
    ?.trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function flag66RollbackNote(): string {
  return "Rollback phase-66: unset NEXT_PUBLIC_FEATURE_PHASE_66 / FEATURE_PHASE_66 or set to 0/false and restart. Bundles fall back to standard monolithic loader.";
}

export const CRT_WIDGET_TYPES = [
  "scanline-overlay",
  "phosphor-glow",
  "flicker-anim",
  "terminal-cursor",
  "vignette-matrix",
  "glitch-distortion",
] as const;

export type CrtWidgetType = (typeof CRT_WIDGET_TYPES)[number];

export const CrtWidgetConfigSchema = z.object({
  widgetType: z.enum(CRT_WIDGET_TYPES),
  enabled: z.boolean().default(true),
  intensity: z.number().min(0).max(1).default(0.5),
  lazyLoad: z.boolean().default(true),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
});

export type CrtWidgetConfig = z.infer<typeof CrtWidgetConfigSchema>;

export const CRT_CHUNK_REGISTRY: Record<
  CrtWidgetType,
  {
    chunkId: string;
    estimatedBytes: number;
    modulePath: string;
    defaultDeferred: boolean;
  }
> = {
  "scanline-overlay": {
    chunkId: "chunk-crt-scanline",
    estimatedBytes: 42800,
    modulePath: "@/components/crt/scanline",
    defaultDeferred: true,
  },
  "phosphor-glow": {
    chunkId: "chunk-crt-phosphor",
    estimatedBytes: 68400,
    modulePath: "@/components/crt/phosphor",
    defaultDeferred: true,
  },
  "flicker-anim": {
    chunkId: "chunk-crt-flicker",
    estimatedBytes: 31200,
    modulePath: "@/components/crt/flicker",
    defaultDeferred: true,
  },
  "terminal-cursor": {
    chunkId: "chunk-crt-cursor",
    estimatedBytes: 12400,
    modulePath: "@/components/crt/cursor",
    defaultDeferred: false,
  },
  "vignette-matrix": {
    chunkId: "chunk-crt-vignette",
    estimatedBytes: 54100,
    modulePath: "@/components/crt/vignette",
    defaultDeferred: true,
  },
  "glitch-distortion": {
    chunkId: "chunk-crt-glitch",
    estimatedBytes: 98600,
    modulePath: "@/components/crt/glitch",
    defaultDeferred: true,
  },
};

export class CrtWidgetCodeSplitError extends Error {
  code:
    | "FLAG_DISABLED"
    | "VALIDATION_FAILED"
    | "WIDGET_NOT_FOUND"
    | "CHUNK_LOAD_FAILED";
  details?: unknown;
  constructor(
    code: CrtWidgetCodeSplitError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "CrtWidgetCodeSplitError";
    this.code = code;
    this.details = details;
  }
}

export type CrtChunkResolution = {
  widgetType: CrtWidgetType;
  chunkId: string;
  estimatedBytesSaved: number;
  shouldDefer: boolean;
  lazy: boolean;
  modulePath: string;
};

export function resolveCrtWidgetChunk(
  widgetType: unknown,
  opts: {
    isMobile?: boolean;
    priority?: "low" | "medium" | "high";
    force?: boolean;
  } = {},
): CrtChunkResolution {
  const enabled = opts.force || isPhase66Enabled();
  if (!enabled) {
    throw new CrtWidgetCodeSplitError(
      "FLAG_DISABLED",
      "CRT widget code-splitting disabled (phase-66 flag off)",
    );
  }

  const parsedType = z.enum(CRT_WIDGET_TYPES).safeParse(widgetType);
  if (!parsedType.success) {
    throw new CrtWidgetCodeSplitError(
      "WIDGET_NOT_FOUND",
      `Unknown CRT widget type: "${String(widgetType)}"`,
      parsedType.error.flatten(),
    );
  }

  const type = parsedType.data;
  const meta = CRT_CHUNK_REGISTRY[type];
  const isMobile = opts.isMobile ?? false;
  const priority = opts.priority ?? "medium";

  // Mobile or low-priority widgets are always deferred to optimize initial bundle
  const shouldDefer = isMobile || priority === "low" || meta.defaultDeferred;

  return {
    widgetType: type,
    chunkId: meta.chunkId,
    estimatedBytesSaved: meta.estimatedBytes,
    shouldDefer,
    lazy: true,
    modulePath: meta.modulePath,
  };
}

export function getCrtBundleSavingsSummary(): {
  totalWidgetTypes: number;
  totalEstimatedBytes: number;
  chunks: Record<string, number>;
} {
  const chunks: Record<string, number> = {};
  let total = 0;
  for (const [key, val] of Object.entries(CRT_CHUNK_REGISTRY)) {
    chunks[key] = val.estimatedBytes;
    total += val.estimatedBytes;
  }
  return {
    totalWidgetTypes: CRT_WIDGET_TYPES.length,
    totalEstimatedBytes: total,
    chunks,
  };
}

export function auditCrtWidgetWiring(): { ok: boolean; note: string } {
  if (!isPhase66Enabled()) {
    return {
      ok: true,
      note: "[phase-66] CRT widget code-splitting disabled; nothing to audit.",
    };
  }
  try {
    const probe = resolveCrtWidgetChunk("scanline-overlay", { force: true });
    if (probe.chunkId && probe.estimatedBytesSaved > 0) {
      return {
        ok: true,
        note: `[phase-66] CRT widget code-splitting OK (${probe.chunkId} registered). ${flag66RollbackNote()}`,
      };
    }
    return {
      ok: false,
      note: "[phase-66] CRT widget code-splitting probe failed.",
    };
  } catch (e) {
    return {
      ok: false,
      note: `[phase-66] CRT audit error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// Re-export for isolated testing / API routes
export { isPhase117Enabled, flag117RollbackNote } from "@/lib/ipfs-pinning";
export type { MultiPinResult, PinResult } from "@/lib/ipfs-pinning";

// ─── phase-157 (Module #57): NFT grid virtualization ────────────────────────
// Rendering all owned tokens froze low-end devices. The pure windowing math
// lives in lib/nft-grid-virtualization (dependency-free, client + server).
// Re-exported here so the avatar route and profile surfaces share one source.
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_157 / FEATURE_PHASE_157.
export {
  isNftGridVirtualizationEnabled,
  flag157RollbackNote,
  computeGridWindow,
  computeColumnCount,
  clampScrollTop,
  sliceVisible,
  nftGridOverscanPx,
  VirtualGridParamsSchema,
  VirtualGridError,
  DEFAULT_OVERSCAN_ROWS,
  DEFAULT_OVERSCAN_PX,
  LEGACY_OVERSCAN_PX,
} from "@/lib/nft-grid-virtualization";
export type { VirtualGridParams, VirtualGridWindow } from "@/lib/nft-grid-virtualization";

/**
 * phase-157: server helper — resolves a windowed page of avatar records for a
 * batch of wallets in one call, so a grid of many owned-token owners avoids
 * N round-trips. Best-effort per wallet; failures yield a null avatar.
 */
export const BatchAvatarQuerySchema = z.object({
  wallets: z.array(z.string().trim().length(56).regex(/^G[A-Z2-7]{55}$/)).min(1).max(50),
});

export async function getAvatarsForWallets(
  wallets: string[],
): Promise<Array<{ wallet: string; avatar: { tokenId: number; image: string; name: string } | null }>> {
  const unique = [...new Set(wallets.map((w) => w.trim()))].slice(0, 50);
  return Promise.all(
    unique.map(async (wallet) => {
      try {
        const profile = await getProfile(wallet);
        if (!profile?.avatar_token_id) return { wallet, avatar: null };
        const locale = normalizeProfileLocale(profile.locale) ?? DEFAULT_PROFILE_LOCALE;
        return {
          wallet,
          avatar: {
            tokenId: profile.avatar_token_id,
            image: profile.avatar_image_url ?? "",
            name: localizeAvatarName(profile.avatar_token_id, locale),
          },
        };
      } catch {
        return { wallet, avatar: null };
      }
    }),
  );
}

// ── Issue #105: Trending Signals Aggregator (phase-87) ───────────────────────

export function isPhase87Enabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_87 ??
    process.env.FEATURE_PHASE_87 ??
    ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

type TrendingBucket = {
  start: number;
  end: number;
  views: number;
  engagement: number;
};
type TrendingSignal = {
  wallet: string;
  score: number;
  buckets: TrendingBucket[];
};
type TrendingStore = Record<string, TrendingSignal>;

export async function recordTrendingSignal(
  wallet: string,
  bucketSizeMs: number = 3600000,
): Promise<void> {
  if (!isPhase87Enabled()) return;
  const store = await readJson<TrendingStore>(
    serverDataJsonPath("trendingSignals"),
  );
  const now = Date.now();
  const bucketStart = Math.floor(now / bucketSizeMs) * bucketSizeMs;
  const bucketEnd = bucketStart + bucketSizeMs;

  const signal = store[wallet] ?? { wallet, score: 0, buckets: [] };
  let bucket = signal.buckets.find((b) => b.start === bucketStart);

  if (!bucket) {
    bucket = { start: bucketStart, end: bucketEnd, views: 0, engagement: 0 };
    signal.buckets.push(bucket);
  }

  bucket.views++;
  signal.score = signal.buckets.reduce(
    (sum, b) => sum + b.views + b.engagement,
    0,
  );
  store[wallet] = signal;

  await writeJson(serverDataJsonPath("trendingSignals"), store);
}

export async function getTrendingSignals(
  windowMs: number = 86400000,
  limit: number = 10,
): Promise<TrendingSignal[]> {
  if (!isPhase87Enabled()) return [];
  const store = await readJson<TrendingStore>(
    serverDataJsonPath("trendingSignals"),
  );
  const now = Date.now();
  const cutoff = now - windowMs;

  return Object.values(store)
    .map((signal) => ({
      ...signal,
      buckets: signal.buckets.filter((b) => b.start >= cutoff),
      score: signal.buckets
        .filter((b) => b.start >= cutoff)
        .reduce((sum, b) => sum + b.views + b.engagement, 0),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── module #51 (phase-51): race-safe faucet claim rate-limits ──────────────
//
// The faucet's claim counters lived in a JSON sidecar: each claim did an async
// read → JSON.parse → mutate → write, so two concurrent claims from the same
// wallet both read the pre-increment count and both passed the limit check.
// This isolated, flag-gated module replaces that with an atomic
// consume-token operation. Two backends implement the same contract:
//   • "redis"  — INCRBY + PEXPIRE, atomic across instances (inject any
//                ioredis/node-redis-compatible client; this lib takes no redis
//                dependency of its own).
//   • "memory" — process-local Map guarded by a per-key async lock, so the
//                read-modify-write can never interleave within an instance.
//
// Feature flag: phase-51 (NEXT_PUBLIC_FEATURE_PHASE_51 / FEATURE_PHASE_51)
// Rollback: unset the flag → enforceFaucetClaimRateLimit throws FLAG_DISABLED
//           and the faucet route keeps its legacy JSON counter. No migration.

export function isFaucetRateLimitRedisEnabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_51 ??
    process.env.FEATURE_PHASE_51 ??
    ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function flag51RollbackNote(): string {
  return "Rollback phase-51: unset NEXT_PUBLIC_FEATURE_PHASE_51 / FEATURE_PHASE_51 or set to 0/false and restart. The faucet route falls back to its legacy JSON claim counter; no data migration to undo.";
}

export const RateLimitRequestSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/, "key must be a compact identifier"),
  limit: z.number().int().min(1).max(100_000),
  windowMs: z
    .number()
    .int()
    .min(1_000)
    .max(30 * 24 * 3_600_000),
  cost: z.number().int().min(1).max(10_000).default(1),
});

export type RateLimitRequest = z.infer<typeof RateLimitRequestSchema>;

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
  backend: "redis" | "memory";
};

export class FaucetRateLimitError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "BACKEND_UNAVAILABLE";
  details?: unknown;
  constructor(
    code: FaucetRateLimitError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "FaucetRateLimitError";
    this.code = code;
    this.details = details;
  }
}

export interface RateLimitBackend {
  readonly name: "redis" | "memory";
  consume(
    key: string,
    cost: number,
    windowMs: number,
    now: number,
  ): Promise<{ used: number; resetAt: number }>;
}

export interface RedisLikeClient {
  incrby(key: string, amount: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

/** Redis-backed backend — atomic across instances. Pass any ioredis/node-redis-compatible client. */
export function createRedisRateLimitBackend(
  client: RedisLikeClient,
  opts: { keyPrefix?: string } = {},
): RateLimitBackend {
  const prefix = opts.keyPrefix ?? "phase:faucet:rl:";
  return {
    name: "redis",
    async consume(key, cost, windowMs, now) {
      const redisKey = `${prefix}${key}`;
      const used = await client.incrby(redisKey, cost);
      if (used === cost) {
        await client.pexpire(redisKey, windowMs);
      }
      let ttl = await client.pttl(redisKey);
      if (!Number.isFinite(ttl) || ttl < 0) {
        await client.pexpire(redisKey, windowMs);
        ttl = windowMs;
      }
      return { used, resetAt: now + ttl };
    },
  };
}

const memoryRateLimitBuckets = new Map<string, { used: number; resetAt: number }>();
const keyLocks = new Map<string, Promise<unknown>>();

/** Serializes async work per key so a read-modify-write cannot interleave within an instance. */
function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  keyLocks.set(key, tail);
  void tail.then(() => {
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  });
  return run;
}

export function createMemoryRateLimitBackend(): RateLimitBackend {
  return {
    name: "memory",
    async consume(key, cost, windowMs, now) {
      return withKeyLock(key, async () => {
        const existing = memoryRateLimitBuckets.get(key);
        if (!existing || existing.resetAt <= now) {
          const fresh = { used: cost, resetAt: now + windowMs };
          memoryRateLimitBuckets.set(key, fresh);
          return { ...fresh };
        }
        existing.used += cost;
        return { used: existing.used, resetAt: existing.resetAt };
      });
    },
  };
}

let defaultBackend: RateLimitBackend | null = null;

function resolveDefaultBackend(): RateLimitBackend {
  if (!defaultBackend) defaultBackend = createMemoryRateLimitBackend();
  return defaultBackend;
}

/** Test/ops hook to reset process-local state. */
export function __resetFaucetRateLimitState(): void {
  memoryRateLimitBuckets.clear();
  keyLocks.clear();
  defaultBackend = null;
}

/**
 * Atomically consumes `cost` tokens from `key`'s window and returns whether the
 * caller is under the limit. Concurrent calls for the same key are serialized
 * (memory) or atomic (redis), so the check can no longer be raced.
 */
export async function enforceFaucetClaimRateLimit(
  raw: unknown,
  opts: { backend?: RateLimitBackend; now?: number; force?: boolean } = {},
): Promise<RateLimitDecision> {
  if (!opts.force && !isFaucetRateLimitRedisEnabled()) {
    throw new FaucetRateLimitError(
      "FLAG_DISABLED",
      "phase-51 flag disabled (set NEXT_PUBLIC_FEATURE_PHASE_51=1)",
      { rollback: flag51RollbackNote() },
    );
  }

  const parsed = RateLimitRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FaucetRateLimitError(
      "VALIDATION_FAILED",
      "valid rate-limit request required",
      parsed.error.flatten(),
    );
  }

  const req = parsed.data;
  const backend = opts.backend ?? resolveDefaultBackend();
  const now = opts.now ?? Date.now();

  let result: { used: number; resetAt: number };
  try {
    result = await backend.consume(req.key, req.cost, req.windowMs, now);
  } catch (e) {
    throw new FaucetRateLimitError(
      "BACKEND_UNAVAILABLE",
      `rate-limit backend "${backend.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const allowed = result.used <= req.limit;
  return {
    allowed,
    limit: req.limit,
    used: result.used,
    remaining: Math.max(0, req.limit - result.used),
    resetAt: result.resetAt,
    retryAfterMs: allowed ? 0 : Math.max(0, result.resetAt - now),
    backend: backend.name,
  };
}

export function auditFaucetRateLimitWiring(): { ok: boolean; note: string } {
  if (!isFaucetRateLimitRedisEnabled()) {
    return {
      ok: true,
      note: "[phase-51] race-safe faucet rate-limit disabled; nothing to audit.",
    };
  }
  return {
    ok: true,
    note: `[phase-51] race-safe faucet rate-limit wiring OK (default backend: memory; inject createRedisRateLimitBackend for multi-instance). ${flag51RollbackNote()}`,
  };
}

async function readJson<T extends object>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return {} as T;
  }
}

async function writeJson<T extends object>(
  filePath: string,
  data: T,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ── Issues #65 / #66 (phase-137): structured error taxonomy ───────────────────
//
// Isolated, flag-gated. Avatar / gateway / x402-invoice failures all surfaced as
// a single generic 500 "Internal server error", so a Pinata timeout, a checksum
// mismatch and a bad wallet were indistinguishable in production logs and the
// client could not tell a retryable blip from a permanent failure. This module
// maps any thrown value onto a closed taxonomy of codes, each carrying a
// deterministic HTTP status, a category and a retryable flag, plus a serializer
// for API responses.
//
// Feature flag: phase-137 (NEXT_PUBLIC_FEATURE_PHASE_137 / FEATURE_PHASE_137)
// Rollback: unset the flag → classifyProfileError() still works but routes keep
//           their legacy generic 500; no schema or data change to revert.

export function isPhase137Enabled(): boolean {
  return isFeatureEnabled("phase-137");
}

export function flag137RollbackNote(): string {
  return "Rollback phase-137: unset NEXT_PUBLIC_FEATURE_PHASE_137 / FEATURE_PHASE_137 or set to 0/false and restart. Routes fall back to a generic 500; no data migration to undo.";
}

export const PROFILE_ERROR_CODES = [
  "INVALID_WALLET",
  "AVATAR_NOT_FOUND",
  "GATEWAY_TIMEOUT",
  "GATEWAY_UNREACHABLE",
  "GATEWAY_5XX",
  "GATEWAY_4XX",
  "CHECKSUM_MISMATCH",
  "MALFORMED_RESPONSE",
  "PIN_QUORUM_FAILED",
  "NOT_CONFIGURED",
  "RATE_LIMITED",
  "FLAG_DISABLED",
  "INTERNAL",
] as const;

export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number];

export type ProfileErrorCategory =
  | "client"
  | "upstream"
  | "integrity"
  | "config"
  | "internal";

type ProfileErrorSpec = {
  status: number;
  category: ProfileErrorCategory;
  retryable: boolean;
};

const PROFILE_ERROR_TABLE: Record<ProfileErrorCode, ProfileErrorSpec> = {
  INVALID_WALLET: { status: 400, category: "client", retryable: false },
  AVATAR_NOT_FOUND: { status: 404, category: "client", retryable: false },
  GATEWAY_TIMEOUT: { status: 504, category: "upstream", retryable: true },
  GATEWAY_UNREACHABLE: { status: 502, category: "upstream", retryable: true },
  GATEWAY_5XX: { status: 502, category: "upstream", retryable: true },
  GATEWAY_4XX: { status: 502, category: "upstream", retryable: false },
  CHECKSUM_MISMATCH: { status: 502, category: "integrity", retryable: false },
  MALFORMED_RESPONSE: { status: 502, category: "integrity", retryable: false },
  PIN_QUORUM_FAILED: { status: 502, category: "upstream", retryable: true },
  NOT_CONFIGURED: { status: 500, category: "config", retryable: false },
  RATE_LIMITED: { status: 429, category: "upstream", retryable: true },
  FLAG_DISABLED: { status: 404, category: "config", retryable: false },
  INTERNAL: { status: 500, category: "internal", retryable: false },
};

export const ProfileErrorResponseSchema = z.object({
  error: z.string().min(1),
  code: z.enum(PROFILE_ERROR_CODES),
  category: z.enum(["client", "upstream", "integrity", "config", "internal"]),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});

export type ProfileErrorResponse = z.infer<typeof ProfileErrorResponseSchema>;

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly status: number;
  readonly category: ProfileErrorCategory;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: ProfileErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    const spec = PROFILE_ERROR_TABLE[code];
    this.status = spec.status;
    this.category = spec.category;
    this.retryable = spec.retryable;
    this.details = details;
  }

  toResponse(): ProfileErrorResponse {
    return {
      error: this.message,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

function statusToCode(status: number): ProfileErrorCode {
  if (status === 429) return "RATE_LIMITED";
  if (status === 408 || status === 504) return "GATEWAY_TIMEOUT";
  if (status >= 500) return "GATEWAY_5XX";
  if (status >= 400) return "GATEWAY_4XX";
  return "INTERNAL";
}

/**
 * Maps any thrown value onto the taxonomy. Recognises ProfileError (pass-through),
 * fetch AbortError / timeouts, DNS / connection failures, `{ status }`-shaped
 * upstream errors, CID integrity errors and Zod parse errors.
 */
export function classifyProfileError(err: unknown): ProfileError {
  if (err instanceof ProfileError) return err;

  if (err instanceof z.ZodError) {
    return new ProfileError(
      "MALFORMED_RESPONSE",
      "Upstream payload failed schema validation",
      err.flatten(),
    );
  }

  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message.toLowerCase();

    if (name === "AbortError" || name === "TimeoutError" || msg.includes("timeout") || msg.includes("timed out")) {
      return new ProfileError("GATEWAY_TIMEOUT", "Gateway request timed out", { cause: err.message });
    }
    if (name === "CidIntegrityError" || msg.includes("checksum") || msg.includes("tamper") || msg.includes("hash mismatch")) {
      return new ProfileError("CHECKSUM_MISMATCH", "Fetched bytes failed integrity verification", { cause: err.message });
    }
    if (msg.includes("fetch failed") || msg.includes("enotfound") || msg.includes("econnrefused") || msg.includes("network")) {
      return new ProfileError("GATEWAY_UNREACHABLE", "Gateway is unreachable", { cause: err.message });
    }

    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return new ProfileError(statusToCode(status), `Gateway responded ${status}`, { status });
    }

    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && (PROFILE_ERROR_CODES as readonly string[]).includes(code)) {
      return new ProfileError(code as ProfileErrorCode, err.message);
    }

    return new ProfileError("INTERNAL", err.message);
  }

  return new ProfileError("INTERNAL", typeof err === "string" ? err : "Unknown profile error");
}

/** Convenience for route handlers: `{ body, status }` for a caught value. */
export function toProfileErrorResponse(err: unknown): {
  body: ProfileErrorResponse;
  status: number;
} {
  const classified = classifyProfileError(err);
  return { body: classified.toResponse(), status: classified.status };
}
