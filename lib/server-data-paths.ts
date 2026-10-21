import os from "node:os"
import path from "node:path"
import { previewDataSubdir } from "@/lib/preview-isolation"

/** Local filenames only — Next file tracing stays predictable. */
const FILES = {
  nftListings: "nft-listings.json",
  faucetClaims: "faucet-claims.json",
  classicLiqClaims: "classic-liq-claims.json",
  artistProfiles: "artist-profiles.json",
  worldCollections: "world-collections.json",
  worldNarratives: "world-narratives.json",
  profileSocials: "profile-socials.json",
  signals: "signals.json",
  signalReplies: "signal-replies.json",
  signalModerationAudit: "signal-moderation-audit.json",
  profileFollows: "profile-follows.json",
  notifications: "notifications.json",
  notificationPreferences: "notification-preferences.json",
  marketListings: "market-listings.json",
  marketOffers: "market-offers.json",
  marketProfileViews: "market-profile-views.json",
  achievements: "achievements.json",
  loreVersions: "lore-versions.json",
  worldLoreLinks: "world-lore-links.json",
  worldRoles: "world-roles.json",
  worldReaderProgress: "world-reader-progress.json",
  ipfsGatewayAuthRotations: "ipfs-gateway-auth-rotations.json",
  artistAttestations: "artist-attestations.json",
  pushSubscriptions: "push-subscriptions.json",
  watchlists: "watchlists.json",
  questRegistry: "quest-registry.json",
  distributorHealth: "distributor-health.json",
  sqliteDb: "phase.sqlite3",
  faucetDenyList: "faucet-deny-list.json",
  faucetFunnelEvents: "faucet-funnel-events.json",
  trendingSignals: "trending-signals.json",
  blockList: "block-list.json",
  x402DeadLetter: "x402-dead-letter.json",
  generationJobs: "generation-jobs.json",
  generationDlq: "generation-dlq.json",
  winbackExperiments: "winback-experiments.json",
  webhookSubscriptions: "webhook-subscriptions.json",
  authSessions: "auth-sessions.json",
  ageDeclarations: "age-declarations.json",
  licenseAttestations: "license-attestations.json",
  termsConsents: "terms-consents.json",
  legalDocuments: "legal-documents.json",
  legalHolds: "legal-holds.json",
  qrAudit: "qr-audit.json",
  walletSessions: "wallet-sessions.json",
  ledgerAudit: "ledger-audit.json",
  experimentAssignments: "experiment-assignments.json",
  searchQueryLog: "search-query-log.json",
  costBudgets: "cost-budgets.json",
  forgeBilling: "forge-billing.json",
  leaderboardEntries: "leaderboard-entries.json",
  gdprErasureLog: "gdpr-erasure-log.json",
  anomalyBaselines: "anomaly-baselines.json",
  featureFlagOps: "feature-flag-ops.json",
  referralQuests: "referral-quests.json",
  liquidityPoolIntents: "liquidity-pool-intents.json",
} as const


export type ServerDataFile = keyof typeof FILES

/**
 * Writable root for JSON sidecars (faucet, aliases, listings).
 * - Local: `<cwd>/.data`
 * - Vercel: `<os.tmpdir()>/phase-server-data` (project dir is read-only)
 * - Override: `PHASE_SERVER_DATA_DIR` (e.g. mounted volume)
 * - Preview (phase-173): `serverDataRoot()` appends `previews/<id>` to the above
 */
function baseDataRoot(): string {
  const fromEnv = process.env.PHASE_SERVER_DATA_DIR?.trim()
  if (fromEnv) return fromEnv
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), "phase-server-data")
  }
  return path.join(process.cwd(), ".data")
}

export function serverDataRoot(): string {
  const base = baseDataRoot()
  const preview = previewDataSubdir()
  return preview ? path.join(base, preview) : base
}

export function serverDataJsonPath(key: ServerDataFile): string {
  return path.join(serverDataRoot(), FILES[key])
}

/** Every sidecar key, so backup tooling never drifts from the FILES table. */
export function serverDataFileKeys(): ServerDataFile[] {
  return Object.keys(FILES) as ServerDataFile[]
}

export function serverDataFileName(key: ServerDataFile): string {
  return FILES[key]
}
