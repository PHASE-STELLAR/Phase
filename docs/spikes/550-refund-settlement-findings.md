# Spike 550 — Refundable Settlement for Irreversible Forge Payments

Status: **proposed spike / research complete, not implemented**.
Batch: 550–599. Files in scope: 16. Effort: 4–8 weeks for one DRI.

## Verdict first

The brief is directionally right but understates the blocker. There is **no
refund path anywhere in the repository**, and — more importantly — for creator
collections (`collection_id > 0`) a refund is **structurally unfundable**:
`settle` forwards 95% to the creator and 5% to the treasury in the same
transaction, so the contract holds zero of that payment.

Two preconditions must land before any refund endpoint is written:

1. **`initialize` is re-callable.** `contracts/phase-protocol/src/lib.rs:430-460`
   has no initialized guard. An attacker can call `initialize` with themselves as
   admin/token/treasury and then call `upgrade` (`:464-472`) to replace the WASM
   while preserving storage. Every admin-gated refund is unsafe until this is
   fixed.
2. **Custody must change for new collections.** Either hold the 95/5 split until
   a dispute window closes, or refund from a pre-funded treasury reserve with
   explicit creator/treasury consent. "Debit creator + treasury proportionally"
   is not implementable against already-transferred funds: the contract has no
   allowance/approval path to pull funds back, no admin transfer/burn entrypoint,
   and no contract-level clawback. (Classic-asset clawback exists only when the
   issuer enabled it; this design does not assume that flag.)

The honest recommendation is: **do not ship a refund button on the current
contract**. Ship the contract custody change first, behind `phase-550`, with the
API and UI following.

## What the brief claimed vs. what the code actually does

| Claim | Verified reality |
|---|---|
| "95/5 disbursed same tx, NFT minted" | True for `collection_id > 0`; see `lib.rs:738-760` (split) and `:775-827` (mint/energy). For `collection_id == 0` the full amount stays in the contract and no split runs. |
| "No refund entry, no `RefundedAmount`, no `AlreadyRefunded`/`RefundExceedsSettled`" | True. `PaymentRecord` has only `invoice_id`, `amount`, `token`, `payer`, `settled`, `timestamp` (`lib.rs:56-64`). `PhaseError` has no refund code (`:10-28`). |
| "No NFT burn-or-return policy" | True. There is no `burn` and no admin clawback. `transfer_phase_nft` requires the current owner's auth (`lib.rs:1088-1090`). |
| "Verifier treats refunded tx hash as valid payment" | True today, but for a different reason than stated: the verifier never reads `PaymentRecord`, never checks the invoice, and never asks whether a refund exists. It checks transaction success, source, contract, function `settle`, args 0–2 (payer, token, amount) — `lib/forge/payment-verifier.ts:107-140`. A refunded settle still passes. |
| "Escrow settlement 2-of-3 + `DISPUTE_WINDOW` is the closest primitive to reuse" | It is a **type/validation module only** (`lib/escrow-settlement.ts`), with no store, route, or execution function. Its only importer is `lib/env-validation.ts:693` (an audit probe). It is a vocabulary to borrow, not a mechanism to wire. |
| "Marketplace offer accept/refund path exists as a seam" | Offers are SQLite bookkeeping; accepting flips status and inserts an optional royalty row (`app/api/market/[id]/offers/[offer_id]/route.ts:47-67`). No funds move, no NFT moves, no escrow exists. `OfferStatus` is `pending | accepted | rejected | expired` (`lib/market-store.ts:13`). |
| "Custodian-release in-flight guard is a double-execution template" | The route has a process-local `Set` guard, not a durable lock. On serverless it resets on every cold start / instance. It is a shape to copy, not a correctness proof. Its Bearer check is presence-only (`app/api/phase-nft/custodian-release/route.ts:106-113`). |
| "Refunds credit user debiting creator+treasury proportionally (reverse reserve/commit/release)" | Not possible on already-split funds. The distributor ledger's `reserve`/`commit`/`release` (`lib/distributor-ledger.ts:169-278`) is a refill reservation, not a payment ledger; `commitRefill` does not decrement `balance_stroops`, and `setLedgerBalance` has no production caller. Contributor shares are attribution only (`lib/contributor-ledger.ts`: `shareBps`, no balances/payouts). |
| "Contributor sub-splits complicate clawback ordering" | True, but there is nothing to claw back: contributor entries never paid out. A refund design must not pretend this ledger is financial. |
| "Used-settlements store prevents replay" | It is a JSON `txHash -> ISO timestamp` map (`lib/settlement-store.ts:60-72`), marked **before** prompt validation and generation (`app/api/forge-agent/route.ts:98-119`). It has no payer/amount/invoice/collection/refund fields, no TTL, no unmark, and it bypasses `serverDataJsonPath` (`lib/settlement-store.ts:4`). The official x402 path can produce an empty receipt (`payment-verifier.ts:175-181`), skipping the store entirely. |

