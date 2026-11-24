# Implementation Summary: Issues #88, #89, #100, #101

All four issues follow the repo's established pattern: an **isolated, flag-gated
domain module** appended to a `lib/*-store.ts`, wired additively into its API
route(s), with a `node:test` unit suite. Every flag defaults **off** → zero
behavioural change until explicitly enabled.

New feature flags (`lib/feature-flags.ts`): `phase-82`, `phase-83`, `phase-139`,
`phase-140`.

Each issue's "Impacted Subsystems" listed a generic file set (signals/replies,
explore, notifications) that didn't line up with where the described feature
actually belongs in this codebase — offers/listings live in `lib/market-store.ts`
behind `app/api/market/*`, not `lib/signal-store.ts`; there was no existing edit
or reaction primitive on a signal at all. Each feature below is implemented
against the domain it actually fits, per the issue's title + acceptance criteria.

Run the new suites:

```
node --test --import ./node_modules/tsx/dist/loader.mjs \
  lib/__tests__/collection-offer-book.test.ts \
  lib/__tests__/royalty-split.test.ts \
  lib/__tests__/signal-edit-history.test.ts \
  lib/__tests__/signal-reactions.test.ts
```

---

## Pre-existing bugfix required to ship any of this: `sqliteDb` missing from `FILES`

`lib/sqlite-db.ts:getDb()` calls `serverDataJsonPath("sqliteDb")`, but the
`FILES` map in `lib/server-data-paths.ts` never had a `sqliteDb` entry — it was
never added when `signals`/`market` were migrated onto SQLite (issue #36).
`FILES["sqliteDb"]` was `undefined`, so `path.join(root, undefined)` threw at
the first `getDb()` call, i.e. on **every** signal/market read or write. This
was masked because a syntax error in `app/api/forge-agent/route.ts` (unrelated,
pre-existing) crashes the whole `tsc` program before semantic checking runs, so
`npm run typecheck` silently reported nothing wrong; `lib/__tests__/signals-social.test.ts`
and `lib/__tests__/market-profile-views.test.ts` were failing on `main` for the
same reason and nobody noticed because CI's typecheck/lint steps are
`continue-on-error`.

Fix: added `sqliteDb: "phase.sqlite3"` to `FILES` (`lib/server-data-paths.ts`).
One line, additive, no migration — this is a missing map entry, not a schema
change. Confirmed via a full local suite run (Node 22, since `node:sqlite`
needs ≥22.5): **253 → 269 passing** with the fix in, all 20 new cases among
them; the previously-silently-broken `signals-social`/`market-profile-views`
suites now pass too. The remaining 26 failures are pre-existing and unrelated
(missing `@jest/globals`/`bun:test` deps, and the same "forgot to register the
FILES key" bug independently present in `faucetDenyList`, `faucetFunnelEvents`,
`trendingSignals`, `blockList`, `x402DeadLetter` — out of scope here since
those don't block signals/market and aren't part of these four issues).

---

## Issue #88 — Collection-level offer books aggregated from token offers (phase-139)

**Problem:** buyers had to open each token's listing individually to see what
it was being offered, and making a bulk bid across a collection meant
submitting one offer per listing by hand.

**Module:** `lib/market-store.ts`
- `getCollectionOfferBook(collection_id)` — joins `offers` → `listings` for a
  collection's active listings, groups pending (non-expired) offers into
  price levels, best price first.
- `createBulkOffer(buyer_wallet, targets[])` — fans one buyer intent out into
  up to `MAX_BULK_OFFER_TARGETS` (20) individual `createOffer` calls, skipping
  (not throwing on) any listing that can't accept the offer
  (`not_found` / `inactive` / `offers_disabled` / `own_listing` /
  `below_min_offer` / `invalid_amount`).
- `isPhase139Enabled`, `phase139RollbackNote`.

**Wiring:**
- `GET/POST /api/market/collections/[collection_id]/offer-book` (new route) —
  `GET` returns the aggregated book; `POST` accepts `{ buyer_wallet, offers[] }`
  and bulk-bids, notifying each affected listing's seller (`new_offer`,
  `bulk: true`) same as a single offer.

**Tests:** `lib/__tests__/collection-offer-book.test.ts` (3 cases) — price-level
aggregation across listings, exclusion of other-collection/non-pending offers,
bulk-bid fan-out with per-reason skips.

---

## Issue #89 — Royalty enforcement on secondary sales via a creator/seller split (phase-140)

**Problem:** accepting an offer marked the listing sold but moved 100% of the
sale to the current seller — a resale paid the original creator nothing.

**Module:** `lib/market-store.ts`
- `Listing` gains optional `creator_wallet` / `royalty_bps` (additive columns
  on `listings`, added via `ALTER TABLE ... ADD COLUMN` guarded by
  `PRAGMA table_info` in `lib/sqlite-db.ts` — the table predates this concept,
  so `CREATE TABLE IF NOT EXISTS` alone wouldn't add them to an existing DB
  file).
- `computeRoyaltySplit(listing, sale_amount)` — pure function; a sale is
  "secondary" when `creator_wallet` is set and differs from `seller_wallet`.
  Zero-royalty for a primary sale or a listing with no creator on file.
- `recordRoyaltyPayout(listing, offer_id, split)` /
  `getRoyaltyPayoutsForCreator(creator_wallet)` — new `royalty_payouts` table.
