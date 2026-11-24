# Spike 551 — Real-Time Live Updates for Signals, Notifications, Market and Explore

Status: **proposed spike / research complete, not implemented**.
Batch: 550–599. Files in scope: 20. Effort: 3–6 weeks.

## Verdict first

SSE is the right transport for this deployment; WebSockets are not. Vercel's
Node route handlers can stream a `ReadableStream` for the life of
`maxDuration`, but they cannot hold an upgrade socket. The hard part is not the
stream — it is **wallet-scoped authorization on a transport that cannot send
headers** and **cross-instance fanout**, because serverless instances share no
memory.

The spike should be split:

1. **Phase 1 (safe):** same-origin SSE for public channels
   (`signals:global`, `market:public`) + a signed, HttpOnly cookie for private
   channels. In-process hub only, explicitly documented as single-instance.
2. **Phase 2 (correct):** an external fanout adapter (Ably/Pusher, or a hosted
   Redis with a streaming bridge) so every instance publishes to the same bus.
   The server secret stays server-side; the browser gets a scoped token, never
   `MERCURY_JWT` or `PHASE_ADMIN_KEY`.
3. **Phase 3 (optional):** presence, typing, live cursors. Not required for the
   feed.

## What the brief claimed vs. what the code actually does

| Claim | Verified reality |
|---|---|
| "30s polling (notifications-modal)" | True: `POLL_INTERVAL_MS = 30_000` (`components/notifications-modal.tsx:53`), `setInterval` at `:267`. There is no in-flight guard, so slow requests can overlap. |
| "cache:no-store refetch (explore, signals)" | Half true. Explore uses `cache: "no-store"` (`app/explore/page.tsx:61`). Signals do **not** poll or force no-store; they fetch on mount/filter/load-more only (`app/signals/page.tsx:368-400`). Signal detail is `force-dynamic` RSC with no live refresh. |
| "Mercury webhook-only index" | False. Mercury is queried pull-style over REST (`lib/mercury-classic.ts`, `app/api/nft-index/route.ts`). `app/api/nft-index/subscribe/route.ts` registers a webhook and verifies reachability, but there is **no Mercury receiver route**, no secret persistence, and no HMAC verification. The only inbound webhook is NanoBanana, which skips verification if `NANOBANANA_WEBHOOK_SECRET` is unset. |
| "No WebSocket/EventSource/SSE in package.json/lib" | True. Zero `EventSource`, `new WebSocket`, `text/event-stream`, `socket.io`, `ws`, or realtime dependencies. `ReadableStream` appears only in a world export download and a test. |
| "Only Yjs HTTP-poll CRDT" | False. There is **no `yjs` dependency, no Yjs import, no `signal-crdt.ts`, no CRDT route**. The only collaborative conflict mechanism is `expected_version` / `expected_vector_clock` on `POST /api/world` (`app/api/world/route.ts:137-177`, `lib/world-conflict.ts`), and its save is not a CAS. |
| "Explore already needs monotonic loadSeq" | True. `loadSeq` guards only the newest response (`app/explore/page.tsx:53-75`); requests are not aborted. Pagination is offset/slice, so live inserts shift page boundaries. |
| "MAX_PER_WALLET=50 cap vs live burst" | True: `MAX_PER_WALLET = 50` (`lib/notification-store.ts:38`, `:237-240`). The notification store has **no lock and no atomic rename**; concurrent fanout can lose writes (`:206-241`). |
| "60/min/IP" | Only a helper; it is never called from the Soroban POST handler (`app/api/soroban-rpc/route.ts:134-151`). Active controls are `MAX_IN_FLIGHT=12`, a 5-slot Horizon bulkhead, and 20/60s per-wallet reactions. Signals/notifications/market have no rate limits. |

### Baseline blockers

- `lib/signal-store.ts` is a broken JSON/SQLite merge on this HEAD
  (`:154-177` references undeclared `conditions`, unimported `getDb`, redeclares
  `items`). `GET /api/signals` cannot run. A repair exists on
  `origin/fix/signal-store-sqlite-merge-repair` (`936e42a`) but is unmerged.
- Write auth is not ready for wallet-scoped live channels:
  - upvotes send the wallet address as the "signature" and the server never
    verifies it (`app/api/signals/[id]/route.ts:65-88`,
    `app/signals/page.tsx:433-437`);
  - poll votes never receive a signature (`app/api/signals/[id]/vote/route.ts`);
  - reactions are unsigned (`app/api/signals/[id]/reactions/route.ts:41-84`);
  - notifications are IDOR: `GET ?wallet=` and `POST body.wallet` are trusted
    (`app/api/notifications/route.ts:38-46,120-163`);
  - market listings are unsigned (`app/api/market/route.ts:40-43`).
