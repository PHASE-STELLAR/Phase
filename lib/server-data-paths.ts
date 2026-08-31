import os from "node:os"
import path from "node:path"

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
} as const

export type ServerDataFile = keyof typeof FILES

/**
 * Writable root for JSON sidecars (faucet, aliases, listings).
 * - Local: `<cwd>/.data`
 * - Vercel: `<os.tmpdir()>/phase-server-data` (project dir is read-only)
 * - Override: `PHASE_SERVER_DATA_DIR` (e.g. mounted volume)
 */
function serverDataRoot(): string {
  const fromEnv = process.env.PHASE_SERVER_DATA_DIR?.trim()
  if (fromEnv) return fromEnv
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), "phase-server-data")
  }
  return path.join(process.cwd(), ".data")
}

export function serverDataJsonPath(key: ServerDataFile): string {
  return path.join(serverDataRoot(), FILES[key])
}
