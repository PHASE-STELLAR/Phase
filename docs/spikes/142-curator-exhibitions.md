# Spike 142 — Autonomous curator exhibitions (phase-142)

## What the issue claimed, checked against the code

| Claim | Verified |
|---|---|
| Explore builds items by paginating `allWithMeta`, filter-by-collection only | Yes — `app/api/explore/route.ts` builds metadata for every scanned token on the filtered path |
| Search is a substring filter with no ranking | Yes — `searchNarratives` filters and sorts newest-first |
| Prompt builder / narrator are single-artifact | Yes — `buildLoreSystemInstruction` and `/api/narrator` take one token plus ≤5 prior narratives |
| No exhibitions persistence, notification type, curator copy | Yes |
| Image renderer has no layout awareness | Partly — `IpfsDisplayImg` renders `null` when gateways are exhausted, which collapses a slot in any ordered layout |

## Design

A show is one versioned `exhibitions` row: scope, status, theme terms, the
whole hang as JSON (positions, token, world, verified owner, score, matched
terms, wall text, image), cover, `input_hash`, model id, prompt hash, and
whether the text came from the model or the template.

1. **Corpus** — `getNarrativeCorpus` reads lore (≤2000 docs) from the sidecar.
   Tokens without lore cannot be themed, so the curator never touches the
   explore owner scan.
2. **Theme** — the requester's theme, tokenized; otherwise `induceThemeTerms`:
   a term in ≥3 documents *and* ≥2 collections, not in more than half the
   corpus, extended with terms co-occurring in ≥50% of its documents.
3. **Shortlist** — BM25 (`rankLoreDocuments`), top 40.
4. **Exclusions** — tokens with a wash-flagged accepted sale in 30 days;
   tokens whose owner cannot be verified (cache first, then a bounded
   `owner_of` per missing id). An unverifiable owner is excluded, not assumed
   distinct, otherwise the owner cap is trivially bypassed.
5. **Hang** — cover = top relevance; closer = second; the middle by MMR
   (λ=0.7, Jaccard over lore terms) with a same-world adjacency penalty; no
   owner above 25% of the hang.
6. **Words** — one sentence per work (the one carrying the most theme terms) is
   sent in one prompt. The reply must contain exactly one wall per hung token,
   no `#id` outside the hang, and fit the length budgets; otherwise the
   templated copy is kept and `curator_citation_rejected` moves.
7. **Lifecycle** — `draft → published → rotated` under `BEGIN IMMEDIATE` with
   `If-Match`. Publishing rotates the live show in the same scope in the same
   transaction, then notifies each hung owner.

Idempotency: `input_hash` = hash(scope, lang, theme, ordered token ids). A
retried draft returns the stored draft (and is re-checked under the write lock
so two concurrent identical drafts persist once).

## File rulings

| File | Ruling |
|---|---|
| `app/api/explore/route.ts` | **Ruled out.** The curator must not reuse its O(all tokens) scan; it reads the scan's *cache* instead (next row). Changing explore's response would also change a public, cached contract for no curator benefit. |
| `lib/explore-domain.ts` | **Ruled out.** `mapConcurrent` is reused unchanged by the exhibitions route; the hang planner is curator-specific and lives in `lib/exhibition-curator.ts`. |
| `lib/explore-owners-cache.ts` | **Changed.** `lookupCachedOwners(ids, maxAge)` — shortlist-only lookup from the freshest cached scan, with a staleness bound so the owner cap is not enforced against stale owners. |
| `lib/narrative-world-store.ts` | **Changed.** `getNarrativeCorpus` — bounded, optionally collection-scoped lore read. |
| `lib/narrative-search.ts` | **Changed.** `tokenizeLore` (EN/ES stopwords, accent folding), `rankLoreDocuments` (BM25), `induceThemeTerms`. |
| `lib/forge/ai-pipeline.ts` | **Changed.** `generateJsonStep` (JSON mode, model fallback chain, timeout, provider-default safety, `blockReason` surfaced) + `aiPromptHash`. |
| `lib/forge/prompt-builder.ts` | **Changed.** `buildExhibitionPrompt`; third-party lore is embedded as JSON in an untrusted-data block. |
| `app/api/narrator/route.ts` | **Ruled out.** The narrator writes the per-artifact lore the curator reads; it is idempotent (never regenerates an existing narrative), so a published wall can never go stale under it. Moving it onto `generateJsonStep` is a separate refactor. |
| `lib/market-store.ts` | **Changed.** `getWashFlaggedTokenIds` (shared with spike 143's comp queries). |
| `lib/server-data-paths.ts` | **Ruled out.** Exhibitions live in SQLite (`phase.sqlite3`, already registered), not a new JSON sidecar — a JSON sidecar would make publish-rotates-live non-atomic across instances. |
| `lib/notification-store.ts` | **Changed.** `exhibition_published` type (also wired in `components/notifications-modal.tsx`). |
| `lib/phase-copy.ts` | **Changed.** `curator` section (EN/ES): fallback title/statement/wall text, statuses, errors, notification text; plus `fillCopy`. |
| `components/ipfs-display-img.tsx` | **Changed.** Optional `fallback` node rendered when the URI is empty or every gateway failed, so a dead CID keeps its frame in the hang. Default behaviour unchanged. |
| `app/api/world/[collection_id]/export/route.ts` | **Ruled out.** Export is a deterministic archive of one world; exhibitions are cross-collection, versioned and rotate. Including them would make the export non-deterministic and couple phase-112 to phase-142. Exhibitions have their own read routes. |
| `lib/cost-attribution-ledger.ts` | **Changed.** `AI_COST_STEPS` (closed), `estimateAiTextCost`, `chargeAiStep`; job id `curator:<input_hash>` so retries are charged once. |

New: `lib/exhibition-curator.ts`, `lib/admin-key.ts`, `app/api/exhibitions/**`,
`app/exhibitions/[id]/page.tsx`, `components/exhibition-hang.tsx`.

## Tests

`lib/__tests__/exhibition-curator.test.ts` (15): BM25 drops non-matching
documents; one-world vocabulary cannot seed a theme; EN/ES accent folding;
owner cap; unverified owners excluded; no adjacent same-world works; excerpt
selection; wall-text validation (unknown token, missing wall, bad citation,
bad shape); model text kept and charged once; hallucinated citation → template;
model down → template; retry reuses the draft with one model call; wash tokens
never hung; insufficient candidates → error; publish rotates the live show,
stale version → `VERSION_CONFLICT`, republish → `INVALID_TRANSITION`.

## Known limits

- Cross-instance: the lore corpus is still a JSON sidecar, so on Vercel each
  instance curates from its own copy (docs/TECHNICAL.md §5.4).
- Taste is not evaluated. The harness measures coherence proxies (BM25 score,
  diversity); a human-rated eval set is the next step before shows are drafted
  on a schedule.
