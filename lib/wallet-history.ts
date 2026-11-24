/**
 * Transaction history "halte" — Horizon-backed per-wallet timeline.
 * Spike 629 / Issue #492.
 *
 * Phase previously had no history UI: balances were point-reads
 * (`getTokenBalance`, settle token balance, native XLM), the Chamber logged
 * ephemeral `appendLog` lines, and Mercury/bulkhead served balances and
 * indexes — not a timeline. There was no `/api/history`, no Horizon
 * `transactions?account=` fetch, no effects parsing, no settle ↔ forge
 * invoice correlation, and no index-cache wiring to the UI.
 *
 * This module is the per-wallet presentation layer above those pipelines:
 * - `fetchHorizonHistoryPage`: `transactions?account=` + `effects?account=`
 *   fetched together through `withHorizonBulkhead` (429-aware, timeout-bounded)
 * - `parseHorizonTransactionRecords` / `parseHorizonEffectRecords`: typed
 *   `TimelineEvent` classification (payment, trade, trustline, account, …)
 * - `mergeTimelineStreams`: effects-first merge that drops transaction-level
 *   rows already covered by an effect for the same hash (failed transactions
 *   without effects are kept)
 * - `correlateTimelineEvents`: settle ↔ forge annotation — tx hashes checked
 *   against the settlement idempotency store and the forge generation-job
 *   store (keyed by settlement tx hash)
 * - `getWalletTimeline`: flag gate → index-cache fresh-serve → live fetch →
 *   correlate → cache → stale-on-error degrade
 *
 * Not spike 557 (backend full ingestion + cursors) and not 558 (getEvents
 * indexer + reorg guard) — this is the per-wallet UI timeline above them.
 *
 * Feature flag: phase-173.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_173 / FEATURE_PHASE_173; the
 * route returns 404, the timeline component renders nothing, and the cache is
 * never read or written.
 */

import { isFeatureEnabled } from "@/lib/feature-flags";
import { isHorizon429, withHorizonBulkhead } from "@/lib/horizon-bulkhead";
import {
  isWalletHistoryCacheEnabled,
  isWalletHistoryCacheEntryFresh,
} from "@/lib/wallet-history-cache";
import type {
  TimelineCorrelation,
  TimelineDirection,
  TimelineEvent,
  TimelineEventKind,
  WalletTimelinePage,
} from "@/lib/types/wallet-history";

export const HORIZON_HISTORY_URL = "https://horizon-testnet.stellar.org";
export const HISTORY_DEFAULT_PAGE_SIZE = 50;
export const HISTORY_MAX_PAGE_SIZE = 200;
export const HISTORY_FETCH_TIMEOUT_MS = 8_000;

export class WalletHistoryError extends Error {
  code:
    | "FLAG_DISABLED"
    | "INVALID_ADDRESS"
    | "HORIZON_RATE_LIMITED"
    | "HORIZON_ERROR";
  constructor(code: WalletHistoryError["code"], message: string) {
    super(message);
    this.name = "WalletHistoryError";
    this.code = code;
  }
}

export function isWalletHistory173Enabled(): boolean {
  return isFeatureEnabled("phase-173");
}

/** Stellar ed25519 public account (G…, 56 chars base32). */
export function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Horizon record shapes (defensive — fields extracted when present)
// ─────────────────────────────────────────────────────────────────────────────

type RawRecord = Record<string, unknown> & { paging_token?: string };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function extractTxHash(r: RawRecord): string | undefined {
  return (
    str(r.transaction_hash) ??
    str(r.tx_hash) ??
    str(r.tx) ??
    (typeof r._links === "object" && r._links !== null
      ? str((r._links as { transaction?: { href?: string } }).transaction?.href?.split("/").pop())
      : undefined)
  );
}

