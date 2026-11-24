# Advanced Integration Spike — 550–599

## Header

- Type: advanced integration spike (extremely difficult)
- Effort: 3–8 weeks
- Files touched: 18 (14+ required)
- Risk: high — cross-boundary, migration-bearing, flag-gated
- Status: proposed spike (not yet implemented)
- Rollback: feature-flag off + docs revert per PROJECT_ARCHITECTURE.md §10–11
- Batch: second 50 (550–599)

## Context and motivation

The issues in this batch are not small product tweaks. Each one appears narrow at first glance, but the correct fix crosses signing, storage, indexing, caching, i18n, observability, and migration boundaries. The common failure mode is a shortcut that makes a single route or render path look solved while silently creating divergent state across the rest of the system.

The key risks include:

- fetch/cache assumptions failing under stale or no-store conditions
- Freighter signing mismatches and expired queued XDR replay loops
- serverless timeout + retry behavior causing duplicate mutation or reprocessing
- IPFS, gateway, and OG generation drift between runtime and client paths
- notification and push delivery failing under bursty writes or stale subscriptions

## Current architecture (validated in repo)

- Signing boundary: client-side wallet signing via Freighter / Stellar Wallet Kit; server never holds keys for user-driven actions.
- API contracts: typed request/response payloads with deterministic error handling and no implicit success.
- Concurrency: SQLite/JSON structure uses version guards, parent checks, atomic update paths, and queue semantics.
- i18n: string output is channelled through the locale system, not hardcoded UI text.
- Error normalization: domain errors are normalized before surfacing in UI.
- Testnet-only assumptions must be documented and gated explicitly.

## Why this is difficult

This work spans multiple system layers at once:

- wallet signing, queued XDRs, and sequence refresh
- service worker, cache storage, and stale-on-error paths
- IPFS gateway fallback ordering and content integrity checks
- OG generation, deterministic asset rendering, and artifact pinning
- push notification subscription persistence and dedupe
- migration, rollback, and feature flag behavior under serverless retries

The repo has already shown the pattern that each “simple” integration ended up reopening a write-path gap or a read-path assumption. This spike is intentionally scoped to prevent that exact regression.

## Affected files

- app/layout.tsx
- components/app-providers.tsx
- next.config.mjs
- middleware.ts
- public/icon-sphere.png
- public/apple-icon.png
- public/icon.svg
- app/api/signals/route.ts
- app/api/market/[id]/offers/route.ts
- app/api/faucet/route.ts
- app/api/signals/[id]/vote/route.ts
- app/forge/page.tsx
- app/chamber/page.tsx
- components/wallet-provider.tsx
- components/freighter-connect.tsx
- hooks/use-toast-queue.ts
- hooks/useChamberSettlement.ts
- lib/toast-queue.ts
- lib/json-store.ts
- lib/phase-copy.ts

Secondary batch focus area:

- components/ipfs-display-img.tsx
- components/phase-artifact-visualizer.tsx
- components/phase-protected-preview.tsx
- components/crt-collection-preview.tsx
- lib/ipfs-fallback.ts
- lib/ipfs-upload.ts
- lib/cid-cache.ts
- lib/cid-verification.ts
- lib/explore-owners-cache.ts
- lib/wallet-nft-index-cache.ts
- app/api/ipfs/route.ts
- app/api/ipfs/[...cid]/route.ts
- lib/og-render-utils.ts
- app/explore/page.tsx
- app/collection/[id]/page.tsx
- next.config.mjs
- public/og-template.png
- public/fonts/NotoSans-Regular.ttf

Notification push trail:

- lib/push-notifications.ts
- app/api/notifications/push/route.ts
- app/api/notifications/route.ts
- lib/notification-store.ts
- components/notifications-modal.tsx
- components/floating-header.tsx
- components/signal-compose.tsx
- app/signals/page.tsx
- app/api/signals/route.ts
- app/api/signals/scheduled/route.ts
- lib/signal-store.ts
- lib/quest-registry.ts
- lib/market-store.ts
- hooks/use-toast-queue.ts
- lib/feature-flags.ts
- lib/server-data-paths.ts
- app/faucet/page.tsx
- lib/api-observability.ts

## Spike questions

1. What is the minimal closed loop that proves the integration end-to-end on testnet (fund → act → verify → index → display), and which files can fail it independently?
2. Where does replay/idempotency live for every write (contract settled flag vs used-settlements JSON vs viewer_jti vs faucetPending vs version CAS), and what happens on double-submit after serverless timeout?
3. What breaks under contract-ID drift, issuer rotation, or gateway failover, and which checks fence each failure mode?
4. What is the exact 409/429/412 taxonomy, including Retry-After, ETag, If-Match, parent_version, expected_vector_clock, and state_vector semantics?
5. What is the migration + rollback story for WASM upgrades, redeploys, stranded NFTs, ALTER TABLE changes, sidecar data, and flag-off behavior?

## Acceptance criteria

- End-to-end testnet proof exists for fund → act → verify → index → UI with tx hashes and contract IDs, without any hardcoded IDs.
- Concurrency proof shows overlapping writers return 409s with version ordering instead of silent overwrites.
- Abuse proof blocks self-deal, replay, expired input, and tampered payload attempts.
- Resilience proof covers RPC, gateway, Horizon, stale-on-error, bulkhead, and circuit-breaker failover.
- i18n and error normalization remain intact; EN/ES copy flows through the locale system.
- All new flags are off by default, with explicit rollback instructions.
- No regression when all new feature flags are off; existing test and static validation remain green.

## Risks and non-goals

### Risks

- Scope creep into adjacent tracks.
- Testnet-only assumptions leaking into mainnet behavior.
- Incomplete migration safety for persisted state.

### Non-goals

- Production facilitator keys.
- Mainnet deployment and shared database cutover.
- Long-lived multi-team work without a single DRI.

## Estimate

- Research + spike answers: 1–2 weeks
- Implementation: 2–4 weeks
- Hardening: 1–2 weeks
- Total: 4–8 weeks for one senior engineer with review

## Implementation note

This file exists to capture all of the above as the branch-scoped working plan for the 550–599 batch. It is intentionally written as a proposed spike artifact and does not claim the implementation is complete.