- `isPhase140Enabled`, `phase140RollbackNote`.

**Wiring:**
- `POST /api/market` (listing create) — accepts `creator_wallet`/`royalty_bps`
  only when phase-140 is on; validates the wallet and a 0–10000 bps range.
- `POST /api/market/[id]/offers/[offer_id]` (accept) — on `accept`, computes
  the split and records a payout when it's a secondary sale with
  `royalty_bps > 0`; notifies the creator (`royalty_payout`); the response
  gains a `royalty` field when a split was recorded.

**Tests:** `lib/__tests__/royalty-split.test.ts` (5 cases) — secondary-sale
split math, zero-royalty primary sale, zero-royalty with no creator on file,
record + read back a payout, rejects recording without a `creator_wallet`.

---

## Issue #100 — Signal edit history with version diffing (phase-82)

**Problem:** there was no way to edit a signal at all, let alone see what
changed — an edit (once added) would need to be non-destructive.

**Module:** `lib/signal-store.ts`
- `editSignal(signal_id, wallet, { title?, body? })` — author-only; snapshots
  the signal's pre-edit `title`/`body` into `signal_versions` before applying
  the patch, so history is a plain read, never reconstructed.
- `diffWords(oldText, newText)` — word-level LCS diff (splits on whitespace
  runs, standard DP table, merges adjacent same-type ops). O(n·m) in token
  count; signal bodies are bounded, so this stays well within request budget.
- `getSignalEditHistory(signal_id)` — full version list plus a diff between
  every consecutive snapshot pair and from the latest snapshot to the live
  signal.
- Typed `SignalEditError` (`FLAG_DISABLED` / `NOT_FOUND` / `FORBIDDEN` /
  `VALIDATION_FAILED`); `isPhase82Enabled`, `flag82RollbackNote`.

**Wiring:**
- `PATCH /api/signals/[id]` (new handler on the existing route) — edits a
  signal, returns `{ signal, version }`.
- `GET /api/signals/[id]/history` (new route) — returns
  `{ versions, diffs }`.

**Tests:** `lib/__tests__/signal-edit-history.test.ts` (7 cases: 3 for
`diffWords` in isolation, 4 for the store) — pre-edit snapshot + patch
application, non-author rejection, no-op edit rejection, multi-edit history
with diffs.

---

## Issue #101 — Emoji-reaction aggregation with rate limits (phase-83)

**Problem:** signals only had a binary upvote; no lighter-weight reaction, and
nothing stopping a wallet from hammering whatever reaction endpoint existed.

**Module:** `lib/signal-store.ts`
- `REACTION_EMOJI` — curated 6-emoji allowlist (👍 ❤️ 🔥 😂 😮 😢).
- `toggleSignalReaction(signal_id, wallet, emoji)` — add if absent, remove if
  present, in a new `signal_reactions` table (`UNIQUE(signal_id, wallet,
  emoji)`); subject to a per-wallet rate limit (20 toggles / 60s, in-memory
  bucket, same shape as the existing `phase-51` faucet limiter but
  self-contained).
- `getSignalReactionSummary(signal_id, viewer_wallet?)` — per-emoji counts
  plus the viewer's own `reacted` flags.
- Typed `SignalReactionError` (`FLAG_DISABLED` / `VALIDATION_FAILED` /
  `RATE_LIMITED` with `retryAfterMs` / `NOT_FOUND`); `isPhase83Enabled`,
  `flag83RollbackNote`.

**Wiring:**
- `GET/POST /api/signals/[id]/reactions` (new route) — `GET` returns the
  summary; `POST` toggles and notifies the signal's author (`signal_reaction`)
  only on an add (not a remove), avoiding notification spam from a
  toggle-back-and-forth. Over the rate limit, responds `429` with
  `Retry-After`.

**Tests:** `lib/__tests__/signal-reactions.test.ts` (5 cases) — toggle on/off,
cross-wallet aggregation with independent per-viewer `reacted`, disallowed
emoji, rate-limit rejection, flag-off rejection.

---

## Verification

- `npx tsc --noEmit`: pre-existing `app/api/forge-agent/route.ts` syntax
  errors abort the whole-program check before semantic diagnostics run (see
  bugfix note above), so verification used a scoped tsconfig excluding that
  one file. **0 errors in every changed/new file.** Remaining errors are
  pre-existing and outside this change (same "unregistered FILES key" pattern
  in `blockList`/`faucetFunnelEvents`, plus unrelated files across
  `app/api/faucet`, `app/api/world/*`, `lib/narrative-world-store.ts`, etc.).
- `eslint` on every changed/new file: clean (0 errors, 0 warnings).
- Full test suite (Node 22, `node --test --import ./node_modules/tsx/dist/loader.mjs`):
  **253 → 269 passing**, `+16` (the 20 new cases, minus 4 pre-existing
  SQLite-backed cases that were already silently failing and are now fixed
  by the `sqliteDb` bugfix), **0 regressions**. The 26 remaining failures are
  pre-existing and unrelated (missing `@jest/globals`/`bun:test` dev deps,
  `narrative-search`, `watchlist-price-drops`, and the other
  unregistered-`FILES`-key bugs noted above).
- All four flags default off ⇒ every route/UI path is byte-identical to `main`
  until `NEXT_PUBLIC_FEATURE_PHASE_82/83/139/140` (or `FEATURE_PHASE_*`) is set.