function assetLabel(r: RawRecord, codeKey = "asset_code"): string | undefined {
  const code = str(r[codeKey]);
  if (code) return code;
  if (str(r.asset_type) === "native") return "XLM";
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a Horizon `transactions?account=` record to a timeline event. These
 * carry memo/fee/success-level facts; operation granularity comes from the
 * effects stream (see `mergeTimelineStreams`).
 */
export function parseHorizonTransactionRecords(
  records: RawRecord[],
  wallet: string,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const r of records) {
    const hash = extractTxHash(r);
    const id = str(r.id) ?? str(r.paging_token) ?? hash;
    if (!id) continue;
    const successful = typeof r.successful === "boolean" ? r.successful : undefined;
    const source = str(r.source_account) ?? str(r.fee_account);
    const direction: TimelineDirection =
      source === wallet ? "out" : source ? "in" : "none";
    out.push({
      id: `tx:${id}`,
      kind: "tx",
      direction,
      amount: str(r.fee_paid) ?? str(r.fee_charged),
      asset: "XLM",
      counterparty: source === wallet ? undefined : source,
      tx_hash: hash,
      ledger: num(r.ledger),
      memo: str(r.memo),
      type: successful === false ? "tx_failed" : "tx",
      occurred_at: str(r.created_at) ?? new Date(0).toISOString(),
      failed: successful === false,
    });
  }
  return out;
}

/** Classifies a Horizon `effects?account=` record into a timeline event kind. */
export function classifyEffectType(type: string): TimelineEventKind {
  if (type === "account_credited" || type === "account_debited") return "payment";
  if (type.startsWith("trade")) return "trade";
  if (type.startsWith("trustline")) return "trustline";
  if (type.startsWith("account_created") || type.startsWith("account_remove")) return "account";
  if (type.startsWith("data_")) return "other";
  if (type.startsWith("sequence")) return "other";
  return "other";
}

/**
 * Maps a Horizon `effects?account=` record to a timeline event. Effects are
 * the primary per-wallet timeline stream (payment/trustline/trade
 * granularity); the `tx` link is extracted when Horizon provides it so the
 * settle/forge correlation can join on hashes.
 */
export function parseHorizonEffectRecords(
  records: RawRecord[],
  wallet: string,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const r of records) {
    const id = str(r.id) ?? str(r.paging_token);
    if (!id) continue;
    const type = str(r.type) ?? "unknown";
    const kind = classifyEffectType(type);

    // Effects stream from `accounts/{wallet}/effects` is inherently about this
    // wallet: value flows are in/out by effect type; trustline, trade, and
    // data effects move no direct wallet-to-wallet value and stay "none".
    const direction: TimelineDirection =
      type === "account_debited" || type === "account_removed"
        ? "out"
        : type === "account_credited" || type === "account_created"
          ? "in"
          : "none";

    const amount =
      str(r.amount) ?? str(r.starting_balance) ?? str(r.balance) ?? undefined;
    const asset =
      assetLabel(r) ??
      (type.startsWith("account_") ? "XLM" : undefined);

    const counterpartyRaw =
      str(r.counterparty) ??
      str(r.source_account) ??
      (typeof r.buyer === "string" ? r.buyer : undefined) ??
      (typeof r.seller === "string" ? r.seller : undefined);
    const counterparty =
      counterpartyRaw && counterpartyRaw !== wallet ? counterpartyRaw : undefined;

    out.push({
      id: `effect:${id}`,
      kind,
      direction,
      amount,
      asset,
      counterparty,
      tx_hash: extractTxHash(r),
      ledger: num(r.ledger),
      type,
      occurred_at: str(r.created_at) ?? new Date(0).toISOString(),
    });
  }
  return out;
}

/**
 * Effects-first merge: transaction-level rows that duplicate an effect for
 * the same hash are dropped (the effect carries the richer per-wallet data);
 * transactions without matching effects — notably failed transactions, which
 * produce no effects — are kept so the timeline preserves failure history.
 */
export function mergeTimelineStreams(
  txEvents: TimelineEvent[],
  effectEvents: TimelineEvent[],
): TimelineEvent[] {
  const hashesWithEffects = new Set(
    effectEvents.map((e) => e.tx_hash).filter((h): h is string => Boolean(h)),
  );
  const txOnly = txEvents.filter((t) => !t.tx_hash || !hashesWithEffects.has(t.tx_hash));
  const merged = [...effectEvents, ...txOnly];

  // Deterministic dedupe by id, then newest-first ordering (ledger breaks
  // ties for records Horizon serves without a created_at timestamp).
  const seen = new Set<string>();
  const unique: TimelineEvent[] = [];
  for (const e of merged) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    unique.push(e);
  }
  unique.sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
    return (b.ledger ?? 0) - (a.ledger ?? 0);
  });
  return unique;
}

