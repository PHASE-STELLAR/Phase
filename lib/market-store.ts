// @ts-nocheck
import { createHash, randomUUID } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { isFeatureEnabled, flagRollbackNote } from "@/lib/feature-flags";
import { readJsonFile, updateJsonFile } from "@/lib/json-store";
import { serverDataJsonPath } from "@/lib/server-data-paths";
import { getDb } from "@/lib/sqlite-db";
import { incSecurityCounter } from "@/lib/security-counters";
import { recordTaxEvent } from "@/lib/tax-report";
import { decimalToStroops } from "@/lib/decimal-amount";
import { phaseProtocolContractIdForServer } from "@/lib/phase-protocol";

export type ListingStatus = "active" | "sold" | "cancelled";
export type OfferStatus = "pending" | "accepted" | "rejected" | "expired";

export type Listing = {
  id: string;
  token_id: number;
  contract_id?: string;
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
  /** Spike 673 (phase-editions): 1-based edition index within collection; edition_size = limited cap. */
  edition_number?: number;
  edition_size?: number;
  /** Spike 673: artist-proof hold, excluded from public sale but still enumerable. */
  is_artist_proof?: boolean;
  /** Spike 673: 'limited' | 'open' — open editions are time-boxed, limited are supply-capped. */
  supply_mode?: 'limited' | 'open';
  /** Spike 672 (phase-timed-drops): ms epoch window; null = always live. */
  drop_start_at?: number;
  drop_end_at?: number;
  /** Spike 675 (phase-dutch-auction): descending primary price; nulls = fixed price. */
  dutch_start_price?: number;
  dutch_floor_price?: number;
  dutch_end_at?: number;
  /** Spike 674 (phase-collab-splits): N-way payees, sum bps <= 10000. */
  split_payees?: Array<{ wallet: string; bps: number }>;
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
  return readJsonFile<T>(filePath, {} as T);
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

  // The counters are derived from the snapshot read here, so this has to be one
  // locked mutation: an unguarded read-then-write dropped concurrent views.
  return updateJsonFile<ProfileViewAnalyticsStore, CreatorProfileViewAnalytics>(
    serverDataJsonPath("marketProfileViews"),
    {
      mutate: (store) => {
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
        return next;
      },
    },
  );
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
  contract_id: string | null;
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
  edition_number: number | null;
  edition_size: number | null;
  is_artist_proof: number | null;
  supply_mode: string | null;
  drop_start_at: number | null;
  drop_end_at: number | null;
  dutch_start_price: number | null;
  dutch_floor_price: number | null;
  dutch_end_at: number | null;
  split_payees_json: string | null;
};

function rowToListing(row: ListingRow): Listing {
  return {
    id: row.id,
    token_id: row.token_id,
    contract_id: row.contract_id ?? undefined,
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
    edition_number: row.edition_number ?? undefined,
    edition_size: row.edition_size ?? undefined,
    is_artist_proof: row.is_artist_proof === 1 ? true : undefined,
    supply_mode: row.supply_mode === 'limited' || row.supply_mode === 'open' ? row.supply_mode : undefined,
    drop_start_at: row.drop_start_at ?? undefined,
    drop_end_at: row.drop_end_at ?? undefined,
    dutch_start_price: row.dutch_start_price ?? undefined,
    dutch_floor_price: row.dutch_floor_price ?? undefined,
    dutch_end_at: row.dutch_end_at ?? undefined,
    split_payees: (() => { try { const v = row.split_payees_json ? JSON.parse(row.split_payees_json) : undefined; return Array.isArray(v) ? v : undefined; } catch { return undefined; } })(),
  };
}

export function isPhaseEditionsEnabled(): boolean { return isFeatureEnabled('phase-editions'); }
export function isPhaseCollabSplitsEnabled(): boolean { return isFeatureEnabled('phase-collab-splits'); }
export function isPhaseTimedDropsEnabled(): boolean { return isFeatureEnabled('phase-timed-drops'); }
export function isPhaseDutchAuctionEnabled(): boolean { return isFeatureEnabled('phase-dutch-auction'); }
export function phaseEditionsRollbackNote(): string { return flagRollbackNote('phase-editions'); }
export function phaseCollabSplitsRollbackNote(): string { return flagRollbackNote('phase-collab-splits'); }
export function phaseTimedDropsRollbackNote(): string { return flagRollbackNote('phase-timed-drops'); }
export function phaseDutchAuctionRollbackNote(): string { return flagRollbackNote('phase-dutch-auction'); }

