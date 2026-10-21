# Spike 613: Search Analytics — Query Logs, Zero-Result Rate, Clickthrough and Typo Effectiveness

**Issue**: #476
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-175` (`NEXT_PUBLIC_FEATURE_PHASE_175` / `FEATURE_PHASE_175`)
**Key Surfaces**: `lib/search-query-log.ts`, `app/api/world/search/route.ts`, `app/api/profile/search/route.ts`, `app/api/search/click/route.ts`

## Context & Motivation

World and profile search ran with no query logging: zero-result queries were invisible, clickthrough was unmeasured, and the only typo-tolerant path (`searchFollowSuggestionsWithTypoTolerance` in `lib/follow-store.ts`) had no effectiveness baseline. There was no `search_query`, `zero_result`, or `clickthrough` code anywhere in the repo.

## Key Architectural Decisions

1. **Hashed-only persistence (`lib/search-query-log.ts`)**: queries are stored as `sha256(normalized query)` hex; result references and any wallet correlation use the same hashing (phase-100 `viewerAnalyticsKey` precedent). Raw query text never reaches `search-query-log.json`.
2. **Bounded append with dedup**: closed surface/kind enums, zod-validated events, 5,000-event cap, and a 60s duplicate-window on identical `(surface, kind, query_hash, session_id)` so double-submits and beacons do not skew rates.
3. **Pure aggregation**: `computeSearchReport(events, {windowMs})` computes per-surface zero-result rate, clickthrough rate, and typo success rate (a corrected query counts as recovered only if a *later* same-session query hit results). Testable without disk; `getSearchAnalyticsReport` wraps it with the sidecar read.
4. **Non-blocking route hooks**: world search logs free-text queries only (after 400/404 early-returns); profile search logs `q>=2` only (`q<2` is browse). Both `void …catch()` so analytics can never fail the search path. Optional `q0` (pre-correction query) and `sid` (session) params feed typo effectiveness.
5. **Click beacon**: `POST /api/search/click` (404 when flag off, 400 on invalid) records `kind: "click"` events; closed counters (`search_query_total`, `search_zero_result`, `search_click`, `search_typo_corrected`) mirror the `lib/security-counters.ts` closed-label rule.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_175` / `FEATURE_PHASE_175` or set to `0`. `recordSearchQuery`/`recordSearchClick` return null, the click route 404s, search routes skip logging, and `search-query-log.json` stays inert on disk. No migrations.

## Known limitations

- Explore is registered as a closed surface but has no free-text `q` — browse analytics are a follow-up.
- Typo effectiveness is session-scoped; cross-session corrections and true edit-distance baselines against the Levenshtein follow-suggestions path are follow-ups.
- The sidecar is single-instance-safe only (json-store per-process lock; Vercel tmpdir divergence) — volume growth should migrate to the SQLite `search_queries` table.