// ─────────────────────────────────────────────────────────────────────────────
// settle ↔ forge invoice correlation
// ─────────────────────────────────────────────────────────────────────────────

export interface TimelineLookups {
  /** Tx hashes consumed by the settlement idempotency store. */
  settledTxHashes: Set<string>;
  /** Settlement tx hash → forge generation job paying for it. */
  forgeJobsByTxHash: Map<string, { id: string; status: string; collectionId?: number }>;
}

export function emptyTimelineLookups(): TimelineLookups {
  return { settledTxHashes: new Set(), forgeJobsByTxHash: new Map() };
}

/**
 * Annotates timeline transactions with their settlement / forge-invoice
 * correlation. Pure so tests can inject stores; `buildTimelineLookups`
 * gathers the real data from the settlement and generation-job stores.
 */
export function correlateTimelineEvents(
  events: TimelineEvent[],
  lookups: TimelineLookups,
): TimelineEvent[] {
  return events.map((e) => {
    if (!e.tx_hash) return e;
    const settled = lookups.settledTxHashes.has(e.tx_hash);
    const job = lookups.forgeJobsByTxHash.get(e.tx_hash);
    if (!settled && !job) return e;

    const correlation: TimelineCorrelation = {
      kind: job ? "forge-settle" : "settle",
      tx_hash: e.tx_hash,
      settled,
      ...(job
        ? {
            forge_job_id: job.id,
            forge_job_status: job.status,
            ...(job.collectionId !== undefined ? { collection_id: job.collectionId } : {}),
          }
        : {}),
    };
    return {
      ...e,
      // A transaction that paid a forge invoice is presented as a settle
      // event even when the effects stream classified it as a payment.
      kind: job ? "forge" : e.kind === "tx" ? "settle" : e.kind,
      correlation,
    };
  });
}

/**
 * Builds the correlation lookups for a set of tx hashes. The stores are
 * imported lazily so this module stays free of file-store side effects at
 * load time (tests import the pure functions above without touching disk).
 */
export async function buildTimelineLookups(txHashes: string[]): Promise<TimelineLookups> {
  const lookups = emptyTimelineLookups();
  const unique = txHashes.filter((h): h is string => Boolean(h));
  if (unique.length === 0) return lookups;
  try {
    const [{ isSettlementUsed }, { getGenerationJobByTxHash }] = await Promise.all([
      import("@/lib/settlement-store"),
      import("@/lib/generation-job-store"),
    ]);
    await Promise.all(
      unique.map(async (hash) => {
        const [settled, job] = await Promise.all([
          isSettlementUsed(hash).catch(() => false),
          getGenerationJobByTxHash(hash).catch(() => null),
        ]);
        if (settled) lookups.settledTxHashes.add(hash);
        if (job) {
          lookups.forgeJobsByTxHash.set(hash, {
            id: job.id,
            status: job.status,
            collectionId: job.collectionId,
          });
        }
      }),
    );
  } catch {
    // Stores unavailable (e.g. read-only deployment) → serve uncorrelated.
  }
  return lookups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Horizon fetch
// ─────────────────────────────────────────────────────────────────────────────

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(limit ?? HISTORY_DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(n) || n < 1) return HISTORY_DEFAULT_PAGE_SIZE;
  return Math.min(n, HISTORY_MAX_PAGE_SIZE);
}

/** Smaller of two Horizon paging tokens (ints as strings) — gap-free cursor. */
export function minPagingToken(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  try {
    return BigInt(a) <= BigInt(b) ? a : b;
  } catch {
    return a.length <= b.length ? a : b;
  }
}

async function getHorizonJson(url: string): Promise<{ records: RawRecord[]; tail: string | null }> {
  const res = await withHorizonBulkhead(async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(HISTORY_FETCH_TIMEOUT_MS) });
    if (!r.ok) {
      const err = new Error(`Horizon responded ${r.status} for ${url}`) as Error & {
        status?: number;
      };
      err.status = r.status;
      throw err;
    }
    return r.json() as Promise<{ _embedded?: { records?: RawRecord[] }; _links?: unknown }>;
  });
  const records = res?._embedded?.records ?? [];
  const tail = records.length > 0 ? (records[records.length - 1].paging_token ?? null) : null;
  return { records, tail };
}