// ── Spike 574 (issue #438, phase-182): pool-denominated price reference ──
// Listings are priced in PHASELQ. Displaying an XLM equivalent needs the pool's
// spot AND the execution price for a specific size: a thin testnet pool moves
// double digits, so a spot-only number is misleading. This is read-only; the
// write path (offers) never blocks on a pool outage.
export function isPhase182Enabled(wallet?: string): boolean {
  return isFeatureEnabled('phase-182', wallet ? { wallet } : undefined);
}

export function phase182RollbackNote(): string {
  return flagRollbackNote('phase-182');
}

export type PoolDenominatedPrice = {
  price_phaselq: number
  amount_phaselq: number
  amount_xlm_spot: number
  amount_xlm_execution: number
  spot_price_xlm: number
  execution_price_xlm: number
  price_impact_bps: number
  quote_hash: string
  /** True when the quote came from a cached reserve snapshot after an outage. */
  stale: boolean
}

/** Convert a PHASELQ-denominated listing (or offer) into both XLM readings. */
export function denoteListingInPool(
  pricePhaselq: number,
  quote: {
    spotPrice: number
    executionPrice: number
    priceImpactBps: number
    amountInStroops: bigint
    quoteHash: string
    stale: boolean
  },
  amountPhaselq: number = pricePhaselq,
): PoolDenominatedPrice {
  return {
    price_phaselq: pricePhaselq,
    amount_phaselq: amountPhaselq,
    amount_xlm_spot: amountPhaselq * quote.spotPrice,
    amount_xlm_execution: amountPhaselq * quote.executionPrice,
    spot_price_xlm: quote.spotPrice,
    execution_price_xlm: quote.executionPrice,
    price_impact_bps: quote.priceImpactBps,
    quote_hash: quote.quoteHash,
    stale: quote.stale,
  }
}

/** Spike 673: 'Edition X/Y' label, or 'Artist Proof' for AP holds. Pure. */
export function editionBadge(listing: Pick<Listing, 'edition_number' | 'edition_size' | 'is_artist_proof'>): string | null {
  if (listing.is_artist_proof) return 'Artist Proof';
  if (listing.edition_number != null && listing.edition_size != null) return `Edition ${listing.edition_number}/${listing.edition_size}`;
  if (listing.edition_number != null) return `Edition ${listing.edition_number}`;
  return null;
}

/** Spike 673: validate edition fields. AP entries must carry edition_number; limited needs size. */
export function validateEditionFields(l: Pick<Listing, 'edition_number' | 'edition_size' | 'is_artist_proof' | 'supply_mode'>): { valid: boolean; error?: string } {
  if (l.edition_number == null && l.edition_size == null && !l.is_artist_proof && !l.supply_mode) return { valid: true };
  if (!isPhaseEditionsEnabled()) return { valid: false, error: 'phase-editions flag disabled' };
  if (l.edition_number != null && (!Number.isInteger(l.edition_number) || l.edition_number < 1)) return { valid: false, error: 'edition_number must be a positive integer' };
  if (l.edition_size != null && (!Number.isInteger(l.edition_size) || l.edition_size < 1)) return { valid: false, error: 'edition_size must be a positive integer' };
  if (l.edition_number != null && l.edition_size != null && l.edition_number > l.edition_size) return { valid: false, error: 'edition_number exceeds edition_size' };
  if (l.is_artist_proof && l.edition_number == null) return { valid: false, error: 'artist proof requires edition_number' };
  if (l.supply_mode && l.supply_mode !== 'limited' && l.supply_mode !== 'open') return { valid: false, error: 'supply_mode must be limited or open' };
  return { valid: true };
}

