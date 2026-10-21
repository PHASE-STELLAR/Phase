# Spike 636: Legal-Hold Preservation with Deny-Delete During Investigation

**Issue**: #498
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-169` (`NEXT_PUBLIC_FEATURE_PHASE_169` / `FEATURE_PHASE_169`)
**Key Surfaces**: `lib/legal-hold.ts`, `app/api/legal-hold/route.ts`, `app/api/legal-hold/[id]/release/route.ts`

## Context & Motivation

Phase previously lacked a legal preservation / WORM (Write-Once-Read-Many) engine. Standard operational flows were hold-ignorant: signal takedowns, unmoderated restores, marketplace listing cancellations, profile overwrites, and notification state changes proceeded without checking whether an active legal investigation was in progress. While moderation audit logs were append-only in practice, they lacked tamper-evident immutability flags and retention clocks. Furthermore, in-memory or single-writer sidecars meant that a hold had to propagate and be enforced across instances and downstream deletion paths.

## Key Architectural Decisions

1. **WORM Retention & Immutability (`lib/legal-hold.ts`)**:
   - Holds can specify a retention duration (`retention_until`).
   - When `immutable_worm` is enabled, the hold cannot be released or removed prior to the expiration of the retention clock, throwing `WORM_LOCKED` (mapped to HTTP 423 Locked).

2. **Cascade Enforcement Model**:
   - Holds can be placed directly on targets (`signal`, `collection`, `listing`, `profile`, `wallet`).
   - Placing a hold on a `wallet` automatically cascades preservation to all assets authored or owned by that wallet (e.g. signals, market listings, notifications).

3. **Gated Destructive Operations**:
   - `takedownSignal` & `restoreSignal` in `lib/signal-store.ts`
   - `saveProfile` overwrite in `lib/profile-store.ts`
   - `cancelListing` in `lib/market-store.ts`
   - `markRead` & `markAllRead` in `lib/notification-store.ts`
   - All check `assertNoLegalHold(target_type, target_id, action, owner_wallet)` and fail-closed with `LEGAL_HOLD_ACTIVE`.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_169` / `FEATURE_PHASE_169` or set to `0`. Endpoints return `404`, and operational modification paths bypass the hold gate (zero regression). Stored holds in `legal-holds.json` remain inert on disk.