- `x-admin-key` and `PHASE_ADMIN_KEY` **fail open when unset** in
  `nft-index/subscribe` and moderation. That is unacceptable for a fanout
  admin surface.

A live channel keyed only by `?wallet=` would let anyone subscribe to another
wallet's notifications. Fix the write/read auth before exposing private streams.

## Q1 — Minimal closed loop

```
wallet connect
  -> POST /api/live/token  { wallet, timestamp, signature }
     verify SEP-53 (lib/viewer-signature.ts), mint HttpOnly live_session cookie
  -> GET /api/live/stream?channels=signals:global,wallet:G...
     text/event-stream, Last-Event-ID, retry: 3000
  -> signal create / upvote / reply / offer
     route emits event AFTER the store commit
  -> hub -> SSE -> client useLiveChannel
  -> merge by version; refetch on gap; toast via use-toast-queue
```

The loop is closed when a second browser sees the mutation within one second
without polling, and a reconnect after `kill -9` resumes from `Last-Event-ID`
without duplicating a toast or losing a mutation.

### Which file can fail it independently

| Stage | File | Independent failure |
|---|---|---|
| Store commit | `lib/signal-store.ts` | Broken merge; no event emitted because the write throws. |
| Emission | route handlers | Emit before commit → clients see a phantom; emit after response → race with the next read. |
| Auth | `app/api/live/token` (new) | `?wallet=` forgery; replay of a token; cookie not HttpOnly. |
| Fanout | new `LiveFanout` adapter | In-process hub sees only same-instance events. |
| Caps | stream route | Unbounded connections/queue → OOM or silent drops. |
| CSP | `middleware.ts` + `next.config.mjs` | Two policies intersect; `ws://localhost` and `worker-src blob:` are allowed only in `next.config.mjs`. |
| Client merge | `app/explore/page.tsx`, `app/signals/page.tsx` | `loadSeq` discards a live event that arrived before the fetch; offset pagination duplicates/skips. |
| Toast | `hooks/use-toast-queue.ts` | Duplicate events flood the single-visible-toast queue. |

## Q2 — Replay/idempotency map

| Write | Key today | Live-update impact | Required change |
|---|---|---|---|
| Signal create | none (signature only) | No idempotency; retry creates duplicates. | `Idempotency-Key` scoped to wallet; unique `(wallet, key)` for 10 min. |
| Signal edit | `If-Match` version (`app/api/signals/[id]/route.ts:162-165`) | Event carries `version`; client ignores stale. | Keep. |
| Reply | optional `parent_version` (`replies/route.ts:160-205`) | TOCTOU before file lock (`lib/signal-store.ts:248-258`). | Check inside the locked mutation. |
| Upvote | optional `If-Match` (`[id]/route.ts:72-85`) | Event should carry new `version` and count. | Verify signature. |
| Poll vote | none | One vote per wallet enforced in store. | Verify signature; emit `signal.voted`. |
| Reaction | 20/60s per wallet, unsigned | Duplicate toggles. | Verify signature; event id = `signal:reaction:<signal>:<wallet>:<emoji>:<seq>`. |
| Notification read | none, IDOR | Mark-read can race. | Wallet token; `If-Match` on notification version or `updated_at`. |
| Market listing/offer | none for writes | Live event could precede SQLite commit. | Emit after `BEGIN IMMEDIATE` commit; `listing.version`. |
| SSE delivery | `Last-Event-ID` | Not a write, but replay must be exact. | Monotonic `seq` per channel; ring buffer + DB fallback. |

SSE does not need write idempotency, but it must not turn a transient reconnect
into a duplicate mutation. Mutation requests keep their own idempotency keys;
the stream only replays events.

### Event envelope

```ts
export type LiveEvent = {
  id: string;            // `${channel}:${seq}` — Last-Event-ID
  seq: number;           // monotonic per channel
  type:
    | "signal.created" | "signal.updated" | "signal.voted" | "signal.replied"
    | "signal.reacted" | "notification.created" | "notification.read"
    | "listing.created" | "offer.created" | "offer.accepted" | "resync";
  channel: string;       // signals:global | wallet:G... | market:public
  version?: number;      // entity version for merge
  ts: number;            // server wall clock, display only
  payload: unknown;      // already-public projection; never a full store row
};
```

`payload` is a **public projection**. Do not serialize `wallet`, email, private
notification text, or admin fields into a public channel. Private channels use
the same envelope but are authorized per wallet.

