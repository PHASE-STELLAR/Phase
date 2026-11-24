# Spike 645 — Soroban SEP-50 Full Conformance Checklist + CI Suite

## Objective
Ensure the PHASE Soroban contract fully complies with SEP-50 (Stellar Enhancement Proposal 50) NFT standard, with automated conformance tests in CI.

## Current State
- Contract implements basic owner_of, token_uri, token_metadata
- No formal SEP-50 conformance audit
- No automated compliance verification in CI

## Required Compliance
SEP-50 specifies:
1. `owner_of(token_id: u32) -> Address`
2. `token_uri(token_id: u32) -> String`
3. `token_metadata(token_id: u32) -> Map<String, String>`
4. Metadata MUST include: "name", "description", "image", "mime_type", "properties"
5. Event emission: creation, transfer, burn (if applicable)
6. No metadata mutation (immutable URIs after creation)

## Implementation Plan
1. **Audit existing contract** (contracts/phase-protocol/src/lib.rs)
   - Verify all 3 main read functions
   - Check metadata structure completeness
   
2. **Add conformance tests**
   - Create tests/conformance-sep50.rs
   - Test each SEP-50 requirement
   - Validate metadata JSON structure
   
3. **CI integration**
   - Add GitHub Actions workflow for conformance suite
   - Block merge if conformance fails

## Success Criteria
- [ ] All SEP-50 requirements documented
- [ ] Contract passes conformance test suite
- [ ] CI workflow enforces conformance
- [ ] Metadata compliance documented in PROJECT_ARCHITECTURE.md

## Attestation conformance (flag `phase-217`)

This spike owns the Soroban NFT-interface checklist above. The separate
regulated-asset / SEP-10-attestation scope is implemented behind
`PHASE_FLAG_SEP50_ADAPTER` in `lib/adapters/sep50/`:

- discovery → SEP-10 session binding → attestation verification;
- hashed subjects only (`sha256(account|issuer)`), no PII persisted;
- tampered/expired attestations rejected;
- provider outage fails closed with `503` + `Retry-After`;
- testnet mock provider fenced by a static network snapshot.

Operational details: `docs/FLAGGED_ADAPTERS.md`. Evidence:
`tests/sep50.test.ts`. Rollback: unset the flag — checks are skipped.