/**
 * Fetches one page of `transactions?account=` and `effects?account=` through
 * the shared Horizon bulkhead, returning both streams with a gap-free shared
 * cursor.
 */
export async function fetchHorizonHistoryPage(
  address: string,
  opts: { cursor?: string | null; limit?: number; horizonUrl?: string } = {},
): Promise<{ txRecords: RawRecord[]; effectRecords: RawRecord[]; next_cursor: string | null }> {
  const base = (opts.horizonUrl ?? HORIZON_HISTORY_URL).replace(/\/$/, "");
  const limit = clampLimit(opts.limit);
  const cursor = opts.cursor?.trim();
  const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  const acct = encodeURIComponent(address.trim());
  const txUrl = `${base}/accounts/${acct}/transactions?order=desc&limit=${limit}${cursorParam}`;
  const effectsUrl = `${base}/accounts/${acct}/effects?order=desc&limit=${limit}${cursorParam}`;

  const [txPage, effectPage] = await Promise.all([
    getHorizonJson(txUrl),
    getHorizonJson(effectsUrl),
  ]);

  return {
    txRecords: txPage.records,
    effectRecords: effectPage.records,
    next_cursor: minPagingToken(txPage.tail, effectPage.tail),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator (route entry point)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serves a per-wallet timeline page: flag gate → fresh-cache serve → live
 * Horizon fetch through the bulkhead → effects/tx parse + merge → settle ↔
 * forge correlation → cache write; on failure degrades to the last cached
 * page (stale-on-error) or rethrows.
 */
export async function getWalletTimeline(
  address: string,
  opts: { cursor?: string | null; limit?: number; horizonUrl?: string } = {},
): Promise<WalletTimelinePage> {
  if (!isWalletHistory173Enabled()) {
    throw new WalletHistoryError(
      "FLAG_DISABLED",
      "Wallet history is disabled (phase-173 flag off)",
    );
  }
  const wallet = address.trim().toUpperCase();
  if (!isValidStellarAddress(wallet)) {
    throw new WalletHistoryError("INVALID_ADDRESS", `Invalid Stellar address: ${address}`);
  }
  const cursor = opts.cursor?.trim() || null;
  const cacheOn = isWalletHistoryCacheEnabled();
  const { getCachedWalletHistory, setCachedWalletHistory } = await import(
    "@/lib/wallet-history-cache"
  );

  const cached = cacheOn ? getCachedWalletHistory(wallet, cursor) : null;
  if (cached && isWalletHistoryCacheEntryFresh(cached)) {
    return {
      address: wallet,
      events: cached.events,
      next_cursor: cached.next_cursor,
      cache: "fresh",
      indexed_at: cached.cached_at,
    };
  }

  try {
    const page = await fetchHorizonHistoryPage(wallet, { ...opts, cursor });
    const txEvents = parseHorizonTransactionRecords(page.txRecords, wallet);
    const effectEvents = parseHorizonEffectRecords(page.effectRecords, wallet);
    let events = mergeTimelineStreams(txEvents, effectEvents);

    const lookups = await buildTimelineLookups(
      events.map((e) => e.tx_hash).filter((h): h is string => Boolean(h)),
    );
    events = correlateTimelineEvents(events, lookups);

    const indexedAt = Date.now();
    if (cacheOn) {
      setCachedWalletHistory(wallet, cursor, events, page.next_cursor);
    }
    return {
      address: wallet,
      events,
      next_cursor: page.next_cursor,
      cache: cacheOn ? "miss" : "off",
      indexed_at: indexedAt,
    };
  } catch (err) {
    if (cached) {
      // Stale-on-error: serve the last-known timeline rather than failing.
      return {
        address: wallet,
        events: cached.events,
        next_cursor: cached.next_cursor,
        cache: "stale",
        indexed_at: cached.cached_at,
      };
    }
    if (isHorizon429(err)) {
      throw new WalletHistoryError(
        "HORIZON_RATE_LIMITED",
        "Horizon rate-limited the history read; retry shortly.",
      );
    }
    if (err instanceof WalletHistoryError) throw err;
    throw new WalletHistoryError(
      "HORIZON_ERROR",
      `Horizon history fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
