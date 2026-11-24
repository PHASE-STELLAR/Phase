/**
 * Issue #207 (phase-141): server-side persistence and merge for the CRDT lore
 * draft described in `lib/signal-crdt.ts`.
 *
 * ## The concurrency argument
 *
 * `mergeSignalLoreUpdate` is the only writer, and it runs inside
 * `BEGIN IMMEDIATE` so two requests can never interleave read-fold-write. But
 * serializing the *merge* is only half the requirement — the other half is that
 * the merge itself must not drop anything, and that is what Yjs buys: applying
 * an update is commutative, associative and idempotent, so
 *
 *   merge(merge(base, a), b) === merge(merge(base, b), a)
 *
 * holds regardless of arrival order, and re-submitting the same update twice is
 * a no-op rather than a duplicated edit. A last-writer-wins store has neither
 * property, which is why two writers both reading v1 and both writing used to
 * lose one of the two writes.
 *
 * Everything inside the transaction is deliberately synchronous: `node:sqlite`
 * is a synchronous driver, and an `await` mid-transaction would let a second
 * writer's `BEGIN IMMEDIATE` interleave with this one.
 *
 * ## Why the draft is separate from `signals`
 *
 * The draft is scratch state. It is promoted to a committed, revertible
 * revision only by `PUT /api/signals/[id]`, which requires `If-Match` and
 * snapshots the prior text into `signal_versions`. So a collaborative merge can
 * never rewrite history.
 *
 * Feature flag: phase-141 (NEXT_PUBLIC_FEATURE_PHASE_141 / FEATURE_PHASE_141)
 * Rollback: unset the flag — the sync route 404s and `PUT` falls back to the
 *   audited compare-and-swap path on its own. Draft rows stay on disk as inert
 *   scratch state; no migration to undo.
 */
import { nanoid } from "nanoid";
import type { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { getDb } from "@/lib/sqlite-db";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { recordSignalCrdtMerge } from "@/lib/signal-version-metrics";
import {
  createSignalLoreDoc,
  decodeSignalLoreUpdate,
  encodeSignalLoreBytes,
  encodeSignalLoreStateVector,
  readSignalLore,
  seedSignalLore,
  signalLoreIsUpToDate,
  type SignalLoreSnapshot,
  type SignalLoreUpdate,
} from "@/lib/signal-crdt";

export function isSignalCrdtEnabled(): boolean {
  return isFeatureEnabled("phase-141");
}

export function flag141RollbackNote(): string {
  return "Rollback phase-141: unset NEXT_PUBLIC_FEATURE_PHASE_141 / FEATURE_PHASE_141 or set to 0/false and restart. GET/POST /api/signals/[id]/crdt return 404 and the collaborative draft panel is hidden; PUT /api/signals/[id] still works on its own as an If-Match-guarded full replacement. Existing signal_crdt_* rows stay on disk as inert scratch state (no migration to undo).";
}

export class SignalCrdtError extends Error {
  code: "FLAG_DISABLED" | "NOT_FOUND" | "VALIDATION_FAILED";

  constructor(code: SignalCrdtError["code"], message: string) {
    super(message);
    this.name = "SignalCrdtError";
    this.code = code;
  }
}

/** Refuse absurd payloads rather than folding unbounded state into a draft. */
export const MAX_CRDT_UPDATE_CHARS = 256 * 1024;
/** Tail rows kept for contributor attribution; the snapshot already has the ops. */
export const COMPACT_AFTER_UPDATES = 64;

type DocRow = {
  signal_id: string;
  snapshot_b64: string;
  state_vector_b64: string;
  update_count: number;
  created_at: number;
  updated_at: number;
};

type UpdateRow = {
  id: string;
  signal_id: string;
  update_b64: string;
  author_wallet: string;
  created_at: number;
};

type SignalTitleRow = { title: string; body: string };

export type SignalLoreContributor = {
  wallet: string;
  updates: number;
  last_seen_at: number;
};

export type SignalLoreDraft = {
  signalId: string;
  /** Rendered draft, for the editor and for server-side assertions. */
  snapshot: SignalLoreSnapshot;
  /**
   * Yjs sync step 2: every operation `sinceStateVector` is missing. With no
   * `sinceStateVector` this is the full document state, so a fresh replica can
   * bootstrap from it in one request.
   */
  update: SignalLoreUpdate;
  /** The document's own state vector, for the client to diff against later. */
  stateVector: SignalLoreUpdate;
  /** How many updates have been folded in, for the "n contributors" readout. */
  updateCount: number;
  contributors: SignalLoreContributor[];
  updatedAt: number;
};

function readDocRow(conn: DatabaseSync, signalId: string): DocRow | undefined {
  return conn
    .prepare("SELECT * FROM signal_crdt_docs WHERE signal_id = ?")
    .get(signalId) as DocRow | undefined;
}

function readSignalText(conn: DatabaseSync, signalId: string): SignalTitleRow | undefined {
  return conn
    .prepare("SELECT title, body FROM signals WHERE id = ?")
    .get(signalId) as SignalTitleRow | undefined;
}

function readContributors(conn: DatabaseSync, signalId: string): SignalLoreContributor[] {
  const rows = conn
    .prepare(
      `SELECT author_wallet AS wallet, COUNT(*) AS updates, MAX(created_at) AS last_seen_at
         FROM signal_crdt_updates
        WHERE signal_id = ?
        GROUP BY author_wallet
        ORDER BY last_seen_at ASC
        LIMIT 50`,
    )
    .all(signalId) as SignalLoreContributor[];
  return rows;
}

function loadDoc(row: DocRow): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, decodeSignalLoreUpdate(row.snapshot_b64));
  return doc;
}

