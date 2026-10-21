# Spike 648 — Stellar Expert & Explorer Deep-Linking + Verification Badges

## Objective
Integrate PHASE NFTs with Stellar's ecosystem explorers (Stellar Expert, Soroban Explorer) with deep-links and on-chain verification badges.

## Background
PHASE NFTs currently live on Stellar Soroban but lack discoverable links in community explorers. This spike adds:
1. Deep-linking support for NFT metadata URLs
2. Verification badges on explorer displays
3. Rich metadata rendering in explorer contexts

## Integration Points

### 1. Stellar Expert Integration
- **Deep-link format**: `https://stellar.expert/explorer/testnet/contract/{CONTRACT_ID}`
- **Metadata enrichment**: Return `SEP-50-Link` header pointing to PHASE explorer
- **Verification badge**: Signed issuer metadata on-chain

### 2. NFT Metadata Enrichment
```json
{
  "name": "Artifact #1",
  "description": "AI-generated artifact",
  "image": "ipfs://...",
  "verified": true,
  "issuer": "PHASE_CONTRACT_ID",
  "attributes": {
    "rarity": "rare",
    "collection": "genesis",
    "creator_verified": true
  },
  "external_url": "https://phase.app/nft/TOKEN_ID",
  "links": {
    "stellar_expert": "https://stellar.expert/explorer/testnet/contract/{CONTRACT_ID}",
    "soroban_explorer": "https://stellar-viewer.app/contract/{CONTRACT_ID}"
  }
}
```

### 3. Verification Badge Mechanism
- **Issuer signature**: Contract-signed metadata proof
- **Badge display**: Explorer checks `/verify-issuer/{token_id}` endpoint
- **Revocation path**: Contract admin can sign revocation event

### 4. Explorer Contract Metadata
Store on-chain via Soroban:
```rust
#[contracttype]
pub struct ExplorerMetadata {
    pub verified_issuer: Address,
    pub collection_name: String,
    pub creator: Address,
    pub created_at: u64,
    pub external_url: String,
}

pub fn set_explorer_metadata(
    env: Env,
    caller: Address,
    collection_id: u64,
    metadata: ExplorerMetadata
) -> Result<(), Error>
```

## Frontend Changes
1. **NFT detail page** (`app/nft/[id]/page.tsx`): 
   - Render verification badge if `verified: true` in metadata
   - Add "View on Stellar Expert" deep-link button
   
2. **Explore page** (`app/explore/page.tsx`):
   - Display verified badge next to artist name
   - Link to Stellar Expert for each collection

3. **API endpoint** (`app/api/nft-verify.ts`):
   - Return verification status for explorer query
   - Format: `{ verified: bool, issuer: Address, signed_at: u64 }`

## Success Criteria
- [ ] Stellar Expert deep-link format confirmed
- [ ] Explorer metadata contract interface defined
- [ ] Verification badge design finalized
- [ ] Frontend integration points identified
- [ ] Sample metadata with badges generated
