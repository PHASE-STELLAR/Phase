# Spike 147 — Personalized quest arcs (phase-147)

## What the issue claimed, checked against the code

| Claim | Verified |
|---|---|
| Exactly 5 hardcoded quests; `addNewQuest` is admin-manual | Yes |
| The evaluation context is the history signal, used only for OR evaluation | Yes — and it was private, so a generator would have had to reimplement every evaluator |
| Collection count scan capped at 256, owner scan window 2000 | Yes |
| Notifications have `quest_completed` only | Yes |
| Faucet claim state is per reward in `faucet-claims.json` | Yes, with an 8-min pending TTL |

## Design

**Nothing generated is executable.** Steps are drawn from a closed catalog
(`STEP_CATALOG`); each maps to a `QuestCondition` evaluated by the same
`quest-registry` evaluator static quests use (now exported as
`evaluateQuestCondition`, plus two new achievement-backed conditions,
`daily_streak` and `signal_posted`). The model writes only the arc title and
one flavour line per step; the reply must name every step and may contain no
numbers other than step targets.

**Plan.** Diagnose (which catalog conditions already hold, minted collections,
live streak, wallet age band from Horizon when phase-145 is on), then take the
unsatisfied steps easiest first, merging "create a collection" / "mint" into one
branching step, and always end on a multi-collection mint. Every other on-chain
kind is already paid by a static quest, so `collection_count` is the only paid
on-chain finale; target 3 is skipped (static `quest_three_collections` pays it).
A wallet past 5 collections gets no arc.

**Rewards.** Difficulty schedule (1–4 PHASELQ), farmable steps capped at 1,
+2 completion bonus on the finale, **0 for any condition an enabled static quest
pays** (no double reward), then scaled to `min(PHASE_QUEST_ARC_MAX_STROOPS,
0.5% of available distributor balance)`; 5 PHASELQ when the ledger has no row.
A failing distributor health check or a budget under 1 PHASELQ refuses the arc.

**Farm gate** (`reviewArc`, pure): 3–5 steps, all in catalog, ≥1 on-chain step,
non-decreasing difficulty, no static-paid step carrying reward, farmable reward
≤40% of the total. Identity (deny list, sybil suspect) and rate (one active
arc, ≤3 per 30 days) gates run first. Referral steps are not in the catalog —
the referral bonus is never reachable from an arc.

**State machine.** Arc: `active → completed | expired | superseded`. Step:
`locked → open → done → claiming → claimed`. Out-of-order progress marks a step
`done` (credit is earned) but claims stay ordered; zero-reward story steps
auto-claim. Expiry is lazy; earned steps stay claimable after it. Replacement
is refused while any step is `claiming` or `done` with a reward, so a replace
cannot discard earned money. Every transition is a version-guarded rewrite.

**Payout** goes through `/api/faucet` with `reward: arc:<uuid>:<step>` (parsed
only while the flag is on), inheriting trustline preflight, signer checks and
the pending/poll protocol. The faucet checks ownership, refreshes progress,
reserves against the distributor ledger (`reserveFunds`, `BEGIN IMMEDIATE`)
and moves the step to `claiming`; success commits the hold, failure before
submission releases it and reverts to `done`; after submission the step waits
out the 8-min pending TTL before it may restart (releasing the stale hold).

## File rulings

| File | Ruling |
|---|---|
| `lib/quest-registry.ts` | **Changed.** Exported `buildEvaluationContext`, `evaluateQuestCondition`; new `daily_streak` / `signal_posted` conditions; `staticQuestConditionKeys` for the double-reward guard. |
| `app/api/admin/quests/route.ts` | **Changed.** `GET` adds `arcCatalog` + limits; `DELETE ?arcId=` revokes an arc. |
| `lib/quest-streak.ts` | **Read only.** The `daily_streak` evaluator reads the *live* streak (`getStreakInfo`); arc rewards never pass through the streak multiplier (the faucet applies it to `daily` only). |
| `lib/referral-quest.ts` | **Ruled out.** Referral steps are excluded from the catalog by design; the referral bonus fires only on `genesis`. |
| `lib/achievement-store.ts` | **Read only.** `signal_posted` reads the existing `signal_pioneer` unlock. Arcs unlock no achievements, so the twelve fixed ids and their counters keep one meaning. |
| `lib/quest-snapshot.ts` | **Ruled out.** Arc state is in SQLite and survives cold starts; the snapshot's static `QuestId` union stays as is. |
| `app/api/faucet/route.ts` | **Changed.** Arc reward parsing, amount, claim status, ownership/progress check, reservation + two-phase claim, settle/abort on every exit. All branches are keyed on a reward id that only parses with the flag on. |
| `lib/faucet-deny-list.ts` | **Read only.** Identity gate. |
| `lib/sybil-resistance.ts` | **Read only.** Identity gate and age band (one Horizon read per generation). |
| `lib/notification-store.ts` | **Changed.** `quest_arc_generated`, `quest_arc_completed`. |
| `lib/phase-copy.ts` | **Changed.** `questArcs` section (EN/ES), including per-kind fallback lines. |
| `lib/distributor-ledger.ts` | **Read only.** `availableBalance` for sizing; `reserveFunds` / `commitRefill` / `releaseRefill` for claims. |
| `lib/distributor-health-store.ts` | **Read only.** `critical`/`error` status refuses new arcs. |
| `lib/distributor-refill.ts` | **Ruled out.** Sizing never triggers a refill; refills stay operator/health-driven. |
| `lib/narrative-world-store.ts` | **Ruled out.** `world_created` is evaluated through the registry's context, which already reads it. |
| `lib/phase-protocol.ts` | **Ruled out.** On-chain reads are reused through the registry evaluators unchanged. |

New: `lib/quest-arcs.ts`, `app/api/quests/arcs/route.ts`.

## Tests

`lib/__tests__/quest-arcs.test.ts` (13): ramped plan with branching first step
and paid on-chain finale; target 3 skipped, veterans get none; static-paid
steps zeroed, bonus on finale, treasury scaling; treasury refusals; farm gate
(farmable share, off-catalog, no on-chain, unramped); identity gate, one active
arc, replace, window cap; model narrative with amounts rejected (ES fallback)
and clean narrative kept; replace refused with an earned unclaimed step;
out-of-order credit, story auto-claim, ordered claims; begin once, abort
returns hold, stale restart releases the old hold, idempotent completion;
last claim completes the arc; lazy expiry keeps earned steps claimable;
reward id parsing.

## Known limits

- The faucet's post-submission window (a pending tx that lands after the 8-min
  TTL and a restarted claim) is the same double-payout window every faucet
  reward already has; arcs do not widen it, and do not fix it.
- Completion-rate lift vs. static quests is not measured yet; arcs carry no
  control arm. The pricing oracle's arm/outcome pattern is the model for it.
- `mintedCollections` is derived from the existing `collection_count`
  evaluator (capped scan of 256 collections).
