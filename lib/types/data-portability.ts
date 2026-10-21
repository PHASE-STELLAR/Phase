export type PortabilityDomain =
  | "profile"
  | "follows"
  | "notifications"
  | "market"
  | "signals"
  | "badges"
  | "consents";

export interface PortabilityManifest {
  schema_version: string;
  format: "phase-gdpr-article-20-bundle";
  wallet: string;
  exported_at: number;
  domains: PortabilityDomain[];
  counts: Record<PortabilityDomain, number>;
  checksums: Record<PortabilityDomain, string>;
  bundle_checksum: string;
}

export interface PortabilityProfileData {
  wallet: string;
  display_name?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  avatar_token_id?: number;
  avatar_image_url?: string;
  locale?: string;
  updated_at?: number;
  artist_profile?: Record<string, unknown> | null;
}

export interface PortabilityFollowsData {
  following: string[];
  followers_count: number;
}

export interface PortabilityNotificationsData {
  items: Array<{
    id: string;
    type: string;
    read: boolean;
    created_at: number;
    data: Record<string, unknown>;
  }>;
  preferences: {
    enabled: boolean;
    types: Record<string, boolean>;
    updated_at: number;
  } | null;
}

export interface PortabilityMarketData {
  listings: Array<Record<string, unknown>>;
  offers_as_buyer: Array<Record<string, unknown>>;
  offers_as_seller: Array<Record<string, unknown>>;
}

export interface PortabilitySignalsData {
  signals: Array<Record<string, unknown>>;
  replies: Array<Record<string, unknown>>;
  reactions: Array<Record<string, unknown>>;
}

export interface PortabilityBadgesData {
  attestations: Array<Record<string, unknown>>;
  achievements: Array<Record<string, unknown>>;
}

export interface PortabilityBundleData {
  profile: PortabilityProfileData | null;
  follows: PortabilityFollowsData;
  notifications: PortabilityNotificationsData;
  market: PortabilityMarketData;
  signals: PortabilitySignalsData;
  badges: PortabilityBadgesData;
  consents: Record<string, unknown> | null;
}

export interface GDPRArticle20Bundle {
  manifest: PortabilityManifest;
  data: PortabilityBundleData;
}
