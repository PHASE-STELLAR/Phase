# SPIKE INDEX — 550–599

This batch is reserved for advanced integration spikes that cut across the PHASE runtime boundary: wallet signing, IPFS/OG generation, notification delivery, storage mutation, and migration safety.

## Active spike entries

- [advanced-integration-550-599.md](./advanced-integration-550-599.md) — branch-scoped spike pack for the second 50 batch.

## Scope rules

- Do not duplicate work already covered in the 500–549 batch.
- All spike entries must keep the default feature flag off until the integration is proven.
- Any route or write path that alters persisted state must include a rollback plan and migration safety notes.
- All user-facing copy must route through the EN/ES localization system before merge.

## Batch intent

The entries in this range focus on the highest-risk cross-cutting paths in the app:

- wallet signing and replay safety
- serverless idempotency and CAS validation
- cache invalidation and gateway failover
- notification/push delivery and subscription persistence
- OG/IPFS rendering and deterministic pinning
- migration and rollback safety as part of feature-flag gatekeeping

## Branch status

- Branch: `spike/advanced-integration-550-599`
- Status: proposed spike set, not yet implemented
- Rollback: feature flag off, data inert, docs revert per project architecture guidance
