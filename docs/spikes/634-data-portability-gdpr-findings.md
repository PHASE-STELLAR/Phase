# Spike 634: Data Portability Export per Wallet with GDPR Article 20 Bundle

**Issue**: #496
**Type**: Advanced Integration Spike
**Feature Flag**: `phase-167` (`NEXT_PUBLIC_FEATURE_PHASE_167` / `FEATURE_PHASE_167`)
**Precedents Analyzed**: Follow-graph checksummed export (phase-95), world markdown/JSON export (phase-112)

## Context & Motivation

Phase previously maintained disconnected export mechanisms: single-domain follow-graph export (phase-95) and world narrative export (phase-112). User data was scattered across disparate stores (JSON sidecars for profile, follows, notifications, market offers; SQLite WAL tables for signals, replies, and reactions; legal-consent ledgers). There was no unified cross-domain portability bundle, no cryptographic manifest, no Content-Disposition headers for direct user download, and crucially no third-party PII redaction for shared threads/replies/offers.

## Key Architectural Decisions

1. **Unified Cross-Domain Aggregator (`lib/data-portability.ts`)**:
   - Collects records across seven domains: `profile`, `follows`, `notifications`, `market`, `signals`, `badges`, and `consents`.
   - Computes deterministic SHA-256 digests for each domain individually, plus an aggregate `bundle_checksum` in a top-level manifest.

2. **Third-Party PII Redaction Engine**:
   - GDPR Article 20 requires that the exercise of data portability "shall not adversely affect the rights and freedoms of others".
   - When exporting conversations, thread replies, offers, and notifications, third-party wallet addresses (`G...`) are automatically detected and replaced with pseudonymized identifiers `[REDACTED_THIRD_PARTY_WALLET]`, while the requesting user's own wallet is preserved intact.
   - Any sensitive keys matching Stellar secret key patterns (`S...`) are scrubbed as `[REDACTED_SECRET]`.

3. **HTTP Streaming & Content-Disposition**:
   - `GET /api/user/export` and `GET /api/profile/export` stream the bundle directly to the client with `Content-Disposition: attachment; filename="phase-data-export-${wallet}-${ts}.json"`.
   - The aggregate checksum is mirrored in the `X-Portability-Checksum` response header.

4. **Integrity Verification**:
   - Provides a client/server verifier (`verifyPortabilityBundle`) that validates domain and bundle hashes against actual data payloads to guarantee data integrity against tampering.

## Rollback

Unset `NEXT_PUBLIC_FEATURE_PHASE_167` / `FEATURE_PHASE_167` or set to `0`. Export routes return `404`, and no persistent migrations require reversal.