## The settlement lifecycle as it actually runs

```
browser
  POST /api/forge-agent {prompt}
    -> 402 challenge
  build settle(payer, token, REQUIRED_AMOUNT, invoiceId, 0)
  Freighter signs -> submit -> poll SUCCESS
  POST /api/forge-agent {prompt, settlementTxHash}
    -> verifyPhaseSettleTxOnChain (args 0..2 only)
    -> isSettlementUsed / markSettlementUsedIfUnused(txHash)
    -> runForgePipeline -> mintNftStep (stub: returns {txHash:null})
```

On-chain, the same `settle` call:

```
check token == AuthorizedToken                 lib.rs:703-711
reject if PaymentRecord.settled                lib.rs:713-719
user.require_auth()                            lib.rs:721
amount >= collection price / global price      lib.rs:723-726
transfer user -> contract                      lib.rs:736
if collection_id > 0: 95% -> creator, 5% -> treasury   lib.rs:738-760
write PaymentRecord{settled:true}              lib.rs:762-773
mint NFT on first phase, else add energy       lib.rs:775-827
emit x402_settled(invoice_id, amount)          lib.rs:829-832
```

There is no transaction hash in `PaymentRecord`, no `token_id`, and no
`collection_id`. The event carries only `(invoice_id, amount)`, so an indexer
cannot map a payment to the NFT it minted.

## Q1 — Minimal closed loop that proves the integration

The loop must prove both money and asset movement, because a refund that leaves
the NFT with the buyer is a free-mint exploit.

```
fund (Friendbot) -> trustline -> settle(collection) -> mint
  -> refund request -> approval -> NFT return/burn -> refund transfer
  -> index refund event -> UI shows REFUNDED and hides the artifact
```

Minimum viable version (phase 1, only safe on new collections):

1. **Contract**: `settle` holds 100% in the contract for
   `SETTLEMENT_HOLD_SECONDS` (proposed 7 days) and records a claimable balance
   for creator/treasury; `claim_settlement(invoice_id)` pays them after the hold.
2. **Contract**: `refund(invoice_id)` requires `payer.require_auth()` **and**
   `admin.require_auth()` (two-party), checks the hold has not been claimed,
   transfers the NFT from payer to the issuer/custodian (or burns it if a burn
   entrypoint is added), then transfers the held amount back to the payer, then
   writes `RefundRecord`.
3. **Server**: `POST /api/refunds` (request) and `POST /api/refunds/[id]/execute`
   (approve+submit), both `phase-550` gated, both with an idempotency key.
4. **Verifier**: `verifyPhaseSettleTxOnChain` must read the invoice's refund
   state and return `false` when `refunded` is true. It must also parse
   `invoice_id` (arg 3) and the collection id (arg 4).
5. **Indexer/UI**: consume `x402_refunded` (new event), flip the artifact to
   `REFUNDED`, exclude it from explore aggregates, and make the forge retry
   fail with a normalized error.

### Which file can fail the loop independently