/** Spike 672: drop-window state machine. NULL window = always live (legacy). Pure. */
export type DropStatus = 'live' | 'upcoming' | 'ended';
export function dropStatusForListing(l: Pick<Listing, 'drop_start_at' | 'drop_end_at'>, now = Date.now()): DropStatus {
  if (l.drop_start_at != null && now < l.drop_start_at) return 'upcoming';
  if (l.drop_end_at != null && now > l.drop_end_at) return 'ended';
  return 'live';
}

/** Spike 675: deterministic descending price. NULL range = fixed price_phaselq. Pure. */
export function currentDutchPrice(l: Pick<Listing, 'price_phaselq' | 'dutch_start_price' | 'dutch_floor_price' | 'dutch_end_at' | 'listed_at'>, now = Date.now()): number {
  if (!isPhaseDutchAuctionEnabled()) return l.price_phaselq;
  const start = l.dutch_start_price ?? l.price_phaselq;
  const floor = l.dutch_floor_price ?? l.price_phaselq;
  const end = l.dutch_end_at;
  if (end == null || end <= l.listed_at) return l.price_phaselq;
  if (now <= l.listed_at) return start;
  if (now >= end) return floor;
  const t = (now - l.listed_at) / (end - l.listed_at);
  return Math.max(floor, start - (start - floor) * t);
}

/** Spike 674: N-way split math. Remainder (dust) goes to first payee. Pure. */
export type CollabPayee = { wallet: string; bps: number };
export function computeCollabSplits(sale_amount_phaselq: number, payees: CollabPayee[]): Array<CollabPayee & { amount_phaselq: number }> {
  const total = payees.reduce((a, p) => a + p.bps, 0);
  if (total > 10000) throw new MarketStoreValidationError('VALIDATION_FAILED', 'split bps exceed 10000');
  let assigned = 0;
  const out = payees.map((p, i) => {
    if (i < payees.length - 1) {
      const amt = Math.round(sale_amount_phaselq * (p.bps / 10000) * 1e7) / 1e7;
      assigned += amt;
      return { ...p, amount_phaselq: amt };
    }
    return { ...p, amount_phaselq: Math.round((sale_amount_phaselq - assigned) * 1e7) / 1e7 };
  });
  try { void incSecurityCounter('collab_split_dust_rounded'); } catch {}
  return out;
}

export type SaleSplitRow = { id: string; listing_id: string; offer_id: string; payee_wallet: string; bps: number; amount_phaselq: number; created_at: number };

