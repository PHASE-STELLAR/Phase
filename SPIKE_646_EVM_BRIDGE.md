# SPIKE_646 — PHASELQ → EVM bridge

**Status:** implemented behind `phase-218` (`PHASE_FLAG_EVM_BRIDGE`)
**Risk:** Critical · **Mainnet:** explicitly out of scope

## Findings

- Bridging crosses three boundaries at once: **signing** (user wallet vs
  server), **custody** (server-held EVM keys), and **finality** (Stellar vs EVM).
- Any shortcut in these boundaries risks **double-mint**.
- There is no existing message-finality or replay protection in the app.

## Delivered design

- One route only: `stellar-to-evm`, testnet-fenced by a static network snapshot
  (`assertTestnetFenced`).
- **Client-side signing:** `prepareLock` returns a `lockRequest` plus
  `signingBoundary: "client"`. No Stellar secret reaches the server; the
  prepared object contains no signature or secret field.
- **Server-side custody:** `BridgeCustody.mint/recover` is the *only* server
  authority, keyed by an opaque custody key ID from configuration. Operations
  are documented in `docs/FLAGGED_ADAPTERS.md`.
- **Idempotent relay:** every record is keyed by Stellar source tx hash.
  `claimMint` is an atomic claim on that key; a replay returns the original
  mint tx hash instead of minting again.
- **Finality:** `finalityDepth` is configurable via
  `PHASE_BRIDGE_FINALITY_DEPTH`; `advanceFinality` moves a lock to
  `confirming` only at that depth.
- **Orphan recovery:** `detectOrphan` → `recoverOrphan` re-checks finality,
  invokes the documented custody recovery procedure and re-queues the message.
- **Drift/fee fencing:** `maxDriftBps` and `maxFee` are enforced before a lock
  is prepared.

## Acceptance evidence

| Requirement | Test (`tests/bridge.test.ts`) |
| --- | --- |
| No double-mint under replay | replay + concurrent replay tests |
| Orphaned messages recoverable | orphan recovery test |
| Finality depth configurable | finality depth test |
| Testnet-only fenced | pubnet fence test |
| Flag off = no routes | `bridgeRoutes(false)` is empty + route 404 |
| Partial fill / replay | partial fill test |
| Drift/fee fences | client-signing boundary test |

## Rollback

Unset `PHASE_FLAG_EVM_BRIDGE`. Routes disappear; any already-locked funds remain
recoverable through the documented custody recovery procedure.
