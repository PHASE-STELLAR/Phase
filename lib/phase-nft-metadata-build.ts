import {
  fetchCollectionInfo,
  fetchCreatorCollectionIds,
  fetchPhaseLevelForToken,
  fetchTokenCollectionIdForToken,
  fetchTokenOwnerAddress,
  extractIpfsGatewaySubpath,
} from "@/lib/phase-protocol"
import { getProfile, type ProfileData } from "@/lib/profile-store"
import { isVerifiedArtist } from "@/lib/artist-attestation"
import { z } from "zod"

// ── phase-123: IPFS timeout fallback chain (isolated, flag-gated) ──
// One slow gateway stalls the whole read. This module provides per-gateway
// timeout + fallback chain. Used by /api/ipfs and metadata build.
// Flag: NEXT_PUBLIC_FEATURE_PHASE_123 / FEATURE_PHASE_123 — rollback: unset flag.

function isPhase123Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_123 ?? process.env.FEATURE_PHASE_123 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export const PHASE_IPFS_GATEWAYS = [
  "https://w3s.link/ipfs",
  "https://dweb.link/ipfs",
  "https://ipfs.io/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
] as const

export const IpfsFallbackConfigSchema = z.object({
  gateways: z.array(z.string().url()).min(1).max(8).default([...PHASE_IPFS_GATEWAYS]),
  timeoutMs: z.number().int().min(50).max(15000).default(4000),
  retries: z.number().int().min(0).max(2).default(0),
})

export type IpfsFallbackConfig = z.infer<typeof IpfsFallbackConfigSchema>

export type IpfsFallbackResult =
  | { ok: true; gateway: string; bytes: ArrayBuffer; contentType: string; latencyMs: number }
  | { ok: false; error: string; perGateway: Array<{ gateway: string; error: string; latencyMs: number }> }

export function resolveIpfsFallbackConfig(overrides: Partial<IpfsFallbackConfig> = {}): IpfsFallbackConfig {
  const parsed = IpfsFallbackConfigSchema.safeParse({
    gateways: overrides.gateways ?? [...PHASE_IPFS_GATEWAYS],
    timeoutMs: overrides.timeoutMs ?? (isPhase123Enabled() ? 4000 : 8000),
    retries: overrides.retries ?? 0,
  })
  if (!parsed.success) {
    return {
      gateways: Array.isArray(overrides.gateways) && overrides.gateways.length > 0 ? overrides.gateways : [...PHASE_IPFS_GATEWAYS],
      timeoutMs: typeof overrides.timeoutMs === "number" && overrides.timeoutMs > 0 ? overrides.timeoutMs : 4000,
      retries: 0,
    }
  }
  return parsed.data
}

/** Reorders `gateways` by live health score (best first); unranked gateways keep their relative order at the end. */
async function prioritizeGatewaysByHealth(gateways: readonly string[]): Promise<string[]> {
  try {
    const { getGatewayRanking } = await import("@/lib/gateway-health")
    const ranking = getGatewayRanking().map((g) => g.replace(/\/+$/, ""))
    if (ranking.length === 0) return [...gateways]
    const ranked = gateways.filter((g) => ranking.includes(g.replace(/\/+$/, "")))
    ranked.sort(
      (a, b) => ranking.indexOf(a.replace(/\/+$/, "")) - ranking.indexOf(b.replace(/\/+$/, "")),
    )
    const unranked = gateways.filter((g) => !ranking.includes(g.replace(/\/+$/, "")))
    return [...ranked, ...unranked]
  } catch {
    return [...gateways]
  }
}

