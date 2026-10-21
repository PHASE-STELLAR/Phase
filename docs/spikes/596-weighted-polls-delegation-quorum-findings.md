# Spike 596 — Token-Weighted Polls with Delegation and Quorum Findings (Issue #460)

Status: **partial**. This records what the code does today, two real defects found
in the existing poll path (one fixed), and a tested, un-wired tally primitive. It
does not deliver the end-to-end feature; see "Not done".

## What the issue claimed

Polls are one wallet, one vote (`options{id,text,voters[]}`, a `closes_at` check, no
weight, delegation or quorum). Adding token weight needs a snapshot taken at
creation, BigInt-safe sums, delegation with cycle detection, a quorum and a single
closer, across 16 files, gated behind a flag.

## What the code actually did at spike time

- `lib/signal-store.ts`: `SignalPoll = { options: { id, text, voters: string[] }[]; closes_at?: number }`, stored as the `poll_json` column. No weight, quorum or delegation. The claim holds.
- `app/api/signals/[id]/vote/route.ts` (38 lines) is gated by `phase-90`. Its schema requires `signature` to be a non-empty string, and then **never uses it**: it calls `voteOnPoll(id, option_id, wallet)` only.
- `voteOnPoll` did a read-modify-write: `getSignalRow`, edit `poll_json`, then `UPDATE signals SET poll_json = ? WHERE id = ?`, with **no `version` guard**. `upvoteSignal` right below it uses `WHERE id = ? AND version = ?` with up to 8 retries.
- Other signed writes verify the signature (`verifySignalSignature` in `lib/viewer-signature.ts`, used by `POST /api/signals`).

## The gaps that were real

1. **Poll votes are unauthenticated.** Anyone can cast or move any wallet's vote by sending a valid-looking public key and any non-empty `signature`. With one-wallet-one-vote this is a nuisance; once votes carry token weight it would let an attacker spend someone else's weight. **Not fixed here**: it needs a decision on the signed message (what a vote signs, replay window, whether to reuse `verifySignalSignature`). This must land before any weighted poll ships.
2. **Lost votes under concurrent writers.** With two instances sharing the SQLite file (the issue's own serverless scenario), both could read the same `poll_json` and the second write silently dropped the first vote. **Fixed**: see below.

## Delivered

1. **`voteOnPoll` is now version-guarded** (`lib/signal-store.ts`), same pattern as `upvoteSignal`: `UPDATE ... SET poll_json = ?, version = ? WHERE id = ? AND version = ?`, re-reading and recomputing on a lost race, up to `MAX_CAS_ATTEMPTS`, then `VersionConflictError`. Error messages for missing poll, unknown option and closed poll are unchanged. A vote now bumps `version` (as an upvote already did).
2. **`vote` added to the closed `SIGNAL_CONFLICT_SURFACES` label set** (`lib/signal-version-metrics.ts`), so `signal_version_conflicts` now splits a poll-vote conflict from the other surfaces. No wallet or poll id appears in labels.
3. **`lib/poll-governance.ts`**: a pure `computeWeightedTally(input)` with no I/O:
   - weights only from a snapshot (`ledger`, `takenAt`, stroop balances as strings), never live balances;
   - strategies `one_wallet` (1 per holder at the snapshot) and `token_balance`;
   - BigInt arithmetic throughout, so balances above 2^53 stay exact; every output number is a string;
   - delegation: one edge per wallet, chains up to a depth limit (default 5), cycles and self-delegation excluded, a direct vote always overrides a delegation so nothing is double counted;
   - an optional per-voter cap in bps of total snapshot weight (anti-whale), applied after delegation;
   - quorum: none, absolute, or bps of snapshot supply (rounded up);
   - outcome `passed | tied | no_quorum | no_votes`, with every excluded wallet and the reason;
   - deterministic: sorted processing, so input order never changes the result.
4. Tests: `lib/__tests__/poll-governance.test.ts` (13) and `lib/__tests__/poll-vote-cas.test.ts` (3). The CAS test injects a real second-connection write between the read and the write; it fails on the old `voteOnPoll` (the peer's vote is lost).

## Answers to the five spike questions

1. *Minimal closed loop / which files fail it independently:* not built. The tally primitive and the CAS fix are the two pieces that can be proven without a testnet.
2. *Replay and idempotency for votes:* a re-vote replaces the earlier one, so repeating a request is idempotent by construction. What was missing is authentication (gap 1) and the version guard (gap 2, fixed).
3. *Drift / failover fences:* not investigated.
4. *409/429/412 taxonomy:* today every error from `voteOnPoll` other than "Poll not found" is returned as 409, including "Poll is closed" and "Poll option not found". A weighted flow would want these separated (for example 422 for a bad option, 409 only for a version conflict).
5. *Migration and rollback:* the tally module is additive and unreferenced, so there is nothing to roll back; the CAS change needs no migration (the `version` column already exists).

## Decision and rollback

- No feature flag was added: nothing new is reachable. `computeWeightedTally` is not called by any route, and the CAS change corrects existing behaviour for `phase-90` polls. A flag row (`PROJECT_ARCHITECTURE.md` §10) belongs with the first consumer.
- Rollback: revert the commit. No data changes.

## Not done

Everything that needs a consumer, a contract or a testnet:
- authenticating poll votes (gap 1);
- the weight-snapshot sidecar and its Horizon fetch (bulkhead, stale-on-error, failure taxonomy);
- `poll_json` migration to a weighted ledger and a voter-weight table;
- poll creation validation for `quorum` / `closes_at` / `weight_strategy`, and tally exposure with `ETag`;
- the single closer, `proposal_closed` / `quorum_reached` notifications, i18n keys, the weighted results UI;
- composing deny-list veto signers with token-holder voting without double counting;
- contract changes in `contracts/phase-protocol/src/lib.rs`, and the testnet end-to-end proof.
