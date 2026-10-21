# Spike 629: Transaction History Halte with Horizon-Backed Per-Wallet Timeline

**Issue**: #492
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-173` (`NEXT_PUBLIC_FEATURE_PHASE_173` / `FEATURE_PHASE_173`)
**Key Surfaces**: `lib/wallet-history.ts`, `lib/wallet-history-cache.ts`, `app/api/history/route.ts`, `components/wallet-history-timeline.tsx`

## Context & Motivation

There was no history UI: balances were point-reads (`getTokenBalance`, settle token balance, native XLM), the Chamber logged ephemeral `appendLog` lines and polled balances every 12s, and bulkhead + Mercury served balances and indexes — not a per-wallet timeline. No `/api/history`, no Horizon `transactions?account=` fetch, no effects parsing, no settle ↔ forge invoice correlation, and no index-cache wiring to the UI. Not spike 557 (backend full ingestion + cursors) or 558 (`getEvents` indexer + reorg guard): this is the per-wallet presentation layer above those pipelines.

## Key Architectural Decisions

1. **Effects-first timeline (`lib/wallet-history.ts`)**: `fetchHorizonHistoryPage` fetches `transactions?account=` and `effects?account=` together through `withHorizonBulkhead` (semaphore + 429 counting) with an 8s `AbortSignal.timeout`. Effects carry per-wallet granularity (payment/trustline/trade); transaction rows supply memo/fee/success. `mergeTimelineStreams` drops transaction rows already covered by an effect for the same hash while keeping failed transactions (which produce no effects), dedupes by id, and orders newest-first with a ledger tiebreak.
2. **Gap-free shared cursor**: Horizon paging tokens are shared across endpoints, so the page cursor is the *smaller* of both stream tails (`minPagingToken`, BigInt-safe) — no events can be skipped between the two streams.
3. **settle ↔ forge invoice correlation**: `correlateTimelineEvents` is pure and injectable; `buildTimelineLookups` (lazy store imports) joins tx hashes against the settlement idempotency store (`isSettlementUsed`) and the forge generation-job store (`getGenerationJobByTxHash`, keyed by settlement tx hash). Matched events are annotated with `{kind: settle|forge-settle, settled, forge_job_id, forge_job_status, collection_id}` and forge-lane events are promoted to `kind: "forge"`.
4. **Index-cache wiring (`lib/wallet-history-cache.ts`)**: phase-135-style in-memory LRU (300 entries, 30s freshness) keyed by `wallet:cursor`, wired in `getWalletTimeline` — fresh-serve on hit, stale-on-error degrade on Horizon failure (or 503 from the route when no cache exists yet, `HORIZON_RATE_LIMITED` mapped to 503).
5. **UI (`components/wallet-history-timeline.tsx`)**: mounted on the dashboard's PHASE_VAULT tab behind `isFeatureEnabled("phase-173")`, renders the timeline with direction markers, bilingual kind labels, correlation badges (`FORGE · status` / `SETTLE`), cursor-based "Load more", an explicit stale-cache banner, and error/retry states. Flag off → component and route both absent (zero regression).

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_173` / `FEATURE_PHASE_173` or set to `0`. `GET /api/history` returns 404, the dashboard timeline renders nothing, and the cache is never read or written. No sidecars, no migrations — the cache is in-memory only.

## Known limitations

- Effect records without `transaction_hash` (Horizon-version dependent) cannot be joined to their transaction row; both are shown rather than dropped (dedupe degrades to id-only).
- Ledger ingestion, cursors, and reorg handling remain out of scope (spikes 557/558) — this layer reads Horizon live per request behind the cache.
