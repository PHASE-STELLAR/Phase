import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags";
import { serverDataJsonPath } from "@/lib/server-data-paths";
import { getDb } from "@/lib/sqlite-db";

export type ListingStatus = "active" | "sold" | "cancelled";
export type OfferStatus = "pending" | "accepted" | "rejected" | "expired";

export type Listing = {
  id: string;
  token_id: number;
  collection_id: number;
  seller_wallet: string;
  price_phaselq: number;
  accepts_offers: boolean;
  min_offer?: number;
  image?: string;
  name?: string;
  listed_at: number;
  status: ListingStatus;
  /** phase-140: original minter, for royalty enforcement on secondary sales. */
  creator_wallet?: string;
  /** phase-140: basis points of the sale paid to `creator_wallet` (0-10000). */
  royalty_bps?: number;
};

export type Offer = {
  id: string;
  listing_id: string;
  buyer_wallet: string;
  amount_phaselq: number;
  message?: string;
  created_at: number;
  status: OfferStatus;
  expires_at: number;
};

type ProfileViewAnalyticsStore = Record<string, CreatorProfileViewAnalytics>;

const OFFER_TTL_MS = 48 * 60 * 60 * 1000; // 48h

export const ProfileViewEventSchema = z.object({
  creator_wallet: z
    .string()
    .trim()
    .refine(
      (value) => StrKey.isValidEd25519PublicKey(value),
      "valid creator wallet required",
    ),
  viewer_wallet: z
    .string()
    .trim()
    .refine(
      (value) => StrKey.isValidEd25519PublicKey(value),
      "valid viewer wallet required",
    )
    .optional(),
  source: z.enum(["profile", "market", "dashboard"]).default("profile"),
});

export type ProfileViewEvent = z.infer<typeof ProfileViewEventSchema>;

export type CreatorProfileViewAnalytics = {
  creator_wallet: string;
  total_views: number;
  unique_viewers: number;
  last_viewed_at: number;
  sources: Partial<Record<ProfileViewEvent["source"], number>>;
  viewer_hashes: string[];
};

export class MarketStoreValidationError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED";
  details?: unknown;

  constructor(
    code: MarketStoreValidationError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "MarketStoreValidationError";
    this.code = code;
    this.details = details;
  }
}

export function isPhase100Enabled(): boolean {
  return isFeatureEnabled("phase-100");
}

export function phase100RollbackNote(): string {
  return flagRollbackNote("phase-100");
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

function viewerAnalyticsKey(viewerWallet?: string): string | null {
  if (!viewerWallet) return null;
  return createHash("sha256")
    .update(viewerWallet.toUpperCase(), "utf8")
    .digest("hex");
}

export async function recordCreatorProfileView(
  input: unknown,
  opts: { force?: boolean; now?: number } = {},
): Promise<CreatorProfileViewAnalytics> {
  if (!opts.force && !isPhase100Enabled()) {
    throw new MarketStoreValidationError(
      "FLAG_DISABLED",
      "phase-100 flag disabled",
      {
        rollback: phase100RollbackNote(),
      },
    );
  }

  const parsed = ProfileViewEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new MarketStoreValidationError(
      "VALIDATION_FAILED",
      "valid profile view payload required",
      parsed.error.flatten(),
    );
  }

  const event = parsed.data;
  const now = opts.now ?? Date.now();
  const store = await readJson<ProfileViewAnalyticsStore>(
    serverDataJsonPath("marketProfileViews"),
  );
  const current = store[event.creator_wallet] ?? {
    creator_wallet: event.creator_wallet,
    total_views: 0,
    unique_viewers: 0,
    last_viewed_at: 0,
    sources: {},
    viewer_hashes: [],
  };

  const viewerKey = viewerAnalyticsKey(event.viewer_wallet);
  const viewerHashes =
    viewerKey && !current.viewer_hashes.includes(viewerKey)
      ? [...current.viewer_hashes, viewerKey]
      : current.viewer_hashes;

  const next: CreatorProfileViewAnalytics = {
    ...current,
    total_views: current.total_views + 1,
    unique_viewers: viewerHashes.length,
    last_viewed_at: now,
    sources: {
      ...current.sources,
      [event.source]: (current.sources[event.source] ?? 0) + 1,
    },
    viewer_hashes: viewerHashes,
  };

  store[event.creator_wallet] = next;
  await writeJson(serverDataJsonPath("marketProfileViews"), store);
  return next;
}