| Stage | File | Independent failure |
|---|---|---|
| Hold/split | `contracts/phase-protocol/src/lib.rs` | Immediate split leaves nothing to refund; no hold/claim entrypoint. |
| Mint linkage | `contracts/phase-protocol/src/lib.rs` | `PaymentRecord` has no `token_id`/`collection_id`; refund cannot identify the NFT. |
| Verification | `lib/forge/payment-verifier.ts` | Accepts a refunded tx; ignores invoice/collection; `>= REQUIRED_AMOUNT` instead of exact price. |
| Off-chain replay | `lib/settlement-store.ts` | txHash-only key, marked before work, ephemeral path, no refund state. |
| Execution auth | `app/api/phase-nft/custodian-release/route.ts` | Presence-only Bearer, process-local guard: duplicate execution across instances. |
| Refund API | (new route) | A money-out hole if it trusts a body wallet or a client-supplied amount. |
| Indexing | `lib/phase-protocol.ts` | Strict event verifier expects topic `settle` while the contract emits `x402_settled`; tuple parser swaps invoice/amount (`:1412-1426`, `:1465`). |
| Marketplace | `lib/market-store.ts`, offers routes | An accepted offer on a refunded listing would still pay the seller. |
| Display | `app/api/explore/route.ts`, `app/collection/[id]/page.tsx` | Refunded artifacts remain in public listings/metadata. |

## Q2 — Where replay/idempotency lives for every write

| Write | Idempotency key | Store / mechanism | Double-submit after timeout |
|---|---|---|---|
| `settle` | `invoice_id` | On-chain `DataKey::X402Payment(invoice_id)` + `settled` (`lib.rs:713-719`) | Second tx reverts `SettlementFailed`; no transfer. **But invoice ids are random 0–999999 (`app/forge/page.tsx:591`), so collisions across users are possible.** |
| Forge generation | `txHash` | `used-settlements.json` (`lib/settlement-store.ts:60-72`) | Second request gets 409; the first may already have consumed the hash before failing. No release. |
| x402 verify | `invoice` (not txHash) | Read-only check (`app/api/x402/verify/route.ts:46-55`) | Repeated verify returns 200; it never marks. Different key from forge-agent. |
| Viewer grant | `jti` | SQLite `viewer_jti` PK + `INSERT ... ON CONFLICT DO NOTHING` (`lib/viewer-authorization.ts:70-116`) | Second presentation rejected atomically. This is the model refunds should copy. |
| Signal edit | `If-Match` version | SQLite `UPDATE ... WHERE id=? AND version=?` (`lib/signal-store.ts:950-981`) | 409 with `current_version`. |
| Refund request | `Idempotency-Key` + `UNIQUE(invoice_id)` | New SQLite `refunds` table | Same key returns the existing record (200); different key for a non-terminal refund returns 409; terminal refund returns 200 with `state`/`tx_hash`. |
| Refund execute | `refund_id` + DB `state=executing` + on-chain `RefundRecord` | SQLite CAS + contract flag | Re-query `get_refund_status(invoice_id)`. If executed, mark done; if not found and the previous attempt is older than 2× `maxDuration`, retry. Contract rejects `AlreadyRefunded`, so a duplicate submit is safe. |

### Proposed SQL

```sql
CREATE TABLE IF NOT EXISTS refunds (
  refund_id        TEXT PRIMARY KEY,
  invoice_id       INTEGER NOT NULL,
  payer            TEXT NOT NULL,
  token            TEXT NOT NULL,
  amount_stroops   TEXT NOT NULL,           -- i128 as decimal string
  collection_id    INTEGER NOT NULL,
  nft_token_id     TEXT,
  nft_disposition  TEXT NOT NULL DEFAULT 'pending'
                     CHECK (nft_disposition IN ('pending','returned','burned','retained_denied')),
  state            TEXT NOT NULL DEFAULT 'requested'
                     CHECK (state IN ('requested','approved','executing','executed','failed','rejected')),
  version          INTEGER NOT NULL DEFAULT 0,
  idempotency_key  TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 0,
  tx_hash          TEXT,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(invoice_id),
  UNIQUE(idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_refunds_state ON refunds(state, updated_at);
```

State transitions use `BEGIN IMMEDIATE` and
`UPDATE refunds SET state=?, version=version+1 WHERE refund_id=? AND version=?`;
`changes !== 1` means a concurrent writer won and the caller must re-read.

