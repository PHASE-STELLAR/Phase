# Spike 146 — AI moderation pre-screen (phase-146)

## What the issue claimed, checked against the code

| Claim | Verified |
|---|---|
| Takedown/restore is human-only, sets `taken_down=1` | Yes |
| Audit has no AI fields; reads filter by signal | Yes — and `appendModerationAuditEvent` was an unlocked read-then-write, so two concurrent moderators could drop each other's events. Fixed. |
| Generation uses `BLOCK_NONE` | Yes, forge and narrator. Classification uses provider defaults instead, and treats a provider block as evidence. |
| Create path has no pre-screen; CRDT merge has no hook | Yes |
| The moderator "signature" is not verified | **Also true, not in the issue** — the legacy route only checks it is non-empty. The new queue routes verify it (SEP-53, bound to item + action). |

## Design

Queue row per screened *revision* (`UNIQUE (target_kind, target_id, text_hash)`,
so a retried create enqueues once). The signal row is never written by the AI;
visibility is a queue column, and listings filter on the target's latest row.

**Hot path.** Create/reply/edit run a local pre-screen (link floods, char
runs, shouting, ≥3 identical posts in 24h, EN/ES injection phrases) and an
`INSERT OR IGNORE`. The model call runs after the response under a 60s
version-guarded lease; `POST /api/moderation/queue/drain` recovers anything a
frozen instance dropped. Failed classifications retry up to 3 attempts, then
the fail policy decides.

**Decision** (calibrated score = max(model, local) per category):

| Category | review at | hold at | fail mode |
|---|---|---|---|
| csam | 0.05 | 0.2 | **closed** |
| sexual | 0.5 | 0.85 | open |
| hate | 0.4 | 0.8 | open |
| harassment | 0.5 | 0.85 | open |
| violence | 0.5 | 0.9 | open |
| spam | 0.6 | 0.95 | open |
| prompt_injection | 0.5 | never | open |

- Hidden if `auto_hold`, or `human_review` driven by a fail-closed category.
- Classifier down: hold if a fail-closed category has a local hit or the item
  carries media the local screen cannot read; otherwise human review, visible.
- Provider refused the prompt: hold (evidence, not verdict).
- **Injection floor:** a local injection hit is at least `human_review`, no
  matter what the (possibly manipulated) model scores say.
- **Sticky holds:** a new revision of hidden, not-human-allowed content starts
  hidden and stays hidden after scoring — editing one character cannot launder
  a held post.
- Confidence = normalized distance to the nearest threshold that would change
  the decision.

**Humans.** Queue sorted by `due_at` (hold 1h, review 24h, appeal 24h) with
`sla_breached`. Moderators `claim` (15-min assignment lease), `allow` or
`takedown`, each with `If-Match`, the operator key and a wallet signature over
`moderate:<id>:<action>`. A takedown also sets the phase-113 `taken_down` flag,
so human decisions survive a rollback of this flag. Every resolution writes the
audit with the AI decision, confidence, model id, prompt hash, scores and
agree/disagree (`moderation_override_agree/disagree` is the live precision
signal). Authors appeal once, signed over `appeal:<queue id>`. The legacy
moderate route closes the matching queue item too.

**Calibration.** `calibrate()` applies a per-category piecewise-linear table
(identity by default); `evaluatePolicy()` reports per-category precision and
recall on a labelled set. Run it on the EN and ES slices separately — a change
that helps one while hurting the other does not ship.

## File rulings

| File | Ruling |
|---|---|
| `lib/signal-store.ts` | **Changed.** Hidden-target filter in `getSignals` / `getReplies`; `withModerationView` redacts held signals for display (editing paths keep the raw row). |
| `app/api/signals/[id]/moderate/route.ts` | **Changed.** A human takedown/restore here resolves the queue item too. |
| `lib/moderation-audit.ts` | **Changed.** Optional `ai` block on events; writes go through the locked `updateStore`. |
| `app/api/signals/route.ts` | **Changed.** Enqueue + background score after create. |
| `lib/forge/ai-pipeline.ts` | **Changed.** `generateJsonStep` surfaces `blockReason`; classification uses provider-default safety, not `BLOCK_NONE`. |
| `lib/signal-threads.ts` | **Ruled out.** Pure tree utilities over replies; replies are screened at creation (`replies` route) and filtered in `getReplies`. |
| `lib/signal-crdt.ts` | **Ruled out.** Pure Yjs document helpers. |
| `lib/signal-crdt-store.ts` | **Ruled out.** A draft is scratch state that never reaches a listing; the screen sits at the commit (`PATCH`/`PUT /api/signals/[id]`), where every promoted draft passes through `editSignal`. Screening every merge would score keystrokes. |
| `lib/faucet-deny-list.ts` | **Ruled out.** Identity sanctions need the governance quorum; an AI or single-moderator content decision must not feed it automatically. |
| `lib/sybil-resistance.ts` | **Read only.** A suspect band adds +0.2 spam evidence during async scoring (never on the hot path). |
| `lib/security-counters.ts` | **Changed.** `moderation_*` counters and `MODERATION_DECISIONS`. |
| `lib/server-data-paths.ts` | **Ruled out.** The queue is SQLite (leases and CAS need it); the audit sidecar was already registered. |
| `lib/phase-copy.ts` | **Changed.** `moderationQueue` section (EN/ES). |
| `lib/cost-attribution-ledger.ts` | **Changed.** `moderation.classify`, job id `moderation:<queue id>` (retries charged once). |
| `lib/notification-store.ts` | **Changed.** `moderation_hold`, `moderation_appeal_resolved`. |
| `lib/feature-flags.ts` | **Changed.** `phase-146`. |

New: `lib/moderation-triage.ts`, `app/api/moderation/queue/**`,
`components/moderation-hold-notice.tsx`; replies and edit routes and the signal
page are wired.

## Tests

`lib/__tests__/moderation-triage.test.ts` (15): EN/ES injection detection;
spam heuristics; threshold routing and visibility; injection floor; both fail
modes; provider block; calibration; malformed model replies rejected; eval
harness per language slice; idempotent enqueue; two concurrent scorers → one
model call; retry budget then fail policy; hold hides from lists and redacts
detail, flag off restores both; edit cannot launder a hold; edited target not
scored against stale text; claim/assignment, agree/disagree, version conflict,
appeal once and only by the author, re-resolution; replies filtered.

## Known limits

- The calibration table and thresholds are defaults, not tuned: there is no
  labelled EN/ES eval set in the repo yet. `evaluatePolicy` is the harness
  that set needs.
- The local lexicon covers spam and injection only. CSAM detection relies on
  the model and the provider's own block; media is never inspected locally,
  which is why media fails closed.
- Rolling back with phase-113 off unhides AI-held content that no human
  resolved. Clear the hold queue first.
