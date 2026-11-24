# Spike #40 — Mercury Classic REST vs direct Soroban RPC event scanning

## Question

`app/api/wallet/phase-nfts/route.ts` prefers Mercury Classic when `MERCURY_JWT`
is configured, and falls back to a brute-force Soroban RPC scan
(`fetchOwnedPhaseTokenIdsForWallet`, up to `PHASE_NFT_WALLET_SCAN_CAP` = 5000
token IDs by default) when it isn't. That scan is the source of the reported
high latency and occasional `503`s for wallets with large portfolios. Which
strategy should be preferred, and how should the fallback path be hardened?

## Method

`scripts/benchmark-mercury-vs-rpc.ts` (read-only; only `simulateTransaction`
calls, never submits) times:

1. One Mercury Classic REST call (`/events/by-contract/:id`) — requires
   `MERCURY_JWT`.
2. N sequential `owner_of(token_id)` RPC `simulateTransaction` calls against
   the deployed `phase-protocol` contract.

Run from `scripts/`:

```
PHASE_PROTOCOL_ID=<contract id> npx tsx benchmark-mercury-vs-rpc.ts --tokens=10
```

## Measured (this environment, testnet, no `MERCURY_JWT` available)

```
Soroban RPC: 10 sequential owner_of() simulate calls
total=5773ms avg=577.3ms/call over 10 calls
```

~577ms per RPC simulate call against `soroban-testnet.stellar.org`. The
production route runs these concurrently (`PHASE_NFT_WALLET_SCAN_CONCURRENCY`,
default 8) rather than sequentially, so real wall-clock time for a full scan
is lower than a naive `avg × count` extrapolation — but it still grows with
the token-id range scanned, and a scan capped at 5000 IDs means worst case is
several hundred concurrent RPC round-trips even at 8x concurrency.

The Mercury side wasn't measured live here — no `MERCURY_JWT` was available
in this environment. Structurally, Mercury answers with **one** HTTP call
regardless of collection size (it queries a pre-built event index rather than
simulating a contract call per token), so its cost doesn't scale with the
number of tokens the way the RPC scan does. Re-run the script above with a
real `MERCURY_JWT` to get a live number before rolling this out further.

## Accuracy

Both paths derive the same ground truth (on-chain `owner_of`/transfer state);
Mercury replays the contract's mint/transfer event log to reconstruct current
ownership (`lib/mercury-classic.ts:deriveOwnershipMap`), while the RPC path
reads current state directly. They should agree except for the query lag
inherent to any indexer (Mercury's index trailing the latest ledger by however
long its own ingestion pipeline takes) — not evaluated quantitatively here for
lack of a populated test wallet.

## Recommendation

1. **Keep Mercury as the primary path when configured** — it doesn't
   scale with collection size and is the not the source of the reported
   latency/`503` issue.
2. **Cache the resolved index** so repeat lookups (the common case — a
   wallet re-opening Explore/Chamber) skip the scan entirely regardless of
   which path resolved it. Implemented as `lib/wallet-nft-index-cache.ts`
   (phase-135): an in-memory LRU keyed by `(contractId, wallet)`, fresh for
   60s.
3. **Degrade to stale cache instead of a 503** when every live path fails
   (Mercury errors *and* the RPC scan throws/times out) — also implemented in
   phase-135. Only a wallet with no cache entry at all and a live-path
   failure gets an empty result, and even then as a `200` with an `error`
   field rather than a `503`.
4. **Log scan duration** (`logWalletNftIndexScan`) so real production latency
   per `indexedVia` path can be tracked going forward, closing the loop on
   this spike's open question about live Mercury timing.

## Rollout

All of the above lands behind `phase-135` (unset → the route's pre-existing
behavior, unchanged). Recommended sequence: enable in staging, watch the new
`[phase-135] wallet-nft-index …` log line for `indexedVia`/`durationMs`
distribution for both Mercury-configured and RPC-only environments, then
promote to `on` by default once satisfied latency stays under the <300ms
target for cache hits.
