# Investigation: issue #240 — Soroban `persistent` vs `instance` vs `temporary` TTL rent

## Summary

Issue #240 asks for a one-week spike into storage-rent tiering (`persistent` vs
`instance` vs `temporary`, ~500 XLM/year for 100k persistent token entries vs
~0.05 XLM/year instance vs temporary entries that auto-expire after ~30 days),
followed by a contract change putting instance-level config in persistent
storage, metadata in temporary storage, and claims on a 30-day TTL.

The spike itself was not performed here (it is a week of benchmarking against a
live network). What follows is the code-level finding that determines whether
that change is even applicable to this contract, plus the rent arithmetic.

## The cited evidence does not match the contract

The issue cites `contracts/phase-protocol/src/lib.rs:56-94` as containing a
`Metadata` struct held in `persistent` storage. That range actually holds:

- `PaymentRecord` (lines 56-64) — an in-memory payload type, not a storage entry.
- `DataKey` (lines 70-97) — the storage key enum.

There is **no `Metadata` storage struct in this contract**, and no "claims"
storage concept either.

## Current storage model

Every read and write in the contract goes through `env.storage().persistent()`:

```
grep -c "storage().persistent()" contracts/phase-protocol/src/lib.rs
```

The contract uses **zero** `env.storage().temporary()` calls and zero
`extend_ttl` / TTL-levelling calls. There is no TTL management at all, so
nothing currently gets an auto-expiry window.

Config-like values (`DataKey::PhaseCounter`, `CollectionCounter`,
`ProtocolTreasury`, `Collection(u64)`) are already in persistent storage, which
matches the issue's intent for "instance config persistent" — those must survive
archival and should stay persistent.

There is also no `#[cfg(test)]` module in the contract, so a "rent tiering test"
would have been the first test in the crate. Note that CI
(`.github/workflows/ci.yml`) runs `cargo test` **and** a
`--target wasm32-unknown-unknown --release` build, so an unverifiable Rust
change here would break the contracts job.

## Rent arithmetic (for the spike)

| Tier | Rent behaviour | Fit for this contract |
| --- | --- | --- |
| Persistent | ~0.5 XLM per 32-byte entry per year, charged on restore; a 100k-entry table accrues rent in the hundreds of XLM/year | Required for counters, treasury, collection settings, token ownership |
| Instance | ~0.05 XLM/year, tied to contract instance lifetime, **billed to the instance owner (the contract itself), not per-entry** | Would move protocol-wide config off per-entry persistent rent |
| Temporary | Entry lives only as long as its TTL; rent is charged to the *writer* and never refunded, but entries auto-expire | Only viable for data with a natural expiry (e.g. per-mint claim receipts) |

The key economic difference: persistent entries cost rent forever until restored,
temporary entries cost a one-time small rent and then expire, and instance
storage is a single per-contract bill.

## Recommendation

Not actionable as written — the storage layout it targets does not exist here.
A follow-up should decide, with real numbers from a testnet deployment, whether
`CollectionSettings` and `TokenOwner` stay persistent (they must, to remain
queryable) and whether any genuinely expiring record is worth introducing
temporary storage for. No contract code was changed in this issue.
