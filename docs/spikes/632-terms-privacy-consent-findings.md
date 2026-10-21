# Spike 632: Terms-of-Service and Privacy-Policy Consent Flows with Versioning

**Issue**: #495
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-166` (`NEXT_PUBLIC_FEATURE_PHASE_166` / `FEATURE_PHASE_166`)
**Sidecars**: `terms-consents.json`, `legal-documents.json`

## Context & Motivation

Prior to this spike, PHASE lacked formal terms-of-service and privacy-policy documents, version tracking, and user consent records. Profile creation and updates were unguarded by legal consent, while UI localization systems lacked legal domain terminology—specifically causing layout and modal truncation issues when Spanish translations expanded ~20% beyond English baseline lengths.

## Architecture

1. **Document Canonicalization & Hash Pinning**:
   - Legal documents are defined with immutable semantic version tags (`CURRENT_TOS_VERSION`, `CURRENT_PRIVACY_VERSION`).
   - Each canonical document's content is pinned by a deterministic SHA-256 digest. Consent submissions verify both version string and content digest before ledgering.

2. **Acceptance Ledger**:
   - Stored in `.data/terms-consents.json` via atomic file locking (`lib/json-store.ts`).
   - Records wallet, accepted versions, content hashes, timestamps, and client metadata.

3. **Gated Write Paths**:
   - `app/api/profile/route.ts` rejects unconsented updates with `451 CONSENT_REQUIRED`, indicating pending documents.
   - `GET /api/profile` surfaces consent state alongside public profile fields.

4. **Localization Expansion Resilience**:
   - `lib/copy/legal-copy.ts` provides complete English and Spanish dictionaries.
   - `ConsentModal.tsx` handles ~20% character expansion with responsive layouts, min-height boundaries, and scrolling review containers.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_166` / `FEATURE_PHASE_166` or set to `0`. Endpoints return `404` or bypass gates, and recorded consent ledgers remain inert on disk.