export async function getCreatorProfileViewAnalytics(
  creatorWallet: string,
): Promise<CreatorProfileViewAnalytics | null> {
  const store = await readJson<ProfileViewAnalyticsStore>(
    serverDataJsonPath("marketProfileViews"),
  );
  return store[creatorWallet] ?? null;
}

// ── Listings ──────────────────────────────────────────────────────────────────
// Issue #36: backed by SQLite (indexed on status/listed_at, collection_id,
// seller_wallet) instead of parsing the full market-listings.json array on
// every call.

type ListingRow = {
  id: string;
  token_id: number;
  collection_id: number;
  seller_wallet: string;
  price_phaselq: number;
  accepts_offers: number;
  min_offer: number | null;
  image: string | null;
  name: string | null;
  listed_at: number;
  status: ListingStatus;
  creator_wallet: string | null;
  royalty_bps: number | null;
};

function rowToListing(row: ListingRow): Listing {
  return {
    id: row.id,
    token_id: row.token_id,
    collection_id: row.collection_id,
    seller_wallet: row.seller_wallet,
    price_phaselq: row.price_phaselq,
    accepts_offers: row.accepts_offers === 1,
    min_offer: row.min_offer ?? undefined,
    image: row.image ?? undefined,
    name: row.name ?? undefined,
    listed_at: row.listed_at,
    status: row.status,
    creator_wallet: row.creator_wallet ?? undefined,
    royalty_bps: row.royalty_bps ?? undefined,
  };
}

export async function getListing(id: string): Promise<Listing | null> {
  const row = getDb()
    .prepare("SELECT * FROM listings WHERE id = ?")
    .get(id) as ListingRow | undefined;
  return row ? rowToListing(row) : null;
}

export type ListingFilters = {
  collection_id?: number;
  seller_wallet?: string;
  sort?: "price_asc" | "price_desc" | "newest";
  status?: ListingStatus;
};

export async function getListings(
  filters?: ListingFilters,
): Promise<Listing[]> {
  const status = filters?.status ?? "active";
  const conditions: string[] = ["status = ?"];
  const params: unknown[] = [status];

  if (filters?.collection_id !== undefined) {
    conditions.push("collection_id = ?");
    params.push(filters.collection_id);
  }
  if (filters?.seller_wallet) {
    conditions.push("seller_wallet = ?");
    params.push(filters.seller_wallet);
  }

  const sort = filters?.sort ?? "newest";
  const orderBy =
    sort === "price_asc"
      ? "price_phaselq ASC"
      : sort === "price_desc"
        ? "price_phaselq DESC"
        : "listed_at DESC";

  const rows = getDb()
    .prepare(
      `SELECT * FROM listings WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy}`,
    )
    .all(...params) as ListingRow[];

  return rows.map(rowToListing);
}

