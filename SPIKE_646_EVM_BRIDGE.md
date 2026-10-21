# Spike 646 — EVM Bridge Design with Lock/Mint + Attestations

## Objective
Design (spike only) an EVM ↔ Stellar bridge for PHASE NFTs with lock/mint mechanics and cryptographic attestations.

## Background
PHASE currently lives on Stellar Soroban. This spike explores cross-chain interoperability with EVM chains (Ethereum, Polygon, etc.) while maintaining Stellar as the source of truth.

## Architecture
### Lock/Mint Model
- **Lock (Stellar → EVM)**: User locks NFT on Stellar, bridge mints a wrapped token on EVM
- **Mint (EVM → Stellar)**: Wrapped token burnt on EVM, bridge releases original NFT on Stellar
- Stellar contract holds escrow for locked NFTs
- EVM contract (new) mints wrapped ERC-721 on release

### Attestations
- Bridge validators sign lock/mint events
- Multi-signature threshold (e.g., 3-of-5) for release
- Attestations stored on-chain (Stellar events, EVM state)
- Merkle proofs for header inclusion in cross-chain verify

## Stellar Contract Changes
1. New `lock_for_bridge(token_id, evm_chain) -> escrow_id`
2. New `release_locked(token_id, attestations) -> ()`
3. Event: `BridgeLocked { token_id, evm_chain, escrow_id }`
4. Event: `BridgeReleased { token_id, escrow_id }`

## EVM Contract (Research Phase)
- Wrapping contract for ERC-721 representation
- Attestation verification logic
- Burn/release trigger

## Security Considerations
- Validator key rotation mechanism
- Replay attack prevention (chain ID, nonce)
- Escrow timeout (auto-release after N blocks)
- Bridge pause/unpause admin controls

## Success Criteria
- [ ] Architecture document approved
- [ ] Validator set finalized
- [ ] Stellar contract interface sketched
- [ ] EVM contract pattern identified
- [ ] No code changes (spike = design only)