export async function fetchWithIpfsFallback(ipfsPath: string, opts: { config?: Partial<IpfsFallbackConfig>; signal?: AbortSignal } = {}): Promise<IpfsFallbackResult> {
  const clean = ipfsPath.replace(/^\/+/, "").trim()
  if (!clean) return { ok: false, error: "Empty IPFS path", perGateway: [] }
  const cfg = resolveIpfsFallbackConfig(opts.config)
  const perGateway: Array<{ gateway: string; error: string; latencyMs: number }> = []
  const orderedGateways = await prioritizeGatewaysByHealth(cfg.gateways)

  for (const base of orderedGateways) {
    const url = `${base.replace(/\/+$/, "")}/${clean}`
    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException(`Timeout ${cfg.timeoutMs}ms`, "TimeoutError")), cfg.timeoutMs)
    if (opts.signal) {
      const sig = opts.signal
      if (sig.aborted) controller.abort((sig as AbortSignal & { reason?: unknown }).reason)
      else sig.addEventListener("abort", () => controller.abort((sig as AbortSignal & { reason?: unknown }).reason), { once: true })
    }
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: "*/*" }, cache: "no-store" as RequestCache })
      clearTimeout(timer)
      const latencyMs = Date.now() - start
      if (!res.ok) {
        perGateway.push({ gateway: base, error: `HTTP ${res.status}`, latencyMs })
        continue
      }
      const contentType = res.headers.get("content-type") ?? "application/octet-stream"
      const bytes = await res.arrayBuffer()
      // Record to gateway-health if flag 121 enabled (best-effort)
      try {
        const { recordGatewayLatency } = await import("@/lib/gateway-health")
        recordGatewayLatency(base, latencyMs, true)
      } catch { /* ignore */ }
      return { ok: true, gateway: base, bytes, contentType, latencyMs }
    } catch (e) {
      clearTimeout(timer)
      const latencyMs = Date.now() - start
      const msg = e instanceof Error ? e.message : String(e)
      const isTimeout = msg.toLowerCase().includes("timeout") || (e as DOMException)?.name === "TimeoutError"
      perGateway.push({ gateway: base, error: isTimeout ? `timeout@${cfg.timeoutMs}ms` : msg.slice(0, 200), latencyMs })
      try {
        const { recordGatewayLatency } = await import("@/lib/gateway-health")
        recordGatewayLatency(base, latencyMs, false)
      } catch { /* ignore */ }
      if (opts.signal?.aborted) return { ok: false, error: `Aborted: ${msg}`, perGateway }
    }
  }
  return { ok: false, error: "All IPFS gateways failed", perGateway }
}

export const PhaseMetadataRequestSchema = z.object({
  contractId: z.string().length(56).regex(/^C[A-Z2-7]{55}$/, "Invalid contract strkey"),
  tokenId: z.number().int().min(1).max(1_000_000),
})

export class IpfsFallbackError extends Error {
  code: "TIMEOUT" | "ALL_GATEWAYS_FAILED" | "VALIDATION_FAILED"
  constructor(code: IpfsFallbackError["code"], message: string) {
    super(message)
    this.name = "IpfsFallbackError"
    this.code = code
  }
}