### Contract storage shape (do not mutate `PaymentRecord`)

Adding a field to an existing `#[contracttype]` struct changes its XDR schema and
can make already-persisted values fail to decode. Add a **new** key and struct
instead, and append enum variants rather than reordering them:

```rust
#[contracttype]
pub struct RefundRecord {
    pub invoice_id: u32,
    pub payer: Address,
    pub token: Address,
    pub amount: i128,
    pub collection_id: u64,
    pub nft_token_id: Option<u64>,
    pub nft_disposition: NftDisposition,
    pub state: RefundState,
    pub requested_at: u64,
    pub executed_at: u64,
}

#[contracttype]
pub enum NftDisposition { Pending, Returned, Burned, RetainedDenied }

#[contracttype]
pub enum RefundState { Requested, Approved, Executed }

// append only
pub enum DataKey {
    // ... existing variants ...
    Refund(u32),          // invoice_id -> RefundRecord
    SettlementV2(u32),    // invoice_id -> SettlementRecordV2 (token_id, collection_id, tx hash)
}
```

The important part is ordering:

```rust
pub fn refund(env: Env, payer: Address, invoice_id: u32) -> Result<bool, PhaseError> {
    admin_require(&env)?;                 // stored Admin
    payer.require_auth();                 // payer must consent
    let payment: PaymentRecord = ...;      // settled == true
    if has_refund(&env, invoice_id) { return Err(PhaseError::AlreadyRefunded); }

    let settlement: SettlementRecordV2 = ...; // token_id, collection_id
    if nft_owner(&env, settlement.token_id) != payer {
        return Err(PhaseError::NftNotReturnable); // transferred to a third party
    }
    if settlement_claimed(&env, invoice_id) {
        return Err(PhaseError::RefundExceedsSettled); // creator/treasury already paid
    }

    // checks-effects-interactions: write state first, then move value.
    write_refund(&env, RefundRecord { state: Executed, nft_disposition: Returned, ... });
    transfer_nft_from_payer_to_issuer(&env, payer, settlement.token_id);
    token::Client::new(&env, &payment.token)
        .transfer(&env.current_contract_address(), &payer, &payment.amount);

    env.events().publish(
        (Symbol::new(&env, "x402_refunded"), payer),
        (invoice_id, payment.amount, settlement.token_id),
    );
    Ok(true)
}
```

Do **not** write a refund that calls an external token before recording state.
Soroban reverts the whole invocation on error, but the indexer and the off-chain
reconciler still need a deterministic event/state to replay.

## Q3 — Contract-ID drift, issuer rotation, gateway failover

| Failure | Fence | What it must prove |
|---|---|---|
| Contract ID drift | `get_config()` via `lib/phase-protocol.ts:623-643`; `normalizeContractC` in `payment-verifier.ts` | The token returned by the contract equals the token in the transaction args. A refund against an old contract ID fails closed, not "best effort". |
| Token/issuer rotation | `resolvePhaserLiqClassicAsset()` (`lib/stellar.ts:93`) + `get_config` token | The refunded token is the same SAC the settlement used. Persist `token` in `RefundRecord`; never infer it at refund time. |
| Metadata/CID drift | `token_uri?c=` / `lib/cid-verification.ts`; `lib/phase-nft-metadata-build.ts` `prioritizeGatewaysByHealth` (`:59-80`) | A refunded token's metadata is either removed or marked `refunded`; a stale gateway copy cannot keep displaying a live artifact. |
| RPC failover | `app/api/soroban-rpc/route.ts` circuit breaker + `MAX_IN_FLIGHT=12` | The refund reconciler treats RPC failure as `unknown`, never as `not executed`, and retries with the same idempotency key. |
| Treasury/creator address rotation | New `get_refund_config()` (or `get_config` extension) | Approval signers and payout addresses are snapshotted on the refund record; a mid-flight rotation cannot redirect funds. |
| Admin key compromise | 2-of-N approval (proposed), `PHASE_GOVERNANCE_SIGNERS` (currently signature is **optional and unverified** in `lib/faucet-deny-list.ts:65-69,192-225`) | Refund execution requires distinct approver signatures; do not reuse the faucet veto path as-is. |