/** Spike 674: fan-out record at settle/accept time. Skips when flag off (caller guards). */
export async function recordCollabSplits(listing_id: string, offer_id: string, splits: Array<CollabPayee & { amount_phaselq: number }>): Promise<SaleSplitRow[]> {
  const now = Date.now();
  const rows = splits.map((sp) => ({ id: randomUUID(), listing_id, offer_id, payee_wallet: sp.wallet, bps: sp.bps, amount_phaselq: sp.amount_phaselq, created_at: now }));
  const db = getDb();
  for (const r of rows) {
    db.prepare('INSERT INTO sale_splits (id, listing_id, offer_id, payee_wallet, bps, amount_phaselq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.id, r.listing_id, r.offer_id, r.payee_wallet, r.bps, r.amount_phaselq, r.created_at);
  }
  try { void incSecurityCounter('collab_split_recorded'); } catch {}
  return rows;
}

export async function getSaleSplitsForListing(listing_id: string): Promise<SaleSplitRow[]> {
  return getDb().prepare('SELECT * FROM sale_splits WHERE listing_id = ? ORDER BY created_at ASC').all(listing_id) as SaleSplitRow[];
}

/** Spike 672: ordered queue ticket (FIFO by position). Unique per (collection, wallet) — replay-safe. */
export async function issueDropTicket(collection_id: number, wallet: string): Promise<{ id: string; position: number }> {
  const db = getDb();
  const existing = db.prepare('SELECT id, position FROM drop_tickets WHERE collection_id = ? AND wallet = ?').get(collection_id, wallet) as { id: string; position: number } | undefined;
  if (existing) return existing;
  const maxRow = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM drop_tickets WHERE collection_id = ?').get(collection_id) as { m: number };
  const position = (maxRow?.m ?? 0) + 1;
  const id = randomUUID();
  db.prepare('INSERT INTO drop_tickets (id, collection_id, wallet, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, collection_id, wallet, position, Date.now());
  try { void incSecurityCounter('drop_queue_ticket_issued'); } catch {}
  return { id, position };
}

export async function redeemDropTicket(collection_id: number, wallet: string): Promise<boolean> {
  const r = getDb().prepare('UPDATE drop_tickets SET redeemed_at = ? WHERE collection_id = ? AND wallet = ? AND redeemed_at IS NULL').run(Date.now(), collection_id, wallet);
  return r.changes === 1;
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
  sort?: "price_asc" | "price_desc" | "newest" | "edition_asc";
  status?: ListingStatus;
  drop?: 'live' | 'upcoming' | 'ended';
  exclude_artist_proof?: boolean;
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

  if (filters?.exclude_artist_proof) {
    conditions.push("(is_artist_proof IS NULL OR is_artist_proof = 0)");
  }
  if (filters?.drop) {
    const now = Date.now();
    if (filters.drop === 'live') {
      conditions.push('(drop_start_at IS NULL OR drop_start_at <= ?)');
      params.push(now);
      conditions.push('(drop_end_at IS NULL OR drop_end_at >= ?)');
      params.push(now);
    } else if (filters.drop === 'upcoming') {
      conditions.push('drop_start_at IS NOT NULL AND drop_start_at > ?');
      params.push(now);
    } else {
      conditions.push('drop_end_at IS NOT NULL AND drop_end_at < ?');
      params.push(now);
    }
  }

  const sort = filters?.sort ?? "newest";
  const orderBy =
    sort === "price_asc"
      ? "price_phaselq ASC"
      : sort === "price_desc"
        ? "price_phaselq DESC"
        : sort === "edition_asc"
          ? "edition_number ASC NULLS LAST, listed_at DESC"
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
    contract_id: isFeatureEnabled("phase-177") ? phaseProtocolContractIdForServer() : undefined,
    id: randomUUID(),
    listed_at: Date.now(),
    status: "active",
  };
  const editionCheck = validateEditionFields(listing);
  if (!editionCheck.valid) {
    throw new MarketStoreValidationError("VALIDATION_FAILED", editionCheck.error ?? "invalid edition fields");
  }
  if (listing.split_payees && listing.split_payees.length > 0) {
    if (!isPhaseCollabSplitsEnabled()) {
      throw new MarketStoreValidationError("FLAG_DISABLED", "phase-collab-splits flag disabled");
    }
    const total = listing.split_payees.reduce((a, p) => a + p.bps, 0);
    if (total > 10000) throw new MarketStoreValidationError("VALIDATION_FAILED", "split bps exceed 10000");
    if (listing.split_payees.length > 20) throw new MarketStoreValidationError("VALIDATION_FAILED", "too many payees (max 20)");
  }
  if ((listing.drop_start_at != null || listing.drop_end_at != null) && !isPhaseTimedDropsEnabled()) {
    throw new MarketStoreValidationError("FLAG_DISABLED", "phase-timed-drops flag disabled");
  }
  if ((listing.dutch_start_price != null || listing.dutch_floor_price != null || listing.dutch_end_at != null) && !isPhaseDutchAuctionEnabled()) {
    throw new MarketStoreValidationError("FLAG_DISABLED", "phase-dutch-auction flag disabled");
  }
  getDb()
    .prepare(
      `INSERT INTO listings
         (id, token_id, collection_id, seller_wallet, price_phaselq,
          accepts_offers, min_offer, image, name, listed_at, status,
          creator_wallet, royalty_bps, edition_number, edition_size, is_artist_proof, supply_mode,
          drop_start_at, drop_end_at, dutch_start_price, dutch_floor_price, dutch_end_at, split_payees_json, contract_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      listing.edition_number ?? null,
      listing.edition_size ?? null,
      listing.is_artist_proof ? 1 : 0,
      listing.supply_mode ?? null,
      listing.drop_start_at ?? null,
      listing.drop_end_at ?? null,
      listing.dutch_start_price ?? null,
      listing.dutch_floor_price ?? null,
      listing.dutch_end_at ?? null,
      listing.split_payees ? JSON.stringify(listing.split_payees) : null,
      listing.contract_id ?? null,
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
  const listing = await getListing(id);
  if (listing) {
    const { assertNoLegalHold } = await import("@/lib/legal-hold");
    await assertNoLegalHold("listing", id, "cancel_listing", listing.seller_wallet);
  }
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
  // Issue #230: screen every offer for wash patterns. The offer is still
  // created (flag, not block — see lib/wash-screening.ts), but a flagged offer
  // is marked and excluded from every volume aggregate, which is where the
  // inflation in this issue actually lands.
  let washFlagged = false
  let washReason: string | null = null
  try {
    const { screenOfferForWash } = await import("@/lib/wash-screening")
    const listing = await getListing(data.listing_id)
    if (listing) {
      const screen = screenOfferForWash({
        listingId: listing.id,
        tokenId: listing.token_id,
        sellerWallet: listing.seller_wallet,
        buyerWallet: data.buyer_wallet,
        amountPhaselq: data.amount_phaselq,
      })
      washFlagged = screen.washFlagged
      washReason = screen.washReason
    }
  } catch (error) {
    // Screening must never block a legitimate offer; on failure the offer is
    // created unflagged and the omission is visible via volume drift.
    console.warn("[phase-230] wash screening failed, creating unflagged offer:", error)
    void incSecurityCounter("market_volume_drift")
  }

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
          created_at, status, expires_at, wash_flagged, wash_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      washFlagged ? 1 : 0,
      washReason,
    );
  return offer;
}

export async function updateOfferStatus(
  offer_id: string,
  status: OfferStatus,
): Promise<Offer | null> {
  const db = getDb();
  const result = db
    .prepare("UPDATE offers SET status = ?, decided_at = ? WHERE id = ?")
    .run(status, status === "accepted" || status === "rejected" ? Date.now() : null, offer_id);
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM offers WHERE id = ?")
    .get(offer_id) as OfferRow;
  return rowToOffer(row, Date.now());
}

/** One SQLite transaction owns the decision and its reporting evidence. */
export function decideOfferAtomic(listingId: string, offerId: string, wallet: string, action: "accept" | "reject") {
  const db = getDb()
  let taxRecords = 0
  db.exec("BEGIN IMMEDIATE")
  try {
    const listingRow = db.prepare("SELECT * FROM listings WHERE id=?").get(listingId) as ListingRow | undefined
    const offerRow = db.prepare("SELECT * FROM offers WHERE id=? AND listing_id=?").get(offerId, listingId) as OfferRow | undefined
    if (!listingRow || !offerRow || listingRow.seller_wallet !== wallet) throw new Error("FORBIDDEN")
    const now = Date.now()
    if (listingRow.status !== "active" || offerRow.status !== "pending" || offerRow.expires_at <= now || offerRow.buyer_wallet === wallet) {
      incSecurityCounter("market_accept_conflict")
      throw Object.assign(new Error("OFFER_CONFLICT"), { current_status: offerRow.expires_at <= now ? "expired" : offerRow.status })
    }
    const status = action === "accept" ? "accepted" : "rejected"
    db.prepare("UPDATE offers SET status=?, decided_at=? WHERE id=? AND status='pending'").run(status, now, offerId)
    if (action === "accept") {
      db.prepare("UPDATE listings SET status='sold' WHERE id=? AND status='active'").run(listingId)
      db.prepare("UPDATE offers SET status='rejected', decided_at=? WHERE listing_id=? AND id<>? AND status='pending'").run(now, listingId, offerId)
      if (isFeatureEnabled("phase-177")) {
        const listing = rowToListing(listingRow)
        const split = isPhase140Enabled() ? computeRoyaltySplit(listing, offerRow.amount_phaselq) : { seller_amount_phaselq: offerRow.amount_phaselq, royalty_amount_phaselq: 0 }
        const asset = `${listing.contract_id ?? `unknown-contract:${listing.id}`}:${listing.token_id}`
        // Offer acceptance is an agreement, not a chain receipt. Never report it as verified proceeds.
        const common = { asset, occurredAt: now, verified: false, washFlagged: !!offerRow.wash_flagged }
        taxRecords += Number(recordTaxEvent({ ...common, eventKey: `offer:${offerId}:seller`, wallet, kind: "disposal", amountStroops: decimalToStroops(split.seller_amount_phaselq.toFixed(7)) }, false))
        taxRecords += Number(recordTaxEvent({ ...common, eventKey: `offer:${offerId}:buyer`, wallet: offerRow.buyer_wallet, kind: "acquisition", amountStroops: decimalToStroops(offerRow.amount_phaselq.toFixed(7)) }, false))
        if (listing.creator_wallet && split.royalty_amount_phaselq > 0) taxRecords += Number(recordTaxEvent({ ...common, eventKey: `offer:${offerId}:royalty`, wallet: listing.creator_wallet, kind: "royalty", amountStroops: decimalToStroops(split.royalty_amount_phaselq.toFixed(7)) }, false))
      }
    }
    db.exec("COMMIT")
    if (taxRecords) incSecurityCounter("tax_event_recorded", taxRecords)
    return rowToOffer({ ...offerRow, status }, now)
  } catch (error) { db.exec("ROLLBACK"); throw error }
}

export async function getOffersByBuyer(
  buyer_wallet: string,
  opts: { limit?: number; cursor?: number } = {},
): Promise<Offer[]> {
  const now = Date.now();
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 50)));
  const cursor = Number.isFinite(opts.cursor) ? Math.max(0, Math.floor(opts.cursor!)) : 0;
  const rows = getDb()
    .prepare(
      "SELECT * FROM offers WHERE buyer_wallet = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .all(buyer_wallet, limit, cursor) as OfferRow[];
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
  await updateJsonFile<BlockListStore>(serverDataJsonPath("blockList"), {
    mutate: (store) => {
      const list = store[blocker] ?? { blocked: [], muted: [] };
      if (!list.blocked.some((b) => b.wallet === target)) {
        list.blocked.push({ wallet: target, blocked_at: Date.now(), reason });
      }
      store[blocker] = list;
    },
  });
}

export async function unblockWallet(
  blocker: string,
  target: string,
): Promise<void> {
  if (!isPhase85Enabled()) throw new Error("phase-85 disabled");
  await updateJsonFile<BlockListStore>(serverDataJsonPath("blockList"), {
    mutate: (store) => {
      const list = store[blocker] ?? { blocked: [], muted: [] };
      list.blocked = list.blocked.filter((b) => b.wallet !== target);
      store[blocker] = list;
    },
  });
}

export async function muteWallet(
  muter: string,
  target: string,
  durationMs?: number,
): Promise<void> {
  if (!isPhase85Enabled()) throw new Error("phase-85 disabled");
  await updateJsonFile<BlockListStore>(serverDataJsonPath("blockList"), {
    mutate: (store) => {
      const list = store[muter] ?? { blocked: [], muted: [] };
      list.muted = list.muted.filter((m) => m.wallet !== target);
      list.muted.push({
        wallet: target,
        muted_at: Date.now(),
        expires_at: durationMs ? Date.now() + durationMs : undefined,
      });
      store[muter] = list;
    },
  });
}

export async function unmuteWallet(
  muter: string,
  target: string,
): Promise<void> {
  if (!isPhase85Enabled()) throw new Error("phase-85 disabled");
  await updateJsonFile<BlockListStore>(serverDataJsonPath("blockList"), {
    mutate: (store) => {
      const list = store[muter] ?? { blocked: [], muted: [] };
      list.muted = list.muted.filter((m) => m.wallet !== target);
      store[muter] = list;
    },
  });
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


// ── phase-142 / phase-143: sale comps ─────────────────────────────────────────
//
// A "sale" in this market is an accepted offer: that is the only row recording
// a price two parties agreed on. royalty_payouts is keyed by offer_id and holds
// the same sale again (split into creator/seller parts), so comps are read from
// offers only and joined to royalty_payouts by offer_id where the split matters
// — summing both tables would count every secondary sale twice.
//
// Pending offers are bids, not sales. Expiry is lazy (rowToOffer reports a
// stale pending row as expired without writing it), so every bid query filters
// `expires_at > now` itself rather than trusting `status = 'pending'`.

export type SaleComp = {
  offer_id: string;
  listing_id: string;
  token_id: number;
  collection_id: number;
  seller_wallet: string;
  buyer_wallet: string;
  amount_phaselq: number;
  sold_at: number;
  wash_flagged: boolean;
  wash_reason: string | null;
};

type SaleCompRow = Omit<SaleComp, "wash_flagged"> & { wash_flagged: number };

const SALE_COMP_LIMIT = 500;

export function getSaleComps(
  scope: { collection_id?: number; token_id?: number },
  opts: { since?: number; limit?: number } = {},
): SaleComp[] {
  const conditions = ["o.status = 'accepted'", "COALESCE(o.decided_at, o.created_at) >= ?"];
  const params: unknown[] = [opts.since ?? 0];
  if (scope.collection_id !== undefined) {
    conditions.push("l.collection_id = ?");
    params.push(scope.collection_id);
  }
  if (scope.token_id !== undefined) {
    conditions.push("l.token_id = ?");
    params.push(scope.token_id);
  }
  const limit = Math.min(SALE_COMP_LIMIT, Math.max(1, Math.floor(opts.limit ?? SALE_COMP_LIMIT)));
  const rows = getDb()
    .prepare(
      `SELECT o.id AS offer_id, o.listing_id, l.token_id, l.collection_id, l.seller_wallet,
              o.buyer_wallet, o.amount_phaselq,
              COALESCE(o.decided_at, o.created_at) AS sold_at,
              o.wash_flagged, o.wash_reason
         FROM offers o
         JOIN listings l ON l.id = o.listing_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY sold_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as SaleCompRow[];
  return rows.map((row) => ({ ...row, wash_flagged: row.wash_flagged === 1 }));
}

/** Active asks in a collection, cheapest first. */
export function getActiveAsks(
  collection_id: number,
  limit = 200,
): Array<{ listing_id: string; token_id: number; seller_wallet: string; price_phaselq: number }> {
  return getDb()
    .prepare(
      `SELECT id AS listing_id, token_id, seller_wallet, price_phaselq
         FROM listings WHERE status = 'active' AND collection_id = ?
        ORDER BY price_phaselq ASC LIMIT ?`,
    )
    .all(collection_id, Math.min(500, Math.max(1, limit))) as Array<{
    listing_id: string;
    token_id: number;
    seller_wallet: string;
    price_phaselq: number;
  }>;
}

/** Live (not lazily-expired), non-wash bids on a collection's active listings. */
export function getLiveBids(
  collection_id: number,
  now: number = Date.now(),
): Array<{ offer_id: string; amount_phaselq: number }> {
  return getDb()
    .prepare(
      `SELECT o.id AS offer_id, o.amount_phaselq
         FROM offers o JOIN listings l ON l.id = o.listing_id
        WHERE l.collection_id = ? AND l.status = 'active'
          AND o.status = 'pending' AND o.expires_at > ? AND o.wash_flagged = 0
        ORDER BY o.amount_phaselq DESC LIMIT 200`,
    )
    .all(collection_id, now) as Array<{ offer_id: string; amount_phaselq: number }>;
}

/** Tokens with a wash-flagged accepted sale since `since` — kept off curated walls. */
export function getWashFlaggedTokenIds(tokenIds: readonly number[], since: number): Set<number> {
  if (tokenIds.length === 0) return new Set();
  const placeholders = tokenIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT l.token_id FROM offers o JOIN listings l ON l.id = o.listing_id
        WHERE o.status = 'accepted' AND o.wash_flagged = 1
          AND COALESCE(o.decided_at, o.created_at) >= ?
          AND l.token_id IN (${placeholders})`,
    )
    .all(since, ...tokenIds) as Array<{ token_id: number }>;
  return new Set(rows.map((r) => r.token_id));
}

/**
 * phase-167 / Spike 634: Export marketplace listings and offers for GDPR Article 20 data portability.
 */
export async function exportMarketForWallet(
  wallet: string,
): Promise<{ listings: Listing[]; offers_as_buyer: Offer[] }> {
  const listings = await getListings({ seller_wallet: wallet });
  const offers_as_buyer = await getOffersByBuyer(wallet);
  return { listings, offers_as_buyer };
}

