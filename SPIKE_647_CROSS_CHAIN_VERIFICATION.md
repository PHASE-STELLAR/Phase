# Spike 647 — Cross-Chain Message Verification with Stellar Proof Relay

## Objective
Implement generic cross-chain message verification where Stellar is the source-of-truth relay for external proof systems.

## Background
Enable external systems (rollups, sidechains, other L1s) to verify messages/proofs against Stellar's ledger state, establishing Stellar as a canonical witness layer.

## Architecture

### Message Flow
```
External System                 Stellar                    PHASE App
    │                              │                          │
    ├─ Submit proof/attestation ──▶│                          │
    │                          Store in ledger entry           │
    │                              │ (Soroban contract)        │
    │                              │                          │
    │                          Emit verification event        │
    │                              │ emit({ msg_id, proof_hash, status })
    │                              │                          │
    └──────────────────────────────┼──────────────────────────▶│
                                   │    Query proof status     │
                                   │◀──────────────────────────┤
                                   │    return verified | pending
```

### Stellar Verification Contract
1. `submit_proof(msg_id: Bytes32, proof: Bytes, source_chain: String) -> Result<()>`
2. `verify_proof(msg_id: Bytes32) -> ProofStatus` (enum: Pending, Verified, Failed)
3. `get_proof(msg_id: Bytes32) -> Proof { data, source_chain, timestamp }`
4. Event: `ProofSubmitted { msg_id, source_chain, timestamp }`
5. Event: `ProofVerified { msg_id, result: bool }`

### Verification Logic
- Multi-sig validator approval (3-of-5 threshold)
- Merkle proof validation against external headers
- Timestamp and nonce replay protection
- Configurable per-chain verification rules

### Integration Points
- **PHASE App**: Query `/api/verify-proof?msg_id=...` to check status
- **External Systems**: Call Soroban contract directly or via relay adapter
- **Validators**: Monitor events and sign off on proofs

## Data Structure
```rust
#[contracttype]
pub struct Proof {
    pub id: Bytes32,
    pub source_chain: String,
    pub data: Bytes,
    pub signatures: Vec<Bytes>,
    pub verified_at: u64,
    pub status: ProofStatus,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ProofStatus {
    Pending = 0,
    Verified = 1,
    Failed = 2,
}
```

## Success Criteria
- [ ] Verification contract interface defined
- [ ] Multi-sig validator logic designed
- [ ] Replay protection spec finalized
- [ ] API integration points documented
- [ ] Test strategy outlined
