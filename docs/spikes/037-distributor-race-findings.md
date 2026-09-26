# Spike 037 — Distributor Refill Race Findings (Issue #231)

## What the issue claimed

`lib/distributor-refill.ts:12-38` `refill(distributor, amount)` read
`balance = healthStore.get(distributor).balance` from a 60-second in-memory
`Map` in `lib/distributor-health-store.ts:18-34`, then called
`horizon.payment(distributor, amount)` with no `SELECT FOR UPDATE`.
`grep -rn "FOR UPDATE" lib/distributor* → 0`.

## What the code actually did at spike time

- `distributor-refill.ts` did **not** read any cached balance. It took an
  explicit `amountStroops` argument, loaded the *issuer* account, and submitted
  a **Soroban** `contract.call("mint", …)` through `rpc.Server` — not a
  `horizon.payment`.
- `distributor-health-store.ts` was a **file-backed** health record store
  (`writeFile`/`readFile` under `serverDataJsonPath("distributorHealth")`)
  holding `status`/`message`/`history` for the dashboard. It has no `Map`, no
  60-second TTL, and no balance field.
- The threshold check that triggers a refill lives in
  `app/api/cron/faucet-health/route.ts`: it compares
  `distBalance.phaseLiqStroops` against `DISTRIBUTOR_PHASELQ_MIN_STROOPS` and,
  if low, calls `executeDistributorRefill`.
- Storage is `node:sqlite` (`lib/sqlite-db.ts`); there is no Postgres, so
  `SELECT FOR UPDATE` and `pg` `distributor_ledger` were not available as
  specified.
- There **was** no distributed lock on the refill path, and no reservation
  between "decided to refill" and "submitted". The issue's central claim —
  nothing prevents two concurrent refills from both submitting — is **true**.

## The gap that was real

The check and the submit were not atomic, and nothing recorded an in-flight
refill. Two overlapping cron invocations (or a cron plus a manual topup) could
both observe a low balance and both submit, minting more than the threshold
check authorised, and the distributor's real balance was only ever learned
after the fact.

## Storage decision

The issue proposed `pg distributor_ledger` with `SELECT FOR UPDATE SKIP LOCKED`
and a `version` CAS. This repo has no Postgres; it uses `node:sqlite`, where
`BEGIN IMMEDIATE` is the correct primitive — it takes the write lock *before*
the first read, so two writers cannot interleave between the balance check and
the update. A deferred `BEGIN` would allow exactly the interleaving the issue
is about.

The `version` column is kept (bumped on every ledger mutation) so callers can
detect a concurrent update even though the row lock is what provides the
atomicity.

## Ledger spec (delivered)

```
distributor_ledger(distributor PK, balance_stroops, reserve_stroops,
                   fee_reserve_stroops, version, updated_at)
distributor_reservations(id PK, distributor, amount_stroops, purpose,
                         created_at, state, horizon_tx_hash)

availableBalance = balance - reserve - feeReserve - pendingReserved
  reserveFunds()  BEGIN IMMEDIATE; check available >= amount; insert 'held'; COMMIT
  commitRefill()  held -> committed (only on ledger success)
  releaseRefill() held -> released (on submission failure)
```

A failed refill **must** release its hold, or the funds stay reserved and the
distributor reads as underfunded even after being funded. A refill still
pending after the 10-second poll window **keeps** its hold: releasing it would
let a concurrent refill authorise against funds the pending tx is about to
consume.

## Fee reserve separated

`availableBalance = balance - reserve - pending` as the issue specifies omits
transaction fees. Fees come out of native XLM; draining that below the
transaction fee strands every subsequent settlement, turning a partial
overspend into a total outage. `fee_reserve_stroops` is therefore tracked
separately from the issuer/trustline reserve.

## Measured cost

`reserveFunds` is one `BEGIN IMMEDIATE` + one `SELECT` + one `INSERT` + one
`UPDATE` on an indexed primary key — sub-millisecond, and it *serialises*
concurrent refills rather than adding parallel work.

## Decision

Guard the refill with a transactional reservation, commit on ledger success,
release on failure, and keep the hold while pending. Counters
`distributor_refill_race`, `distributor_op_underfunded`,
`distributor_available_balance_stale`, `distributor_refill_succeeded` record
before/after.
