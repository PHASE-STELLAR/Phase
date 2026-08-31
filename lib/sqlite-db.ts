import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverDataJsonPath } from "@/lib/server-data-paths";

// ---------------------------------------------------------------------------
// Issue #36: Marketplace & Signal stores, migrated from full-file JSON reads
// on every request to an indexed, normalized SQLite schema.
//
// Uses Node's built-in `node:sqlite` (stable-ish since Node 22.5, no native
// build step / node-gyp dependency required) rather than a third-party
// driver, since this runs in Next.js server routes on both local dev and
// Vercel's Node runtime.
// ---------------------------------------------------------------------------

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id              TEXT PRIMARY KEY,
  token_id        INTEGER NOT NULL,
  collection_id   INTEGER NOT NULL,
  seller_wallet   TEXT NOT NULL,
  price_phaselq   REAL NOT NULL,
  accepts_offers  INTEGER NOT NULL DEFAULT 0,
  min_offer       REAL,
  image           TEXT,
  name            TEXT,
  listed_at       INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_listings_status_listed_at
  ON listings (status, listed_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_status_price
  ON listings (status, price_phaselq);
CREATE INDEX IF NOT EXISTS idx_listings_collection
  ON listings (collection_id);
CREATE INDEX IF NOT EXISTS idx_listings_seller
  ON listings (seller_wallet);

CREATE TABLE IF NOT EXISTS offers (
  id              TEXT PRIMARY KEY,
  listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_wallet    TEXT NOT NULL,
  amount_phaselq  REAL NOT NULL,
  message         TEXT,
  created_at      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_listing_created
  ON offers (listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_buyer_created
  ON offers (buyer_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_status_expires
  ON offers (status, expires_at);

CREATE TABLE IF NOT EXISTS signals (
  id                TEXT PRIMARY KEY,
  author_wallet     TEXT NOT NULL,
  author_display    TEXT NOT NULL,
  channel           TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  nft_token_id      INTEGER,
  nft_collection_id INTEGER,
  nft_name          TEXT,
  nft_image         TEXT,
  upvotes_json      TEXT NOT NULL DEFAULT '[]',
  upvote_count      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  signature         TEXT NOT NULL,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  type              TEXT,
  poll_json         TEXT,
  scheduled_for     INTEGER,
  status            TEXT,
  taken_down        INTEGER NOT NULL DEFAULT 0,
  takedown_reason   TEXT,
  taken_down_at     INTEGER,
  media_json        TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_channel_created
  ON signals (channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status
  ON signals (status);
CREATE INDEX IF NOT EXISTS idx_signals_author_status
  ON signals (author_wallet, status);
CREATE INDEX IF NOT EXISTS idx_signals_taken_down
  ON signals (taken_down);

CREATE TABLE IF NOT EXISTS signal_replies (
  id              TEXT PRIMARY KEY,
  signal_id       TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  author_wallet   TEXT NOT NULL,
  author_display  TEXT NOT NULL,
  body            TEXT NOT NULL,
  upvotes_json    TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  signature       TEXT NOT NULL,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  media_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_signal_created
  ON signal_replies (signal_id, created_at ASC);

-- Issue #100 (phase-82): word-diffable snapshot of a signal's title/body taken
-- immediately before each edit is applied, so history is reconstructible
-- without re-deriving anything from the current row.
CREATE TABLE IF NOT EXISTS signal_versions (
  id          TEXT PRIMARY KEY,
  signal_id   TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  edited_by   TEXT NOT NULL,
  edited_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_versions_signal
  ON signal_versions (signal_id, version DESC);

-- Issue #101 (phase-83): one row per (signal, wallet, emoji) toggle so a
-- reaction count is a GROUP BY and "did I react" is a single lookup.
CREATE TABLE IF NOT EXISTS signal_reactions (
  id          TEXT PRIMARY KEY,
  signal_id   TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  wallet      TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (signal_id, wallet, emoji)
);
CREATE INDEX IF NOT EXISTS idx_signal_reactions_signal
  ON signal_reactions (signal_id);

-- Issue #89 (phase-140): one row per accepted secondary sale, recording the
-- creator/seller split applied at settlement.
CREATE TABLE IF NOT EXISTS royalty_payouts (
  id                    TEXT PRIMARY KEY,
  listing_id            TEXT NOT NULL,
  offer_id              TEXT NOT NULL,
  creator_wallet        TEXT NOT NULL,
  seller_wallet         TEXT NOT NULL,
  sale_amount_phaselq   REAL NOT NULL,
  royalty_bps           INTEGER NOT NULL,
  royalty_amount_phaselq REAL NOT NULL,
  seller_amount_phaselq  REAL NOT NULL,
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_royalty_payouts_creator
  ON royalty_payouts (creator_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_royalty_payouts_listing
  ON royalty_payouts (listing_id);
`;

// Issue #89 (phase-140): `listings` predates the creator/royalty concept, so
// the columns are added additively to the existing table rather than baked
// into CREATE TABLE — that would no-op on a database file created before this
// change. Both are nullable; a listing without them is simply not eligible
// for royalty enforcement (phase-140 off, or no creator on file).
const LISTING_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "creator_wallet", ddl: "creator_wallet TEXT" },
  { name: "royalty_bps", ddl: "royalty_bps INTEGER" },
];

function ensureListingColumns(conn: DatabaseSync): void {
  const existing = new Set(
    (conn.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const column of LISTING_COLUMNS) {
    if (!existing.has(column.name)) {
      conn.exec(`ALTER TABLE listings ADD COLUMN ${column.ddl};`);
    }
  }
}

/**
 * Returns the process-wide SQLite connection, creating and migrating the
 * schema on first use. Safe to call from any request handler; `node:sqlite`
 * serializes access on a single connection per process.
 */
export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = serverDataJsonPath("sqliteDb");
  mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // Idempotent migration for databases created before signature_verified existed.
  try {
    db.exec(
      "ALTER TABLE signals ADD COLUMN signature_verified INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {
    // Column already present — no-op.
  }
  try {
    db.exec(
      "ALTER TABLE signal_replies ADD COLUMN signature_verified INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {
    // Column already present — no-op.
  }

  return db;
}

/** Test-only: drop the cached connection so a fresh one is opened next call. */
export function resetDbForTests(): void {
  db?.close();
  db = null;
}
