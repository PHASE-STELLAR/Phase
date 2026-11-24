# SPIKE_645 — SEP-50 conformance gaps

**Status:** implemented behind `phase-217` (`PHASE_FLAG_SEP50_ADAPTER`)
**Risk:** High · **Ecosystem:** Stellar / regulated assets

## Findings

- The app's SEP-50 surface is **NFT metadata only** (`owner_of`, `token_uri`,
  `token_metadata`, approvals). There is no adapter for SEP-50 *attestations*
  used by regulated-asset issuers.
- Compliance checks in `PROJECT_ARCHITECTURE.md` §13 were adapter-shaped but
  never wired to an attestation provider.
- No SEP-10 session binding existed, so an attestation could not be tied to an
  authenticated Stellar account.
- Provider outage had no defined response; a failure could be mistaken for a
  negative compliance result.

## Delivered design

- `lib/adapters/sep50/` defines `Sep50Provider`, `Sep10Session`,
  `Sep50Attestation` and a fail-closed `runSep50Check`.
- Discovery → SEP-10 session binding → attestation fetch → signature/expiry/
  issuer/subject verification.
- Subject is stored only as `sha256(account|issuer)` (`subjectHash`); raw
  account, token and claim data are never returned or persisted.
- Outage yields `{ status: "unavailable", retryAfter }`; the API maps this to
  **503 + `Retry-After`**.
- `SEP50MockProvider` is fenced by a static env snapshot and cannot be enabled
  outside testnet.

## Acceptance evidence

| Requirement | Test |
| --- | --- |
| Valid attestation accepted | `tests/sep50.test.ts` → valid attestation |
| Tampered/expired rejected | tampered signature/subject, expired attestation |
| Outage → 503 + Retry-After | provider outage test + `app/api/compliance/sep50/route.ts` |
| No PII persisted | outcome key assertion in valid-attestation test |
| Flag off = disabled | flag-off test (no provider call) |

## Rollback

Unset `PHASE_FLAG_SEP50_ADAPTER`. The adapter is skipped and the route returns
404; no adapter row is written.
