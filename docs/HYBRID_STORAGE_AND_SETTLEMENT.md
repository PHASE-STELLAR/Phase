# Hybrid Storage and Settlement Boundaries

This note records the current reliability boundaries for PHASE metadata publishing, payment settlement, and collaborative content updates. It is an implementation guide for incremental work, not a claim that a single provider or in-memory process is durable enough for production guarantees.

## Current metadata path

`lib/ipfs-pinning.ts` provides the primary metadata publication path. It calculates a SHA-256 checksum, pins through the configured primary endpoint, and can verify the resulting CID through additional gateways. `lib/ipfs-fallback.ts` provides timeout-bounded reads with gateway rotation and `no-store` fetches.

The effective availability guarantee is therefore:

1. A successful pin produces an IPFS URI and checksum.
2. Gateway verification is evidence of retrievability at the time of the operation, not a permanent replication guarantee.
3. A failed verification must remain observable to callers and must not be represented as durable archival success.

## Storage roles

| Store | Appropriate responsibility | Must not be the sole source of truth for |
| --- | --- | --- |
| IPFS | Content-addressed metadata and immutable payloads | Payment settlement state or mutable collaboration state |
| Arweave/Bundlr | Long-term archival copy after an explicit archival job succeeds | Low-latency request-path reads |
| Soroban persistent storage | Compact commitments, references, state transitions, and replay guards | Large metadata blobs or frequent document edits |
| Database | Idempotency claims, mutable indexes, versions, and audit records | Replacing on-chain settlement finality |

## Settlement idempotency

Any flow that turns an off-chain payment reference into an on-chain entitlement must claim that reference atomically before minting or crediting value. The database claim needs a uniqueness constraint on the payment reference and a durable terminal status. Retrying a request may read the recorded result, but it must never create a second entitlement for the same reference.

A safe sequence is:

1. Validate the payment reference and start an idempotent claim transaction.
2. Persist a pending claim with a unique payment-reference key.
3. Submit the Soroban settlement operation.
4. Persist the transaction identifier and terminal outcome.
5. Return the stored outcome for every later retry.

If the chain submission outcome is uncertain, leave the claim pending for reconciliation rather than optimistically marking it successful.

## Mutable signal writes

Signal and narrative edits require a durable version or CRDT operation log before a multi-instance deployment can claim conflict-safe collaboration. A simple JSON read-modify-write loop is suitable only for local development. Incremental production work should first add versioned conditional writes and conflict responses, then add operation-based collaboration where live merging is required.

## Rollout gates

- Keep metadata redundancy behind an explicit feature flag with a documented rollback path.
- Emit structured metrics for pin latency, verification failures, idempotency conflicts, and reconciliation backlog.
- Add a recovery runbook before enabling archival or settlement automation in production.
- Treat archival completion, on-chain finality, and gateway availability as separate states in APIs and UI.