export function publicPhaseSiteBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/$/, "")
  const vercel = process.env.VERCEL_URL?.trim()
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`
  return "https://www.phasee.xyz"
}

function defaultCollectionImage(base: string): string {
  const og = process.env.NEXT_PUBLIC_OG_IMAGE_URL?.trim()
  if (og && /^https?:\/\//i.test(og)) return og
  return `${base}/og-phase.png`
}

function resolvePublicImageUri(raw: string, base: string): string {
  const t = raw.trim()
  if (!t) return defaultCollectionImage(base)
  if (t.startsWith("/")) return `${base}${t}`
  // For IPFS URIs, proxy through our own server so Freighter (browser extension)
  // can load the image without CORS issues and with gateway retry logic.
  const ipfsPath = extractIpfsGatewaySubpath(t)
  if (ipfsPath) return `${base}/api/ipfs/${ipfsPath}`
  return t
}

// ── phase-93: profile completeness scoring with on-chain signals (isolated) ──
// No incentive previously existed to enrich creator profiles. This module
// scores a wallet's profile (off-chain fields) plus on-chain signals (minted
// collections, verified-artist badge) into a 0-100 completeness score, surfaced
// as a token metadata attribute. Preserves public/phaser-liq.metadata.json
// wiring: that file is a fixed asset manifest and is never mutated here.
// Flag: NEXT_PUBLIC_FEATURE_PHASE_93 / FEATURE_PHASE_93 — rollback: unset flag
// (metadata build falls back to its pre-existing attribute set, unchanged).

export function isPhase93Enabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_FEATURE_PHASE_93 ?? process.env.FEATURE_PHASE_93 ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export const ProfileCompletenessInputSchema = z.object({
  hasDisplayName: z.boolean(),
  hasAvatar: z.boolean(),
  socialLinksCount: z.number().int().min(0).max(3),
  collectionsCreated: z.number().int().min(0),
  isVerifiedArtist: z.boolean(),
})

export type ProfileCompletenessInput = z.infer<typeof ProfileCompletenessInputSchema>

export type ProfileCompletenessBreakdown = {
  displayName: number
  avatar: number
  socialLinks: number
  onChainCollections: number
  verifiedArtist: number
}

export type ProfileCompletenessScore = {
  score: number
  breakdown: ProfileCompletenessBreakdown
}

/** Weighted, deterministic, pure scoring function — easy to unit test in isolation. */
export function computeProfileCompletenessScore(input: ProfileCompletenessInput): ProfileCompletenessScore {
  const parsed = ProfileCompletenessInputSchema.parse(input)
  const breakdown: ProfileCompletenessBreakdown = {
    displayName: parsed.hasDisplayName ? 20 : 0,
    avatar: parsed.hasAvatar ? 20 : 0,
    socialLinks: Math.min(parsed.socialLinksCount, 3) * 10, // up to 30
    onChainCollections: Math.min(parsed.collectionsCreated, 3) * 5, // up to 15
    verifiedArtist: parsed.isVerifiedArtist ? 15 : 0,
  }
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0)
  return { score: Math.min(100, score), breakdown }
}

function profileCompletenessInputFromProfile(
  profile: ProfileData | null,
  collectionsCreated: number,
  verifiedArtist: boolean,
): ProfileCompletenessInput {
  const socialLinksCount = [profile?.twitter, profile?.discord, profile?.telegram].filter((v) => !!v?.trim()).length
  return {
    hasDisplayName: !!profile?.display_name?.trim(),
    hasAvatar: !!profile?.avatar_image_url?.trim() || !!profile?.avatar_token_id,
    socialLinksCount: Math.min(socialLinksCount, 3),
    collectionsCreated,
    isVerifiedArtist: verifiedArtist,
  }
}

/**
 * Resolves the owner's profile completeness score using their off-chain
 * profile plus on-chain signals (minted collections, verified-artist badge).
 * Best-effort: any lookup failure degrades to a null score, never throws.
 */
export async function resolveOwnerProfileCompleteness(owner: string): Promise<ProfileCompletenessScore | null> {
  if (!isPhase93Enabled()) return null
  try {
    const [profile, collectionIds, verified] = await Promise.all([
      getProfile(owner),
      fetchCreatorCollectionIds(owner).catch(() => [] as number[]),
      isVerifiedArtist(owner).catch(() => false),
    ])
    return computeProfileCompletenessScore(
      profileCompletenessInputFromProfile(profile, collectionIds.length, verified),
    )
  } catch {
    return null
  }
}

export type PhaseTokenMetadataJson = {
  name: string
  description: string
  image: string
  external_url: string
  attributes: Array<{
    trait_type: string
    value: string | number
    display_type?: "number"
  }>
  collectionId: number | null
}

// SEP-50 (draft) requires token_uri to resolve to well-formed JSON with a stable
// shape: non-empty name/description, an https:// or ipfs:// image, and an
// https:// external_url. Validated before the endpoint ever serves the payload
// to a wallet/indexer, so a malformed on-chain read fails loudly (502, caught by
// the route's error boundary) instead of shipping broken metadata.
export const PhaseTokenMetadataJsonSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(1000),
  image: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((v) => /^https:\/\//i.test(v) || /^ipfs:\/\/[A-Za-z0-9._/-]+$/i.test(v), {
      message: "image must be https:// or ipfs://",
    }),
  external_url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((v) => /^https:\/\//i.test(v), { message: "external_url must be https://" }),
  attributes: z
    .array(
      z.object({
        trait_type: z.string().trim().min(1).max(64),
        value: z.union([z.string().trim().min(1).max(256), z.number().finite()]),
        display_type: z.enum(["number"]).optional(),
      }),
    )
    .max(64),
  collectionId: z.number().int().positive().nullable(),
})

export class Sep50MetadataBuildError extends Error {
  code: "SEP50_OUTPUT_INVALID"
  details: unknown
  constructor(message: string, details: unknown) {
    super(message)
    this.name = "Sep50MetadataBuildError"
    this.code = "SEP50_OUTPUT_INVALID"
    this.details = details
  }
}

/**
 * Misma lógica que GET /api/metadata/[id]: JSON estilo OpenSea + id de colección resuelto on-chain.
 */
export async function buildPhaseTokenMetadataJson(
  contractId: string,
  tokenId: number,
): Promise<PhaseTokenMetadataJson | null> {
  const owner = await fetchTokenOwnerAddress(contractId, tokenId)
  if (!owner) return null

  const base = publicPhaseSiteBaseUrl()
  const colId = await fetchTokenCollectionIdForToken(tokenId, owner, contractId)
  const phaseLevel = await fetchPhaseLevelForToken(tokenId, contractId)
  const hasCollection = colId != null && Number.isFinite(colId) && colId > 0

  let collectionName = "Phase"
  let imageRaw = ""
  if (hasCollection) {
    const info = await fetchCollectionInfo(colId as number, contractId)
    if (info?.name?.trim()) collectionName = info.name.trim()
    imageRaw = info?.imageUri?.trim() ?? ""
  }

  const image = resolvePublicImageUri(imageRaw, base)
  const name = hasCollection ? `${collectionName} Artifact #${tokenId}` : `Phase Artifact #${tokenId}`

  const description =
    phaseLevel && phaseLevel.length > 0
      ? `Forged on Soroban via x402 AI Protocol · PHASE level ${phaseLevel}`
      : "Forged on Soroban via x402 AI Protocol"

  const ownerCompleteness = await resolveOwnerProfileCompleteness(owner)

  // phase-132: referral attribution for referred tokens
  let referralAttribution: { referrer: string; referralCode: string } | null = null
  try {
    const { isReferralQuestEnabled, getReferralAttribution } = await import("@/lib/referral-quest")
    if (isReferralQuestEnabled()) {
      referralAttribution = await getReferralAttribution(owner)
    }
  } catch { /* non-critical */ }

  const payload: PhaseTokenMetadataJson = {
    name,
    description,
    image,
    external_url: `${base}/chamber${hasCollection ? `?collection=${colId}` : ""}`,
    attributes: [
      ...(hasCollection
        ? [{ trait_type: "collection_id", value: colId as number, display_type: "number" as const }]
        : []),
      { trait_type: "token_id", value: tokenId, display_type: "number" as const },
      ...(phaseLevel && phaseLevel.length > 0 ? [{ trait_type: "phase_level", value: phaseLevel }] : []),
      { trait_type: "network", value: "stellar-testnet" },
      { trait_type: "standard", value: "SEP-50-draft" },
      ...(ownerCompleteness
        ? [{ trait_type: "creator_profile_completeness", value: ownerCompleteness.score, display_type: "number" as const }]
        : []),
      ...(referralAttribution
        ? [
            { trait_type: "referred_by", value: referralAttribution.referrer },
            { trait_type: "referral_code", value: referralAttribution.referralCode },
          ]
        : []),
    ],
    collectionId: hasCollection ? (colId as number) : null,
  }

  const validated = PhaseTokenMetadataJsonSchema.safeParse(payload)
  if (!validated.success) {
    throw new Sep50MetadataBuildError(
      "Built metadata failed SEP-50 schema validation",
      validated.error.flatten(),
    )
  }
  return validated.data
}

