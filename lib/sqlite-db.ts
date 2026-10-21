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
CREATE TABLE IF NOT EXISTS compliance_credentials (
  wallet_hash TEXT PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('verified', 'revoked')),
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_subject ON compliance_credentials(subject_hash);
CREATE TABLE IF NOT EXISTS compliance_webhooks (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tax_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('acquisition','disposal','royalty','reward')),
  asset TEXT NOT NULL,
  amount_stroops TEXT NOT NULL,
  basis_stroops TEXT,
  tx_hash TEXT,
  occurred_at INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  wash_flagged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tax_wallet_time ON tax_events(wallet, occurred_at, seq);
CREATE INDEX IF NOT EXISTS idx_tax_wallet_asset ON tax_events(wallet, asset, occurred_at, seq);
CREATE TABLE IF NOT EXISTS tax_export_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tax_export_rate (wallet TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(wallet, minute));
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
  expires_at      INTEGER NOT NULL,
  wash_flagged    INTEGER NOT NULL DEFAULT 0,
  wash_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_offers_listing_created
  ON offers (listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_buyer_created
  ON offers (buyer_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_status_expires
  ON offers (status, expires_at);
-- Issue #230: volume aggregates filter on wash_flagged, so it needs an index
-- that carries the flag alongside the status it is always read with.
CREATE INDEX IF NOT EXISTS idx_offers_status_wash_created
  ON offers (status, wash_flagged, created_at DESC);

CREATE TABLE IF NOT EXISTS signals (
  id                TEXT PRIMARY KEY,
  -- Optimistic-concurrency token. Starts at 1 so that a fresh signal's version
  -- is a valid ETag / If-Match / parent_version value (those all require >= 1).
  version           INTEGER NOT NULL DEFAULT 1,
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

-- Issue #207 (phase-141): the CRDT draft a co-authoring session converges on.
--
-- signal_crdt_docs.snapshot_b64 is the folded Yjs document — a Yjs update, not
-- the rendered text, so the causal history of every merged keystroke survives a
-- compaction. signal_crdt_updates is the append-only tail the snapshot folds in
-- on every merge; it is kept only for contributor attribution and is bounded by
-- COMPACT_AFTER_UPDATES so a long-lived thread cannot grow without limit. Neither
-- table is the signal: the draft is promoted to a committed, revertible revision
-- only through the version-guarded write in signal-store.
CREATE TABLE IF NOT EXISTS signal_crdt_docs (
  signal_id        TEXT PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
  snapshot_b64     TEXT NOT NULL,
  state_vector_b64 TEXT NOT NULL,
  update_count     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_crdt_updates (
  id            TEXT PRIMARY KEY,
  signal_id     TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  update_b64    TEXT NOT NULL,
  author_wallet TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crdt_updates_signal
  ON signal_crdt_updates (signal_id, created_at ASC);


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

CREATE TABLE IF NOT EXISTS ve_locks (
  wallet              TEXT PRIMARY KEY,
  amount_stroops      TEXT NOT NULL,
  lock_start          INTEGER NOT NULL,
  lock_end            INTEGER NOT NULL,
  ve_weight           REAL NOT NULL,
  last_claim_epoch    INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ve_locks_end
  ON ve_locks (lock_end);

CREATE TABLE IF NOT EXISTS ve_fee_distribution (
  epoch_id            INTEGER PRIMARY KEY,
  total_fees_stroops  TEXT NOT NULL,
  total_ve_weight     REAL NOT NULL,
  fee_per_weight      REAL NOT NULL,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gauge_votes (
  id                  TEXT PRIMARY KEY,
  epoch               INTEGER NOT NULL,
  wallet              TEXT NOT NULL,
  collection_id       INTEGER NOT NULL,
  weight_bps          INTEGER NOT NULL,
  effective_ve_weight REAL NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gauge_votes_epoch_col
  ON gauge_votes (epoch, collection_id);
CREATE INDEX IF NOT EXISTS idx_gauge_votes_wallet_epoch
  ON gauge_votes (wallet, epoch);

CREATE TABLE IF NOT EXISTS gauge_epoch_aggregates (
  epoch               INTEGER NOT NULL,
  collection_id       INTEGER NOT NULL,
  total_ve_weight     REAL NOT NULL,
  allocated_budget_stroops TEXT NOT NULL,
  PRIMARY KEY (epoch, collection_id)
);
-- phase-142: curator-authored exhibitions. The hang (ordered tokens + wall
-- text) is one JSON column so a show is published or rotated as one versioned
-- row; there is no partial hang to observe. input_hash is the deterministic
-- selection fingerprint, so a retried draft request returns the same draft
-- instead of paying for a second model call.
CREATE TABLE IF NOT EXISTS exhibitions (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft',
  version          INTEGER NOT NULL DEFAULT 1,
  lang             TEXT NOT NULL,
  title            TEXT NOT NULL,
  statement        TEXT NOT NULL,
  theme_json       TEXT NOT NULL,
  hang_json        TEXT NOT NULL,
  cover_token_id   INTEGER NOT NULL,
  input_hash       TEXT NOT NULL,
  model_id         TEXT,
  prompt_hash      TEXT,
  text_source      TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  published_at     INTEGER,
  rotated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_exhibitions_scope_status
  ON exhibitions (scope, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_exhibitions_input
  ON exhibitions (input_hash, lang, status);

-- phase-143: every suggestion the oracle shows (or withholds, for the control
-- arm) and what the seller then did with it. outcome is written once, by a
-- conditional UPDATE, so a retried listing POST cannot record it twice.
CREATE TABLE IF NOT EXISTS price_suggestions (
  id                 TEXT PRIMARY KEY,
  seller_wallet      TEXT NOT NULL,
  collection_id      INTEGER NOT NULL,
  token_id           INTEGER,
  arm                TEXT NOT NULL,
  level              TEXT NOT NULL,
  suggested_phaselq  REAL,
  p25_phaselq        REAL,
  p75_phaselq        REAL,
  comp_ids_json      TEXT NOT NULL,
  effective_comps    REAL NOT NULL,
  created_at         INTEGER NOT NULL,
  outcome            TEXT,
  listing_id         TEXT,
  listed_price       REAL,
  outcome_at         INTEGER,
  sold_at            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_price_suggestions_seller
  ON price_suggestions (seller_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_suggestions_listing
  ON price_suggestions (listing_id);
CREATE INDEX IF NOT EXISTS idx_price_suggestions_arm
  ON price_suggestions (arm, created_at);

-- phase-146: one row per screened revision of a signal or reply. The signal
-- row is never mutated by the AI; visibility lives here so unsetting the flag
-- leaves signals exactly as they were written.
CREATE TABLE IF NOT EXISTS moderation_queue (
  id             TEXT PRIMARY KEY,
  target_kind    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  author_wallet  TEXT NOT NULL,
  text_hash      TEXT NOT NULL,
  has_media      INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL,
  decision       TEXT,
  visibility     TEXT NOT NULL DEFAULT 'visible',
  confidence     REAL,
  scores_json    TEXT,
  model_id       TEXT,
  prompt_hash    TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lease_until    INTEGER,
  assigned_to    TEXT,
  due_at         INTEGER,
  appeal_reason  TEXT,
  appealed_at    INTEGER,
  resolution     TEXT,
  resolved_by    TEXT,
  resolved_at    INTEGER,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (target_kind, target_id, text_hash)
);
CREATE INDEX IF NOT EXISTS idx_moderation_queue_state_due
  ON moderation_queue (state, due_at);
CREATE INDEX IF NOT EXISTS idx_moderation_queue_target
  ON moderation_queue (target_kind, target_id, created_at DESC);

-- phase-147: generated quest arcs. Steps live in steps_json and every step
-- transition is a version-guarded rewrite of the row, so a claim and a
-- supersede cannot both win.
CREATE TABLE IF NOT EXISTS quest_arcs (
  id                    TEXT PRIMARY KEY,
  wallet                TEXT NOT NULL,
  status                TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  lang                  TEXT NOT NULL,
  title                 TEXT NOT NULL,
  steps_json            TEXT NOT NULL,
  total_reward_stroops  TEXT NOT NULL,
  diagnosis_json        TEXT NOT NULL,
  model_id              TEXT,
  text_source           TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  superseded_by         TEXT
);
CREATE INDEX IF NOT EXISTS idx_quest_arcs_wallet_status
  ON quest_arcs (wallet, status, created_at DESC);
`;

// Issue #89 (phase-140): `listings` predates the creator/royalty concept, so
// the columns are added additively to the existing table rather than baked
// into CREATE TABLE — that would no-op on a database file created before this
// change. Both are nullable; a listing without them is simply not eligible
// for royalty enforcement (phase-140 off, or no creator on file).
const LISTING_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "contract_id", ddl: "contract_id TEXT" },
  { name: "creator_wallet", ddl: "creator_wallet TEXT" },
  { name: "royalty_bps", ddl: "royalty_bps INTEGER" },
  // Spike 673 (phase-editions): per-collection edition numbering. Nullable; NULL = uneditioned legacy row.
  { name: "edition_number", ddl: "edition_number INTEGER" },
  { name: "edition_size", ddl: "edition_size INTEGER" },
  { name: "is_artist_proof", ddl: "is_artist_proof INTEGER NOT NULL DEFAULT 0" },
  { name: "supply_mode", ddl: "supply_mode TEXT" },
  // Spike 672 (phase-timed-drops): server-authoritative drop window. NULL = no window (always live).
  { name: "drop_start_at", ddl: "drop_start_at INTEGER" },
  { name: "drop_end_at", ddl: "drop_end_at INTEGER" },
  // Spike 675 (phase-dutch-auction): descending-price primary mint. NULLs = fixed-price legacy row.
  { name: "dutch_start_price", ddl: "dutch_start_price REAL" },
  { name: "dutch_floor_price", ddl: "dutch_floor_price REAL" },
  { name: "dutch_end_at", ddl: "dutch_end_at INTEGER" },
  // Spike 674 (phase-collab-splits): N-way payee list as JSON (validated at write). NULL = single-creator.
  { name: "split_payees_json", ddl: "split_payees_json TEXT" },
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

// Issue #230: same additive pattern for `offers` — `wash_flagged` was added
// after the table shipped, so an existing database file needs the ALTER.
const OFFER_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "wash_flagged", ddl: "wash_flagged INTEGER NOT NULL DEFAULT 0" },
  { name: "wash_reason", ddl: "wash_reason TEXT" },
  // phase-143: when the seller accepted/rejected. Comps decay from the sale,
  // not from when the bid was first placed (up to 48h earlier).
  { name: "decided_at", ddl: "decided_at INTEGER" },
];

function ensureOfferColumns(conn: DatabaseSync): void {
  const existing = new Set(
    (conn.prepare("PRAGMA table_info(offers)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const column of OFFER_COLUMNS) {
    if (!existing.has(column.name)) {
      conn.exec(`ALTER TABLE offers ADD COLUMN ${column.ddl};`);
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
  let migrationStarted = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("BEGIN IMMEDIATE;");
    migrationStarted = true;
    db.exec(SCHEMA);
    ensureListingColumns(db);
    ensureOfferColumns(db);
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
    try {
      db.exec(
        "ALTER TABLE signals ADD COLUMN version INTEGER NOT NULL DEFAULT 1;",
      );
    } catch {
      // Column already present — no-op.
    }
    // The version column originally defaulted to 0, but every consumer of it
    // (ETag, If-Match, parent_version) treats 0 as invalid, so a signal that had
    // never been edited or upvoted could not be replied to. Normalize the
    // sentinel to the same 1-based origin new rows get.
    db.exec("UPDATE signals SET version = 1 WHERE version <= 0;");
    db.exec("COMMIT;");
    return db;
  } catch (error) {
    if (migrationStarted) db.exec("ROLLBACK;");
    db.close();
    db = null;
    throw error;
  }
}

/** Test-only: drop the cached connection so a fresh one is opened next call. */
export function resetDbForTests(): void {
  db?.close();
  db = null;
}