function toDraft(
  conn: DatabaseSync,
  signalId: string,
  doc: Y.Doc,
  row: { update_count: number; updated_at: number },
  sinceStateVector?: SignalLoreUpdate,
): SignalLoreDraft {
  const diff = sinceStateVector
    ? Y.encodeStateAsUpdate(doc, decodeSignalLoreUpdate(sinceStateVector))
    : Y.encodeStateAsUpdate(doc);
  return {
    signalId,
    snapshot: readSignalLore(doc),
    update: encodeSignalLoreBytes(diff),
    stateVector: encodeSignalLoreStateVector(doc),
    updateCount: row.update_count,
    contributors: readContributors(conn, signalId),
    updatedAt: row.updated_at,
  };
}

/**
 * Creates the draft for a signal from its committed lore, if it has none yet.
 * A signal therefore always has a draft the moment phase-141 is used, and the
 * draft starts from what readers already see rather than from a blank page.
 */
function ensureDocRow(conn: DatabaseSync, signalId: string, now: number): DocRow {
  const existing = readDocRow(conn, signalId);
  if (existing) return existing;

  const signal = readSignalText(conn, signalId);
  if (!signal) throw new SignalCrdtError("NOT_FOUND", "Signal not found");

  const doc = createSignalLoreDoc();
  seedSignalLore(doc, { title: signal.title, body: signal.body });
  conn
    .prepare(
      `INSERT INTO signal_crdt_docs
         (signal_id, snapshot_b64, state_vector_b64, update_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    )
    .run(
      signalId,
      encodeSignalLoreBytes(Y.encodeStateAsUpdate(doc)),
      encodeSignalLoreStateVector(doc),
      now,
      now,
    );
  return readDocRow(conn, signalId)!;
}

export type MergeSignalLoreResult = {
  draft: SignalLoreDraft;
  /** True when the update carried operations the stored draft had not seen. */
  concurrent: boolean;
};

/**
 * Folds one client's Yjs update into a signal's draft.
 *
 * `conn` exists so the concurrency tests can drive two genuinely independent
 * connections against the same database file; production passes the shared
 * `getDb()` handle.
 */
export async function mergeSignalLoreUpdate(
  signalId: string,
  update: SignalLoreUpdate,
  authorWallet: string,
  opts: { conn?: DatabaseSync; sinceStateVector?: SignalLoreUpdate } = {},
): Promise<MergeSignalLoreResult> {
  const conn = opts.conn ?? getDb();
  if (!isSignalCrdtEnabled()) throw new SignalCrdtError("FLAG_DISABLED", "phase-141 disabled");
  if (typeof update !== "string" || update.length === 0) {
    throw new SignalCrdtError("VALIDATION_FAILED", "update required");
  }
  if (update.length > MAX_CRDT_UPDATE_CHARS) {
    throw new SignalCrdtError("VALIDATION_FAILED", "update too large");
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeSignalLoreUpdate(update);
  } catch {
    throw new SignalCrdtError("VALIDATION_FAILED", "update is not valid base64");
  }

  // No awaits below this line: the transaction must not be interleaved.
  const now = Date.now();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const row = ensureDocRow(conn, signalId, now);
    const doc = loadDoc(row);

    const concurrent = !signalLoreIsUpToDate(doc, bytes);
    Y.applyUpdate(doc, bytes);

    const updateCount = row.update_count + 1;
    conn
      .prepare(
        `UPDATE signal_crdt_docs
            SET snapshot_b64 = ?, state_vector_b64 = ?, update_count = ?, updated_at = ?
          WHERE signal_id = ?`,
      )
      .run(
        encodeSignalLoreBytes(Y.encodeStateAsUpdate(doc)),
        encodeSignalLoreStateVector(doc),
        updateCount,
        now,
        signalId,
      );

    conn
      .prepare(
        `INSERT INTO signal_crdt_updates (id, signal_id, update_b64, author_wallet, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(nanoid(12), signalId, update, authorWallet, now);

    // The snapshot was just folded with the whole tail, so the tail is now
    // redundant for sync. It is only retained for contributor attribution, hence
    // a count-based cap rather than a time-based one.
    const tail = conn
      .prepare("SELECT COUNT(*) AS n FROM signal_crdt_updates WHERE signal_id = ?")
      .get(signalId) as { n: number };
    if (tail.n > COMPACT_AFTER_UPDATES) {
      conn.prepare("DELETE FROM signal_crdt_updates WHERE signal_id = ?").run(signalId);
    }

    conn.exec("COMMIT");
    recordSignalCrdtMerge(concurrent);
    return {
      draft: toDraft(
        conn,
        signalId,
        doc,
        { update_count: updateCount, updated_at: now },
        opts.sinceStateVector,
      ),
      concurrent,
    };
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Reads a signal's draft. With `sinceStateVector` this is the Yjs sync step-2
 * reply and returns only what the caller is missing; without one it returns the
 * whole document so a first-time client bootstraps in a single request.
 */
export async function readSignalLoreDraft(
  signalId: string,
  sinceStateVector?: SignalLoreUpdate,
  conn: DatabaseSync = getDb(),
): Promise<SignalLoreDraft> {  if (!isSignalCrdtEnabled()) throw new SignalCrdtError("FLAG_DISABLED", "phase-141 disabled");

  const now = Date.now();
  // ensureDocRow + read must see the same state, so they share one transaction.
  conn.exec("BEGIN IMMEDIATE");
  try {
    const row = ensureDocRow(conn, signalId, now);
    const doc = loadDoc(row);
    const draft = toDraft(conn, signalId, doc, row, sinceStateVector);
    conn.exec("COMMIT");
    return draft;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

/** Drops a signal's draft so the next read reseeds it from committed lore. */
export async function resetSignalLoreDraft(
  signalId: string,
  conn: DatabaseSync = getDb(),
): Promise<void> {
  conn.exec("BEGIN IMMEDIATE");
  try {
    conn.prepare("DELETE FROM signal_crdt_updates WHERE signal_id = ?").run(signalId);
    conn.prepare("DELETE FROM signal_crdt_docs WHERE signal_id = ?").run(signalId);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

export function getSignalLoreDraftStats(signalId: string, conn: DatabaseSync = getDb()): {
  enabled: boolean;
  exists: boolean;
  updateCount: number;
  tailRows: number;
  contributors: number;
} {
  const row = readDocRow(conn, signalId);
  const tail = conn
    .prepare("SELECT COUNT(*) AS n FROM signal_crdt_updates WHERE signal_id = ?")
    .get(signalId) as { n: number };
  return {
    enabled: isSignalCrdtEnabled(),
    exists: Boolean(row),
    updateCount: row?.update_count ?? 0,
    tailRows: tail.n,
    contributors: readContributors(conn, signalId).length,
  };
}
