# SPIKE_647 — Cross-chain state verification

**Status:** implemented behind `phase-219` (`PHASE_FLAG_CROSSCHAIN_VERIFY`)
**Risk:** High · **Authority:** read-only

## Findings

- PHASE trusted single-chain reads with no proof verification.
- No trust-root configuration, header staleness check or wrong-network fence
  existed.

## Delivered design

- `lib/adapters/crosschain/` provides a light-client-style `verifyProof` over a
  `StateProof` (chain header + sibling path + claimed root).
- `VerifierConfig` carries `TrustRoot` (chain, network, root hash, validity
  window) and `maxHeaderAgeMs`.
- Header hash and Merkle root are recomputed; tampered values are rejected.
- Wrong network, wrong chain, stale and future headers are rejected before any
  proof work is performed.
- The verifier accepts no write handle and returns only an observation
  (`key`, `value`, `height`). `VerificationCounters` uses private backing
  fields; no reset path exists.
- Flag off returns `{ status: "disabled" }` without touching counters.

## Acceptance evidence

| Requirement | Test (`tests/crosschain.test.ts`) |
| --- | --- |
| Valid proof accepted, tampered rejected | valid proof / tampered value tests |
| Wrong-network and stale header rejected | wrong network / stale tests |
| No write authority | read-only output key assertion |
| Closed counters | monotonic counter test |
| Flag off = verifier disabled | flag-off test |

## Rollback

Unset `PHASE_FLAG_CROSSCHAIN_VERIFY`. Verification is skipped and no counters
are touched.