## Q4 — Status-code taxonomy

| Code | When | Body / headers |
|---|---|---|
| `400 REFUND_INVALID` | Malformed invoice, NFT id, or amount; address format. | `{ error, code }` |
| `401 REFUND_UNAUTHORIZED` | Missing/invalid payer signature or approval signature. | `WWW-Authenticate: Signature` |
| `403 REFUND_FORBIDDEN` | Payer mismatch, signer not in governance set, collection not refundable. | `{ code: "REFUND_FORBIDDEN", reason }` |
| `404 REFUND_NOT_FOUND` | Unknown refund id (GET). | |
| `409 REFUND_ALREADY_EXISTS` | A refund for this invoice exists with a different idempotency key. | `{ refund_id, state, current_version }` |
| `409 REFUND_STATE_CONFLICT` | Invalid transition (e.g. execute a rejected refund). | `{ state, allowed }` |
| `412 REFUND_PRECONDITION_FAILED` | Hold not expired, settlement not final, NFT transferred, creator/treasury already claimed, or `If-Match` version stale. | `{ code, required, current }` + `ETag` |
| `428 REFUND_VERSION_REQUIRED` | Execute/approve without `If-Match`. | `ETag: "<version>"` |
| `429 REFUND_RATE_LIMITED` | Per-wallet/IP refund request cap. | `Retry-After: <seconds>`, `X-RateLimit-*` |
| `503 REFUND_RPC_UNAVAILABLE` | Soroban/RPC unavailable or circuit open. | `Retry-After` |
| `504 REFUND_TIMEOUT` | Submission accepted but confirmation not observed. | `Retry-After`; state remains `executing` |

The UI must never auto-retry a refund POST without the same `Idempotency-Key`.
On `412`, show the current state and a "reload" action rather than replaying the
user's input. On `409`, fetch the existing refund and render it. On `429/503`,
disable the button and display the `Retry-After` countdown.

## Q5 — Migration and rollback

### Contract

| Option | Migration | Rollback | Verdict |
|---|---|---|---|
| In-place WASM upgrade | `upgrade(new_wasm_hash)` preserves storage; append `DataKey` variants only. | Upgrade back to the previous WASM; new keys are ignored. | Preferred once `initialize` is guarded. |
| Redeploy new instance | New contract ID; old NFTs/payments stranded on the old instance. | Re-point env back. | Only for a clean testnet reset, never for mainnet. |

Do not change the discriminant order of `DataKey` or `PhaseError`. Append.

### Off-chain

- Additive SQLite tables (`refunds`, optional `refund_events`) via
  `CREATE TABLE IF NOT EXISTS`; no destructive `ALTER`.
- `used-settlements.json` is left in place as historical data; the new refund
  ledger is authoritative for refund state. Do not delete the sidecar while a
  rollback is possible.
- On flag-off, the refund route returns 404, the verifier keeps its legacy
  behavior, and existing refund rows are inert. The contract hold (if already
  deployed) remains on-chain — flag-off does **not** un-hold funds. That is why
  the custody change and the flag must ship together.

### NFT policy

| Option | Buyer keeps NFT? | Exploit | Recommendation |
|---|---|---|---|
| Burn on refund | No | Requires a new admin burn; must handle already-transferred tokens. | Only with payer auth + owner check; never unilateral. |
| Return to issuer/custodian | No | Requires payer auth; fails if the NFT was transferred. | **Recommended** for phase 1. |
| Leave with buyer | Yes | Buy → refund → keep NFT = free mint. | Only as an explicitly loss-bearing treasury policy, with deny-list and no repeat refunds. |

## File-by-file invariant map