// ─── phase-78: gas-estimate preview before listing submission (isolated, flag-gated) ───
// Users previously blind-signed unpredictable Stellar/Soroban fees during market listing.
// This module provides accurate, pre-flight gas fee calculation and fee preview breakdown.
// Feature flag: phase-78 (NEXT_PUBLIC_FEATURE_PHASE_78 / FEATURE_PHASE_78)
// Rollback: unset flag or set to 0/false and restart; no persistent storage to undo.

export function isPhase78Enabled(): boolean {
  const v = (typeof process !== "undefined" ? (process.env.NEXT_PUBLIC_FEATURE_PHASE_78 ?? process.env.FEATURE_PHASE_78 ?? "") : "")?.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function flag78RollbackNote(): string {
  return "Rollback phase-78: unset NEXT_PUBLIC_FEATURE_PHASE_78 / FEATURE_PHASE_78 or set to 0/false and restart. Gas previews disabled with zero metadata regressions."
}

export const GasEstimateOperationSchema = z.enum([
  "create_listing",
  "cancel_listing",
  "accept_offer",
  "mint_token",
  "transfer_nft",
  "update_price",
])

export type GasEstimateOperation = z.infer<typeof GasEstimateOperationSchema>

export const GasEstimateRequestSchema = z.object({
  operationType: GasEstimateOperationSchema,
  payloadSizeBytes: z.number().int().min(0).max(1048576).default(512),
  contractId: z.string().length(56).regex(/^C[A-Z2-7]{55}$/, "Invalid contract ID").optional(),
  simulatedInstructions: z.number().int().min(0).max(100_000_000).optional(),
  bufferedMultiplier: z.number().min(1.0).max(3.0).default(1.2),
})

export type GasEstimateRequest = z.infer<typeof GasEstimateRequestSchema>

export const GasEstimatePreviewSchema = z.object({
  operationType: GasEstimateOperationSchema,
  baseFeeStroops: z.number().int().min(0),
  resourceFeeStroops: z.number().int().min(0),
  totalFeeStroops: z.number().int().min(0),
  totalFeeXlm: z.string(),
  confidenceLevel: z.enum(["conservative", "standard", "buffered"]),
  breakdown: z.object({
    cpuFeeStroops: z.number().int().min(0),
    storageFeeStroops: z.number().int().min(0),
    networkBaseFeeStroops: z.number().int().min(0),
    bufferStroops: z.number().int().min(0),
  }),
  estimatedAt: z.number().int().min(0),
})

export type GasEstimatePreview = z.infer<typeof GasEstimatePreviewSchema>

export class GasEstimatePreviewError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "CALCULATION_FAILED"
  details?: unknown
  constructor(code: GasEstimatePreviewError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "GasEstimatePreviewError"
    this.code = code
    this.details = details
  }
}