## Q3 — Drift, rotation, failover

| Failure | Fence |
|---|---|
| Contract-ID drift (indexer events) | `get_config()` (`lib/phase-protocol.ts:623-643`); indexer stores the contract ID that emitted the event and drops mismatches. |
| Issuer rotation | `resolvePhaserLiqClassicAsset()` (`lib/stellar.ts:93`); asset/issuer is part of the event key. |
| CID/gateway drift | `token_uri?c=` + `lib/cid-verification.ts`; `prioritizeGatewaysByHealth` is **server-only** (`lib/phase-nft-metadata-build.ts:59-80`). The browser must not fan out to arbitrary gateways. |
| Fanout provider failover | `LiveFanout` interface with `publish`, `subscribe`, `health`; primary → secondary; if both fail, degrade to polling and emit `live.degraded` (closed label). |
| Mercury webhook | There is no receiver today. Add HMAC verification, replay window, and a contract-ID/event-type allowlist before treating Mercury as a source. Do not expose `MERCURY_JWT` to the client. |
| CSP | Reconcile `middleware.ts` and `next.config.mjs` into one policy. SSE needs `connect-src 'self'` (already allowed). External fanout needs its origin in **both** policies. `worker-src blob:` must be added to middleware if a client worker is used. |
| Deploy skew | Event schema version in the envelope (`v: 1`); client ignores unknown types; server keeps a 5-minute replay window across deploys. |

## Q4 — Status-code taxonomy

| Code | When | Headers / recovery |
|---|---|---|
| `401 LIVE_TOKEN_REQUIRED` | No/invalid `live_session` cookie on a private channel. | UI calls `/api/live/token` again (one wallet prompt), then reconnects. |
| `403 LIVE_CHANNEL_FORBIDDEN` | Cookie wallet does not own `wallet:G...`. | Drop the channel; do not retry. |
| `409 LIVE_RESYNC_REQUIRED` | `Last-Event-ID` older than the replay window. | SSE `event: resync` with current versions; client refetches pages. |
| `409` on mutation | Version conflict (existing contract). | `current_version` + `ETag`; merge/rebase; keep draft. |
| `412` on mutation | Precondition failed (stale `If-Match`). | Show current state; do not auto-replay. |
| `428` on edit | Missing `If-Match`. | Client bug; attach the latest ETag. |
| `429 LIVE_RATE_LIMITED` | Too many connections/events per wallet/IP. | `Retry-After`, `X-RateLimit-Limit/Remaining/Reset`; exponential reconnect with jitter. |
| `503 LIVE_UNAVAILABLE` | Fanout/store down. | `Retry-After`; SSE `retry:` field; fall back to 30s polling. |

SSE-specific semantics:

- `id:` is the `Last-Event-ID`; `retry: 3000` tells EventSource how long to wait.
- A heartbeat comment (`: ping`) every 15s keeps proxies from closing an idle
  stream.
- On `resync`, the client must **replace** paginated state with a fresh fetch,
  not merge stale pages; `loadSeq` still guards the newest fetch.
- The UI must not lose a draft: compose/reply drafts are persisted to
  `sessionStorage` before any remote merge, and a `409` shows a conflict banner
  with "keep mine / reload".

## Q5 — Migration and rollback

- **No schema change required for phase 1.** The in-process hub is memory only.
- Phase 2 adds an additive `live_events` table (or provider retention) for
  `Last-Event-ID` replay; `CREATE TABLE IF NOT EXISTS`, indexed on
  `(channel, seq)`.
- Notification fanout must become atomic before live delivery:
  `lib/notification-store.ts` needs the same `withFileLock` + `tmp+rename`
  pattern as `lib/signal-store.ts:66-123`. Without it, a live event can announce
  a notification that was lost by a concurrent write.
- Flag `phase-551` gates the stream route and client hook. Off: notifications
  return to 30s polling, feeds stay fetch-on-mount, no event emission.
- Rollback is unset/restart. Any `live_events` rows remain inert. No provider
  secret is rotated by rollback; rotate it separately if compromised.
- Do **not** put a bearer token in the SSE URL. Use the HttpOnly cookie. Logs,
  Referer, and browser history must never contain a stream credential.

## File-by-file invariant map

