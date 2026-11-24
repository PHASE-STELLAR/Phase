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
  profileFollows: "profile-follows.json",
  notifications: "notifications.json",
  marketListings: "market-listings.json",
  marketOffers: "market-offers.json",
  achievements: "achievements.json",
  liquidityPoolIntents: "liquidity-pool-intents.json",
  poolActivity: "pool-activity.json",
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