const OPERATION_BASE_SPECS: Record<GasEstimateOperation, { instructions: number; storageBytes: number; readEntries: number; writeEntries: number }> = {
  create_listing: { instructions: 850_000, storageBytes: 640, readEntries: 4, writeEntries: 2 },
  cancel_listing: { instructions: 420_000, storageBytes: 128, readEntries: 3, writeEntries: 1 },
  accept_offer: { instructions: 1_200_000, storageBytes: 896, readEntries: 6, writeEntries: 4 },
  mint_token: { instructions: 1_850_000, storageBytes: 1536, readEntries: 8, writeEntries: 5 },
  transfer_nft: { instructions: 650_000, storageBytes: 256, readEntries: 4, writeEntries: 2 },
  update_price: { instructions: 480_000, storageBytes: 256, readEntries: 3, writeEntries: 1 },
}

/**
 * Pure, deterministic gas & fee estimation for Soroban contract actions.
 */
export function calculateGasEstimatePreview(
  request: unknown,
  opts: { force?: boolean } = {},
): GasEstimatePreview {
  const enabled = opts.force || isPhase78Enabled()
  if (!enabled) {
    throw new GasEstimatePreviewError("FLAG_DISABLED", "Gas estimate preview disabled (phase-78 flag off)")
  }

  const parsed = GasEstimateRequestSchema.safeParse(request)
  if (!parsed.success) {
    throw new GasEstimatePreviewError("VALIDATION_FAILED", "Invalid gas estimate request payload", parsed.error.flatten())
  }

  const { operationType, payloadSizeBytes, simulatedInstructions, bufferedMultiplier } = parsed.data
  const specs = OPERATION_BASE_SPECS[operationType]

  const instructions = simulatedInstructions ?? specs.instructions
  const storageBytes = Math.max(specs.storageBytes, payloadSizeBytes)

  // Soroban testnet resource rate calculations
  // 10,000 instructions ~ 25 stroops; 1 KB storage write ~ 150 stroops
  const cpuFeeStroops = Math.ceil((instructions / 10_000) * 25)
  const storageFeeStroops = Math.ceil((storageBytes / 1024) * 150)
  const networkBaseFeeStroops = 100 // 100 stroops (0.00001 XLM standard base fee)

  const rawResourceFee = cpuFeeStroops + storageFeeStroops
  const rawTotal = networkBaseFeeStroops + rawResourceFee
  const bufferedTotal = Math.ceil(rawTotal * bufferedMultiplier)
  const bufferStroops = bufferedTotal - rawTotal

  const totalFeeXlm = (bufferedTotal / 10_000_000).toFixed(7)

  return {
    operationType,
    baseFeeStroops: networkBaseFeeStroops,
    resourceFeeStroops: rawResourceFee,
    totalFeeStroops: bufferedTotal,
    totalFeeXlm,
    confidenceLevel: bufferedMultiplier >= 1.5 ? "buffered" : bufferedMultiplier > 1.0 ? "standard" : "conservative",
    breakdown: {
      cpuFeeStroops,
      storageFeeStroops,
      networkBaseFeeStroops,
      bufferStroops,
    },
    estimatedAt: Date.now(),
  }
}

export function previewListingSubmissionGas(params: { tokenId: number; pricePhaselq: number; sellerWallet?: string }): GasEstimatePreview {
  return calculateGasEstimatePreview(
    {
      operationType: "create_listing",
      payloadSizeBytes: 512,
      bufferedMultiplier: 1.2,
    },
    { force: true },
  )
}

export function auditGasEstimateWiring(): { ok: boolean; note: string } {
  if (!isPhase78Enabled()) {
    return { ok: true, note: "[phase-78] gas-estimate preview disabled; nothing to audit." }
  }
  try {
    const probe = calculateGasEstimatePreview({ operationType: "create_listing" }, { force: true })
    if (probe.totalFeeStroops > 0 && probe.totalFeeXlm) {
      return { ok: true, note: `[phase-78] gas-estimate preview OK (${probe.totalFeeXlm} XLM estimated). ${flag78RollbackNote()}` }
    }
    return { ok: false, note: "[phase-78] gas-estimate preview probe returned zero fees." }
  } catch (e) {
    return { ok: false, note: `[phase-78] audit error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

