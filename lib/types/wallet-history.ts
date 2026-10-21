export type TimelineEventKind =
  | "payment"
  | "trade"
  | "trustline"
  | "account"
  | "settle"
  | "forge"
  | "tx"
  | "other";

export type TimelineDirection = "in" | "out" | "self" | "none";

/**
 * settle ↔ forge invoice correlation: a timeline transaction whose hash was
 * consumed as a settlement receipt (idempotency store) and/or paid for a
 * forge generation job (job store keyed by settlement tx hash).
 */
export interface TimelineCorrelation {
  kind: "settle" | "forge-settle";
  tx_hash: string;
  settled: boolean;
  forge_job_id?: string;
  forge_job_status?: string;
  collection_id?: number;
}

export interface TimelineEvent {
  /** Deterministic id: `${source}:${horizonId}` — used for dedupe/React keys. */
  id: string;
  kind: TimelineEventKind;
  direction: TimelineDirection;
  /** Decimal string as reported by Horizon (stroops or XLM units). */
  amount?: string;
  /** Asset code, `"XLM"` for native. */
  asset?: string;
  counterparty?: string;
  tx_hash?: string;
  ledger?: number;
  memo?: string;
  /** Raw Horizon record type (`account_credited`, `trade`, tx type, …). */
  type: string;
  occurred_at: string;
  failed?: boolean;
  correlation?: TimelineCorrelation;
}

export interface WalletTimelinePage {
  address: string;
  events: TimelineEvent[];
  /** Shared Horizon cursor (smaller of both stream tails) for the next page. */
  next_cursor: string | null;
  /** How the page was served: live fetch, fresh cache, or stale-on-error. */
  cache: TimelineCacheState;
  indexed_at: number;
}

export type TimelineCacheState = "off" | "fresh" | "stale" | "miss";

export interface WalletHistoryCacheEntry {
  events: TimelineEvent[];
  next_cursor: string | null;
  cached_at: number;
}