export async function createListing(
  data: Omit<Listing, "id" | "listed_at" | "status">,
): Promise<Listing> {
  const listing: Listing = {
    ...data,
    id: randomUUID(),
    listed_at: Date.now(),
    status: "active",
  };
  getDb()
    .prepare(
      `INSERT INTO listings
         (id, token_id, collection_id, seller_wallet, price_phaselq,
          accepts_offers, min_offer, image, name, listed_at, status,
          creator_wallet, royalty_bps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      listing.id,
      listing.token_id,
      listing.collection_id,
      listing.seller_wallet,
      listing.price_phaselq,
      listing.accepts_offers ? 1 : 0,
      listing.min_offer ?? null,
      listing.image ?? null,
      listing.name ?? null,
      listing.listed_at,
      listing.status,
      listing.creator_wallet ?? null,
      listing.royalty_bps ?? null,
    );
  return listing;
}

async function setListingStatus(
  id: string,
  status: ListingStatus,
): Promise<Listing | null> {
  const db = getDb();
  const result = db
    .prepare("UPDATE listings SET status = ? WHERE id = ?")
    .run(status, id);
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM listings WHERE id = ?")
    .get(id) as ListingRow;
  return rowToListing(row);
}

export async function cancelListing(id: string): Promise<Listing | null> {
  return setListingStatus(id, "cancelled");
}

export async function soldListing(id: string): Promise<Listing | null> {
  return setListingStatus(id, "sold");
}

// ── Offers ────────────────────────────────────────────────────────────────────
// Issue #36: backed by SQLite (indexed on listing_id, buyer_wallet, and
// status+expires_at for expiration scans) instead of a full-array scan.
// Expiration remains computed lazily on read (matching prior behavior): a
// "pending" offer past `expires_at` is reported as "expired" to callers
// without a write, so no cron/job is required for the common read path.

type OfferRow = {
  id: string;
  listing_id: string;
  buyer_wallet: string;
  amount_phaselq: number;
  message: string | null;
  created_at: number;
  status: OfferStatus;
  expires_at: number;
};

function rowToOffer(row: OfferRow, now: number): Offer {
  const offer: Offer = {
    id: row.id,
    listing_id: row.listing_id,
    buyer_wallet: row.buyer_wallet,
    amount_phaselq: row.amount_phaselq,
    message: row.message ?? undefined,
    created_at: row.created_at,
    status: row.status,
    expires_at: row.expires_at,
  };
  if (offer.status === "pending" && offer.expires_at < now) {
    return { ...offer, status: "expired" };
  }
  return offer;
}

export async function getOffers(listing_id: string): Promise<Offer[]> {
  const now = Date.now();
  const rows = getDb()
    .prepare(
      "SELECT * FROM offers WHERE listing_id = ? ORDER BY created_at DESC",
    )
    .all(listing_id) as OfferRow[];
  return rows.map((row) => rowToOffer(row, now));
}

export async function createOffer(
  data: Omit<Offer, "id" | "created_at" | "status" | "expires_at">,
): Promise<Offer> {
  const offer: Offer = {
    ...data,
    id: randomUUID(),
    created_at: Date.now(),
    status: "pending",
    expires_at: Date.now() + OFFER_TTL_MS,
  };
  getDb()
    .prepare(
      `INSERT INTO offers
         (id, listing_id, buyer_wallet, amount_phaselq, message,
          created_at, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      offer.id,
      offer.listing_id,
      offer.buyer_wallet,
      offer.amount_phaselq,
      offer.message ?? null,
      offer.created_at,
      offer.status,
      offer.expires_at,
    );
  return offer;
}

export async function updateOfferStatus(
  offer_id: string,
  status: OfferStatus,
): Promise<Offer | null> {
  const db = getDb();
  const result = db
    .prepare("UPDATE offers SET status = ? WHERE id = ?")
    .run(status, offer_id);
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM offers WHERE id = ?")
    .get(offer_id) as OfferRow;
  return rowToOffer(row, Date.now());
}

export async function getOffersByBuyer(buyer_wallet: string): Promise<Offer[]> {
  const now = Date.now();
  const rows = getDb()
    .prepare(
      "SELECT * FROM offers WHERE buyer_wallet = ? ORDER BY created_at DESC",
    )
    .all(buyer_wallet) as OfferRow[];
  return rows.map((row) => rowToOffer(row, now));
}

// ── Issue #88 (phase-139): collection-level offer books ────────────────────
//
// Buyers previously had to open each token's listing individually to see
// what it was being offered, and to make a bulk bid across a collection had
// to submit one offer per listing by hand. This module aggregates every
// pending offer across a collection's active listings into a single
// price-leveled order book, and lets a buyer submit one bulk-bid request
// that fans out into individual per-listing offers (reusing `createOffer`
// unchanged, so accept/reject/expiry behave exactly as before).
//
// Feature flag: phase-139 (NEXT_PUBLIC_FEATURE_PHASE_139 / FEATURE_PHASE_139)
// Rollback: unset the flag → the offer-book route returns 404 and bulk bids
//           are rejected; per-listing offers (`/api/market/[id]/offers`) are
//           untouched either way. No data migration to undo.

export function isPhase139Enabled(): boolean {
  return isFeatureEnabled("phase-139");
}

export function phase139RollbackNote(): string {
  return flagRollbackNote("phase-139");
}

export type CollectionOfferBookEntry = {
  offer_id: string;
  listing_id: string;
  token_id: number;
  buyer_wallet: string;
  created_at: number;
  expires_at: number;
};

export type CollectionOfferBookLevel = {
  price_phaselq: number;
  offer_count: number;
  total_amount_phaselq: number;
  offers: CollectionOfferBookEntry[];
};

export type CollectionOfferBook = {
  collection_id: number;
  listings_with_offers: number;
  total_pending_offers: number;
  best_offer_phaselq: number | null;
  levels: CollectionOfferBookLevel[];
};

type CollectionOfferRow = OfferRow & { token_id: number };

/** Aggregates every non-expired, pending offer across a collection's active listings into price levels, best price first. */
export async function getCollectionOfferBook(
  collection_id: number,
): Promise<CollectionOfferBook> {
  const now = Date.now();
  const rows = getDb()
    .prepare(
      `SELECT o.*, l.token_id AS token_id
       FROM offers o
       JOIN listings l ON l.id = o.listing_id
       WHERE l.collection_id = ? AND l.status = 'active' AND o.status = 'pending'
       ORDER BY o.amount_phaselq DESC, o.created_at ASC`,
    )
    .all(collection_id) as CollectionOfferRow[];

  const levelsByPrice = new Map<number, CollectionOfferBookLevel>();
  const listingsWithOffers = new Set<string>();
  let totalPendingOffers = 0;

  for (const row of rows) {
    if (row.expires_at < now) continue; // lazily-expired, matches rowToOffer semantics
    totalPendingOffers += 1;
    listingsWithOffers.add(row.listing_id);

    let level = levelsByPrice.get(row.amount_phaselq);
    if (!level) {
      level = { price_phaselq: row.amount_phaselq, offer_count: 0, total_amount_phaselq: 0, offers: [] };
      levelsByPrice.set(row.amount_phaselq, level);
    }
    level.offer_count += 1;
    level.total_amount_phaselq += row.amount_phaselq;
    level.offers.push({
      offer_id: row.id,
      listing_id: row.listing_id,
      token_id: row.token_id,
      buyer_wallet: row.buyer_wallet,
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
  }

  const levels = [...levelsByPrice.values()].sort((a, b) => b.price_phaselq - a.price_phaselq);

  return {
    collection_id,
    listings_with_offers: listingsWithOffers.size,
    total_pending_offers: totalPendingOffers,
    best_offer_phaselq: levels[0]?.price_phaselq ?? null,
    levels,
  };
}

export type BulkOfferTarget = { listing_id: string; amount_phaselq: number };

export type BulkOfferSkipReason =
  | "not_found"
  | "inactive"
  | "offers_disabled"
  | "own_listing"
  | "below_min_offer"
  | "invalid_amount";

export type BulkOfferResult = {
  created: Offer[];
  skipped: Array<{ listing_id: string; reason: BulkOfferSkipReason }>;
};

export const MAX_BULK_OFFER_TARGETS = 20;

/** Fans a single buyer intent out into one `createOffer` per target listing, skipping (not throwing on) any listing that can't accept it. */
export async function createBulkOffer(
  buyer_wallet: string,
  targets: BulkOfferTarget[],
): Promise<BulkOfferResult> {
  const created: Offer[] = [];
  const skipped: BulkOfferResult["skipped"] = [];

  for (const target of targets) {
    if (!Number.isFinite(target.amount_phaselq) || target.amount_phaselq <= 0) {
      skipped.push({ listing_id: target.listing_id, reason: "invalid_amount" });
      continue;
    }
    const listing = await getListing(target.listing_id);
    if (!listing) {
      skipped.push({ listing_id: target.listing_id, reason: "not_found" });
      continue;
    }
    if (listing.status !== "active") {
      skipped.push({ listing_id: target.listing_id, reason: "inactive" });
      continue;
    }
    if (!listing.accepts_offers) {
      skipped.push({ listing_id: target.listing_id, reason: "offers_disabled" });
      continue;
    }
    if (listing.seller_wallet === buyer_wallet) {
      skipped.push({ listing_id: target.listing_id, reason: "own_listing" });
      continue;
    }
    if (listing.min_offer !== undefined && target.amount_phaselq < listing.min_offer) {
      skipped.push({ listing_id: target.listing_id, reason: "below_min_offer" });
      continue;
    }
    const offer = await createOffer({
      listing_id: target.listing_id,
      buyer_wallet,
      amount_phaselq: target.amount_phaselq,
    });
    created.push(offer);
  }

  return { created, skipped };
}

// ── Issue #89 (phase-140): royalty enforcement on secondary sales ──────────
//
// Accepting an offer marked the listing sold but moved no value to the
// original creator on a resale — only the current seller and buyer were
// party to the transaction. This module computes the creator/seller split
// for a listing's `royalty_bps` (set at listing time, see `createListing`)
// and records it as a settlement-ready ledger line at accept time. It is a
// secondary sale whenever the seller isn't the original creator; a primary
// sale (creator selling their own mint) pays no royalty since seller and
// creator are the same wallet.
//
// Feature flag: phase-140 (NEXT_PUBLIC_FEATURE_PHASE_140 / FEATURE_PHASE_140)
// Rollback: unset the flag → `createListing`/`app/api/market` stop accepting
//           `creator_wallet`/`royalty_bps`, and offer-accept stops computing
//           a split (money continues to move 100% to the seller, pre-140
//           behavior). Existing `royalty_payouts` rows are historical record
//           and are simply no longer written to; no migration to undo.

export function isPhase140Enabled(): boolean {
  return isFeatureEnabled("phase-140");
}

export function phase140RollbackNote(): string {
  return flagRollbackNote("phase-140");
}

export type RoyaltySplit = {
  is_secondary_sale: boolean;
  royalty_bps: number;
  royalty_amount_phaselq: number;
  seller_amount_phaselq: number;
};

/** Pure computation: how a `sale_amount_phaselq` sale of `listing` splits between creator and seller. Returns a zero split for a primary sale or a listing with no royalty configured. */
export function computeRoyaltySplit(
  listing: Pick<Listing, "seller_wallet" | "creator_wallet" | "royalty_bps">,
  sale_amount_phaselq: number,
): RoyaltySplit {
  const isSecondary =
    !!listing.creator_wallet && listing.creator_wallet !== listing.seller_wallet;
  const royaltyBps = isSecondary ? (listing.royalty_bps ?? 0) : 0;
  const royaltyAmount = Math.round(sale_amount_phaselq * (royaltyBps / 10_000) * 1e7) / 1e7;
  return {
    is_secondary_sale: isSecondary,
    royalty_bps: royaltyBps,
    royalty_amount_phaselq: royaltyAmount,
    seller_amount_phaselq: sale_amount_phaselq - royaltyAmount,
  };
}

export type RoyaltyPayout = RoyaltySplit & {
  id: string;
  listing_id: string;
  offer_id: string;
  creator_wallet: string;
  seller_wallet: string;
  sale_amount_phaselq: number;
  created_at: number;
};

type RoyaltyPayoutRow = {
  id: string;
  listing_id: string;
  offer_id: string;
  creator_wallet: string;
  seller_wallet: string;
  sale_amount_phaselq: number;
  royalty_bps: number;
  royalty_amount_phaselq: number;
  seller_amount_phaselq: number;
  created_at: number;
};

function rowToRoyaltyPayout(row: RoyaltyPayoutRow): RoyaltyPayout {
  return {
    id: row.id,
    listing_id: row.listing_id,
    offer_id: row.offer_id,
    creator_wallet: row.creator_wallet,
    seller_wallet: row.seller_wallet,
    sale_amount_phaselq: row.sale_amount_phaselq,
    is_secondary_sale: true,
    royalty_bps: row.royalty_bps,
    royalty_amount_phaselq: row.royalty_amount_phaselq,
    seller_amount_phaselq: row.seller_amount_phaselq,
    created_at: row.created_at,
  };
}

/** Records a non-zero royalty split for an accepted offer. Callers only invoke this for a secondary sale with `royalty_bps > 0` — a primary sale has nothing to record. */
export async function recordRoyaltyPayout(
  listing: Pick<Listing, "id" | "seller_wallet" | "creator_wallet">,
  offer_id: string,
  split: RoyaltySplit,
): Promise<RoyaltyPayout> {
  if (!listing.creator_wallet) {
    throw new MarketStoreValidationError("VALIDATION_FAILED", "listing has no creator_wallet");
  }
  const payout: RoyaltyPayout = {
    ...split,
    id: randomUUID(),
    listing_id: listing.id,
    offer_id,
    creator_wallet: listing.creator_wallet,
    seller_wallet: listing.seller_wallet,
    sale_amount_phaselq: split.royalty_amount_phaselq + split.seller_amount_phaselq,
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO royalty_payouts
         (id, listing_id, offer_id, creator_wallet, seller_wallet,
          sale_amount_phaselq, royalty_bps, royalty_amount_phaselq,
          seller_amount_phaselq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      payout.id,
      payout.listing_id,
      payout.offer_id,
      payout.creator_wallet,
      payout.seller_wallet,
      payout.sale_amount_phaselq,
      payout.royalty_bps,
      payout.royalty_amount_phaselq,
      payout.seller_amount_phaselq,
      payout.created_at,
    );
  return payout;
}

export async function getRoyaltyPayoutsForCreator(
  creator_wallet: string,
): Promise<RoyaltyPayout[]> {
  const rows = getDb()
    .prepare("SELECT * FROM royalty_payouts WHERE creator_wallet = ? ORDER BY created_at DESC")
    .all(creator_wallet) as RoyaltyPayoutRow[];
  return rows.map(rowToRoyaltyPayout);
}

// ── Issue #103: Mute and Block Primitives (phase-85) ─────────────────────────

type BlockedWallet = { wallet: string; blocked_at: number; reason?: string };
type MutedWallet = { wallet: string; muted_at: number; expires_at?: number };
type UserBlockList = { blocked: BlockedWallet[]; muted: MutedWallet[] };
type BlockListStore = Record<string, UserBlockList>;

export function isPhase85Enabled(): boolean {
  return isFeatureEnabled("phase-85");
}

export async function getBlockList(wallet: string): Promise<UserBlockList> {
  if (!isPhase85Enabled()) return { blocked: [], muted: [] };
  const store = await readJson<BlockListStore>(serverDataJsonPath("blockList"));
  return store[wallet] ?? { blocked: [], muted: [] };
}

export async function blockWallet(
  blocker: string,
  target: string,
  reason?: string,
): Promise<void> {
  if (!isPhase85Enabled()) throw new Error("phase-85 disabled");
  const store = await readJson<BlockListStore>(serverDataJsonPath("blockList"));
  const list = store[blocker] ?? { blocked: [], muted: [] };
  if (!list.blocked.some((b) => b.wallet === target)) {
    list.blocked.push({ wallet: target, blocked_at: Date.now(), reason });
  }
  store[blocker] = list;
  await writeJson(serverDataJsonPath("blockList"), store);
}

export async function unblockWallet(
  blocker: string,
  target: string,
): Promise<void> {
  if (!isPhase85Enabled()) throw new Error("phase-85 disabled");
  const store = await readJson<BlockListStore>(serverDataJsonPath("blockList"));
  const list = store[blocker] ?? { blocked: [], muted: [] };
  list.blocked = list.blocked.filter((b) => b.wallet !== target);
  store[blocker] = list;
  await writeJson(serverDataJsonPath("blockList"), store);
}

export async function muteWallet(
  muter: string,
  target: string,
  durationMs?: number,
): Promise<void> {
  if (!isPhase85Enabled()) throw new Error("phase-85 disabled");
  const store = await readJson<BlockListStore>(serverDataJsonPath("blockList"));
  const list = store[muter] ?? { blocked: [], muted: [] };
  list.muted = list.muted.filter((m) => m.wallet !== target);
  list.muted.push({
    wallet: target,
    muted_at: Date.now(),
    expires_at: durationMs ? Date.now() + durationMs : undefined,
  });
  store[muter] = list;
  await writeJson(serverDataJsonPath("blockList"), store);
}

export async function unmuteWallet(
  muter: string,
  target: string,
): Promise<void> {
  if (!isPhase85Enabled()) throw new Error("phase-85 disabled");
  const store = await readJson<BlockListStore>(serverDataJsonPath("blockList"));
  const list = store[muter] ?? { blocked: [], muted: [] };
  list.muted = list.muted.filter((m) => m.wallet !== target);
  store[muter] = list;
  await writeJson(serverDataJsonPath("blockList"), store);
}

export async function isWalletBlocked(
  viewer: string,
  target: string,
): Promise<boolean> {
  if (!isPhase85Enabled()) return false;
  const list = await getBlockList(viewer);
  return list.blocked.some((b) => b.wallet === target);
}

export async function isWalletMuted(
  viewer: string,
  target: string,
): Promise<boolean> {
  if (!isPhase85Enabled()) return false;
  const list = await getBlockList(viewer);
  const now = Date.now();
  return list.muted.some(
    (m) => m.wallet === target && (!m.expires_at || m.expires_at > now),
  );
}

export async function filterBlockedOffers(
  offers: Offer[],
  viewer_wallet?: string,
): Promise<Offer[]> {
  if (!viewer_wallet || !isPhase85Enabled()) return offers;
  const list = await getBlockList(viewer_wallet);
  const blocked = new Set(list.blocked.map((b) => b.wallet));
  return offers.filter((o) => !blocked.has(o.buyer_wallet));
}