| File | Change or ruling-out | Invariant it owns |
|---|---|---|
| `contracts/phase-protocol/src/lib.rs` | Add `initialize` guard, `RefundRecord`/`DataKey::Refund`, `refund`, `get_refund_status`, `x402_refunded`, refund errors, hold/claim if adopted. | The only atomic money+asset transition. |
| `lib/forge/payment-verifier.ts` | Parse invoice/collection; reject refunded; exact amount. | A paid hash is not a valid payment after refund. |
| `lib/escrow-settlement.ts` | Promote to a real hold store **or** rule out as dead vocabulary. | 2-of-3/DISPUTE_WINDOW semantics. |
| `app/api/x402/verify/route.ts` | Refund-aware; same key as forge-agent. | Verify is read-only but must not bless a refunded invoice. |
| `lib/settlement-store.ts` | Move to `serverDataJsonPath`; add status/payer/amount; or replace with SQLite ledger. | Replay key scope and durability. |
| `lib/phase-protocol.ts` | Add `buildRefundTransaction`, `readPhaseRefundStatus`; fix event topic/parser. | Client/chain contract. |
| `app/api/market/[id]/offers/route.ts` | Reject offers on refunded/held listings. | No new money against a refunded artifact. |
| `app/api/market/[id]/offers/[offer_id]/route.ts` | `refunded` terminal state; no payout. | Marketplace cannot outrun the refund. |
| `lib/market-store.ts` | Add `refunded` to `OfferStatus`/`ListingStatus` (append; migrate reads). | Terminal-state vocabulary. |
| `lib/distributor-ledger.ts` | Add `refundHold`/`releaseRefund`; fix `commitRefill` balance accounting before reuse. | Reserve/commit/release is not a refund ledger today. |
| `lib/contributor-ledger.ts` | Explicitly rule out clawback; attribution only. | Do not invent balances that do not exist. |
| `lib/x402-dead-letter.ts` | Quarantine failed refund executions; operator replay. | Poison refund attempts do not loop. |
| `lib/security-counters.ts` | Closed labels: `refund_requested`, `refund_executed`, `refund_rejected`, `refund_replay_blocked`, `refund_rpc_unknown`. | Observability without PII. |
| `lib/faucet-deny-list.ts` | Refund-farming deny-list; **verify** the governance signature. | Abuse response; currently signature is optional. |
| `app/api/phase-nft/custodian-release/route.ts` | Replace process-local Set with durable idempotency; verify Bearer signature. | Double-execution guard template. |
| `docs/AGENT_PAYMENTS.md` | Document refund policy, corrected 402/403/409 errors, and the fact that `settle` mints. | Agent-facing contract. |

## Proposed flag

`phase-550` — `NEXT_PUBLIC_FEATURE_PHASE_550` / `FEATURE_PHASE_550`.

Rollback: unset/set `0`, restart. Refund routes return 404; verifier ignores
refund state; existing `refunds` rows and on-chain `RefundRecord`s remain inert.
**Do not roll back the contract hold independently of the flag**; they must be
deployed as one unit.

## Tests and acceptance evidence

Failing-first tests:

- Contract: settle → refund happy path; double refund → `AlreadyRefunded`;
  refund after NFT transfer → `NftNotReturnable`; refund after creator claim →
  `RefundExceedsSettled`; `initialize` twice → `AlreadyInitialized`; `upgrade`
  by non-admin → unauthorized.
- Off-chain: concurrent refund requests with the same/different idempotency key;
  stale `If-Match` → 412; timeout → state `executing` then reconcile; verifier
  rejects a refunded settle; marketplace cannot accept an offer on a refunded
  listing.
- Abuse: self-refund by non-payer; forged governance signature; refund-farming
  wallet denied; replay of the same execution tx.
- Testnet proof: Friendbot → trustline → settle (record tx hash + contract ID)
  → refund (tx hash) → index event → UI shows `REFUNDED`. No hardcoded IDs; env
  and docs synchronized.

## Risks / non-goals / estimate

- **Risk:** changing custody breaks instant-payout UX. Make the hold a
  collection-level setting and show "pending" honestly.
- **Risk:** a refund that does not return the NFT is a free mint. Do not ship it.
- **Risk:** `initialize` re-entry turns any admin-gated refund into an attack
  path. Fix it first.
- **Non-goal:** mainnet, production facilitator keys, shared-DB cutover.
- **Estimate:** 1–2 w research (this doc + failing tests), 2–4 w contract/API/UI,
  1–2 w hardening. Longer if contract custody is contested by product.
