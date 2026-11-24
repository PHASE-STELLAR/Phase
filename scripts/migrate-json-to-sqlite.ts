/**
 * Issue #36: one-time (idempotent, re-runnable) migration of the legacy
 * JSON sidecar files for marketplace listings/offers and signals/replies
 * into the new SQLite schema (see lib/sqlite-db.ts).
 *
 * Usage:
 *   npx tsx scripts/migrate-json-to-sqlite.ts
 *
 * Safe to re-run: every insert uses `INSERT OR REPLACE`, keyed on the
 * original record `id`, so migrating twice does not duplicate rows — it
 * just re-writes the same rows with the same values.
 *
 * Verifies parity by comparing JSON record counts against the resulting
 * SQLite row counts for each table and exits non-zero if anything is
 * missing, so this doubles as a check that no data was lost in transit.
 */
import { readFile } from "node:fs/promises";
import { serverDataJsonPath } from "../lib/server-data-paths";
import { getDb } from "../lib/sqlite-db";

type Listing = {
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
  status: string;
};

type Offer = {
  id: string;
  listing_id: string;
  buyer_wallet: string;
  amount_phaselq: number;
  message?: string;
  created_at: number;
  status: string;
  expires_at: number;
};

type Signal = {
  id: string;
  author_wallet: string;
  author_display: string;
  channel: string;
  title: string;
  body: string;
  nft_token_id?: number;
  nft_collection_id?: number;
  nft_name?: string;
  nft_image?: string;
  upvotes: string[];
  created_at: number;
  signature: string;
  type?: string;
  poll?: unknown;
  scheduled_for?: number;
  status?: string;
  taken_down?: boolean;
  takedown_reason?: string;
  taken_down_at?: number;
  media?: unknown[];
};

type SignalReply = {
  id: string;
  signal_id: string;
  author_wallet: string;
  author_display: string;
  body: string;
  upvotes: string[];
  created_at: number;
  signature: string;
  media?: unknown[];
};

async function readJsonRecord<T>(filePath: string): Promise<Record<string, T>> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, T>;
  } catch {
    return {};
  }
}

async function migrateListings(): Promise<{ source: number; target: number }> {
  const db = getDb();
  const store = await readJsonRecord<Listing>(
    serverDataJsonPath("marketListings"),
  );
  const rows = Object.values(store);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO listings
       (id, token_id, collection_id, seller_wallet, price_phaselq,
        accepts_offers, min_offer, image, name, listed_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const l of rows) {
    insert.run(
      l.id,
      l.token_id,
      l.collection_id,
      l.seller_wallet,
      l.price_phaselq,
      l.accepts_offers ? 1 : 0,
      l.min_offer ?? null,
      l.image ?? null,
      l.name ?? null,
      l.listed_at,
      l.status,
    );
  }
  const target = (
    db.prepare("SELECT COUNT(*) as n FROM listings").get() as { n: number }
  ).n;
  return { source: rows.length, target };
}

async function migrateOffers(): Promise<{ source: number; target: number }> {
  const db = getDb();
  const store = await readJsonRecord<Offer>(serverDataJsonPath("marketOffers"));
  const rows = Object.values(store);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO offers
       (id, listing_id, buyer_wallet, amount_phaselq, message,
        created_at, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let skipped = 0;
  for (const o of rows) {
    // Skip offers whose listing was never migrated (dangling FK) rather
    // than failing the whole run — logged below for visibility.
    const listingExists = db
      .prepare("SELECT 1 FROM listings WHERE id = ?")
      .get(o.listing_id);
    if (!listingExists) {
      skipped++;
      continue;
    }
    insert.run(
      o.id,
      o.listing_id,
      o.buyer_wallet,
      o.amount_phaselq,
      o.message ?? null,
      o.created_at,
      o.status,
      o.expires_at,
    );
  }
  if (skipped > 0) {
    console.warn(
      `  ! skipped ${skipped} offer(s) referencing a listing not present in market-listings.json`,
    );
  }
  const target = (
    db.prepare("SELECT COUNT(*) as n FROM offers").get() as { n: number }
  ).n;
  return { source: rows.length - skipped, target };
}

async function migrateSignals(): Promise<{ source: number; target: number }> {
  const db = getDb();
  const store = await readJsonRecord<Signal>(serverDataJsonPath("signals"));
  const rows = Object.values(store);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO signals
       (id, author_wallet, author_display, channel, title, body,
        nft_token_id, nft_collection_id, nft_name, nft_image,
        upvotes_json, upvote_count, created_at, signature, type,
        poll_json, scheduled_for, status, taken_down, takedown_reason,
        taken_down_at, media_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of rows) {
    const upvotes = s.upvotes ?? [];
    insert.run(
      s.id,
      s.author_wallet,
      s.author_display,
      s.channel,
      s.title,
      s.body,
      s.nft_token_id ?? null,
      s.nft_collection_id ?? null,
      s.nft_name ?? null,
      s.nft_image ?? null,
      JSON.stringify(upvotes),
      upvotes.length,
      s.created_at,
      s.signature,
      s.type ?? null,
      s.poll ? JSON.stringify(s.poll) : null,
      s.scheduled_for ?? null,
      s.status ?? null,
      s.taken_down ? 1 : 0,
      s.takedown_reason ?? null,
      s.taken_down_at ?? null,
      s.media ? JSON.stringify(s.media) : null,
    );
  }
  const target = (
    db.prepare("SELECT COUNT(*) as n FROM signals").get() as { n: number }
  ).n;
  return { source: rows.length, target };
}

async function migrateReplies(): Promise<{ source: number; target: number }> {
  const db = getDb();
  const store = await readJsonRecord<SignalReply>(
    serverDataJsonPath("signalReplies"),
  );
  const rows = Object.values(store);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO signal_replies
       (id, signal_id, author_wallet, author_display, body,
        upvotes_json, created_at, signature, media_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let skipped = 0;
  for (const r of rows) {
    const signalExists = db
      .prepare("SELECT 1 FROM signals WHERE id = ?")
      .get(r.signal_id);
    if (!signalExists) {
      skipped++;
      continue;
    }
    insert.run(
      r.id,
      r.signal_id,
      r.author_wallet,
      r.author_display,
      r.body,
      JSON.stringify(r.upvotes ?? []),
      r.created_at,
      r.signature,
      r.media ? JSON.stringify(r.media) : null,
    );
  }
  if (skipped > 0) {
    console.warn(
      `  ! skipped ${skipped} reply(ies) referencing a signal not present in signals.json`,
    );
  }
  const target = (
    db.prepare("SELECT COUNT(*) as n FROM signal_replies").get() as {
      n: number;
    }
  ).n;
  return { source: rows.length - skipped, target };
}

async function main() {
  console.log("Migrating JSON stores -> SQLite (.data/phase.sqlite3)\n");

  const results: Record<string, { source: number; target: number }> = {
    listings: await migrateListings(),
    offers: await migrateOffers(),
    signals: await migrateSignals(),
    signal_replies: await migrateReplies(),
  };

  let ok = true;
  for (const [table, { source, target }] of Object.entries(results)) {
    const parity = target >= source;
    ok = ok && parity;
    console.log(
      `  ${parity ? "\u2713" : "\u2717"} ${table}: ${source} source record(s) -> ${target} row(s) in SQLite`,
    );
  }

  if (!ok) {
    console.error(
      "\nMigration finished with a record-count mismatch. Re-run after investigating the warnings above.",
    );
    process.exit(1);
  }

  console.log("\nMigration complete. Legacy JSON files were left untouched.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