| File | Change or ruling-out | Invariant |
|---|---|---|
| `app/api/signals/route.ts` | Emit `signal.created` after commit; add idempotency key. | No phantom events. |
| `app/api/signals/[id]/route.ts` | Emit update/vote; verify upvote signature. | Event version matches stored version. |
| `app/api/signals/[id]/replies/route.ts` | Emit reply; check `parent_version` inside the lock. | No lost/duplicate replies. |
| `app/api/signals/[id]/reactions/route.ts` | Verify signature; emit reaction. | No spoofed reaction events. |
| `app/api/signals/[id]/vote/route.ts` | Verify signature; emit vote. | One vote per wallet. |
| `app/api/notifications/route.ts` | Wallet auth; emit created/read. | No IDOR over live notifications. |
| `app/api/nft-index/subscribe/route.ts` | Fail closed on admin key; add receiver/HMAC before use. | No open webhook registration. |
| `app/api/market/route.ts` | Sign listings; emit created. | No fake seller events. |
| `app/api/explore/route.ts` | Keep `s-maxage`; add `revalidateTag`/live invalidation. | Live insert does not bypass pagination correctness. |
| `app/signals/page.tsx` | `useLiveChannel`; merge by version; keep filters. | No reorder/duplicate under burst. |
| `app/signals/[id]/page.tsx` | Subscribe to the signal channel. | Detail matches list. |
| `app/signals/[id]/signal-detail-client.tsx` | Fix reply signature placeholder; live merge. | Server-verifiable reply. |
| `app/explore/page.tsx` | Keep `loadSeq`; add resync; handle offset drift. | Newest fetch wins. |
| `components/notifications-modal.tsx` | Replace 30s poll with SSE + fallback. | No overlapping polls; no missed badge. |
| `components/signal-compose.tsx` | Draft persistence; idempotency key. | User input survives reconnect. |
| `lib/signal-store.ts` | **Repair the merge first**; emit hook after commit. | Store is the source of truth. |
| `lib/notification-store.ts` | Add lock + atomic rename; emit hook. | No lost notifications. |
| `hooks/use-toast-queue.ts` | Dedupe by event id; cap live burst. | One visible toast, no flood. |
| `middleware.ts` | Reconcile CSP; SSE/fanout origins. | No secret exfiltration; stream allowed. |
| `next.config.mjs` | Reconcile CSP; keep `worker-src blob:` only if needed. | Single effective policy. |

## New modules (proposed)

```ts
// lib/live/types.ts
export type LiveChannel = `signals:global` | `market:public` | `wallet:${string}`;

// lib/live/fanout.ts
export interface LiveFanout {
  publish(event: LiveEvent): Promise<void>;
  subscribe(channel: string, onEvent: (e: LiveEvent) => void): () => void;
  health(): Promise<"ok" | "degraded" | "down">;
}
// InProcessFanout for dev/single instance; ProviderFanout (Ably/Pusher) for prod.

// app/api/live/stream/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// app/api/live/token/route.ts
// POST { wallet, timestamp, signature } -> Set-Cookie: live_session=<HMAC>; HttpOnly; Secure; SameSite=Lax; Path=/api/live
```

## Caps and metrics

- 3 concurrent streams per wallet, 20 per IP; 256 queued events per connection;
  drop oldest non-critical event and increment `live_events_dropped`.
- Heartbeat 15s; reconnect backoff 1s→30s with jitter; `maxDuration` 300s.
- Coalesce same-entity updates within 250ms.
- Closed counters: `live_connections`, `live_events_emitted`,
  `live_events_dropped`, `live_reconnects`, `live_auth_failures`,
  `live_backpressure`, `live_fanout_degraded`.

## Tests and acceptance evidence

- Two clients, one mutation: both receive exactly one event; no duplicate toast.
- Kill the stream mid-event: reconnect with `Last-Event-ID` replays the gap; a
  stale ID triggers `resync`.
- Forge a `wallet:` channel with another wallet's cookie → 403.
- Burst 1,000 events: queue cap holds, oldest dropped, metric moves, no OOM.
- External fanout killed: fallback to polling, `live.degraded` metric, UI shows
  a non-blocking banner.
- Flag off: notifications poll every 30s exactly as today; no stream route.
- CSP: no console violations under middleware-only and next-config-only
  enforcement (the effective intersection).
- `npm run typecheck && npm test` green with the flag off.

## Risks / non-goals / estimate

- **Risk:** serverless fanout is the whole problem. Do not ship phase 1 as
  "real-time" if the deployment runs more than one instance.
- **Risk:** private channels on unauthenticated reads turn into a wallet IDOR.
  Fix auth first.
- **Risk:** event payloads leak private notification text into a public channel.
  Use projections, not store rows.
- **Non-goal:** presence/typing/cursors in phase 1; mainnet; replacing SQLite.
- **Estimate:** 1 w transport/auth, 1–2 w store hooks + UI, 1 w fanout/hardening.
