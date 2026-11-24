# PHASE Protocol

**AI artifact minting gated by on-chain payment — built on Stellar Soroban with x402.**

PHASE is a decentralized application where every AI-generated NFT requires a verified on-chain payment before it exists. There is no subscription, no custodial API key billing, and no way to receive the AI output without first settling PHASELQ on-chain. The payment is the key.

---

## Why x402

HTTP 402 ("Payment Required") has been reserved since 1996 but never standardized for machine use. The x402 protocol gives it a concrete meaning: a server responds `402` with a structured payment challenge, the client settles on-chain, and the server verifies the ledger proof before releasing the resource.

PHASE uses x402 as the access gate to its AI Oracle. The sequence:

```
Client                          Server                        Stellar Testnet
  │                               │                                │
  ├── POST /api/forge-agent ──────▶│                                │
  │                               │◀── 402 + payment challenge ────│
  │                               │    { amount, token, network }  │
  │                               │                                │
  │◀── 402 Payment Required ──────┤                                │
  │    (challenge embedded)       │                                │
  │                               │                                │
  ├── User signs Stellar tx ──────────────────────────────────────▶│
  │   (PHASELQ transfer)          │                            ledger confirms
  │                               │                                │
  ├── POST /api/forge-agent ──────▶│                                │
  │   { settlementTxHash }        ├── verify hash on RPC ─────────▶│
  │                               │◀── owner confirmed ────────────┤
  │                               │                                │
  │                               ├── Gemini lore generation       │
  │                               ├── Image generation (Nano Banana / Pollinations)
  │                               ├── Seal metadata → IPFS (Pinata)
  │                               ├── create_collection on Soroban ▶│
  │                               ├── initiate_phase on Soroban ───▶│
  │◀── artifact URLs + token_id ──┤                                │
```

The server never issues the AI output speculatively. The Soroban ledger proof is the payment receipt.

---

## NFT Creation Flow

### 1. Collection registration

Before minting, a creator registers a collection on the PHASE Soroban contract (`create_collection`). Multiple collections per wallet are supported — the contract enforces no limit. Each collection stores a price in PHASELQ stroops, the creator's address, and the metadata URI.

### 2. x402 payment challenge

`POST /api/forge-agent` with a prompt (and no payment header) returns:

```json
HTTP 402
{
  "protocol": "x402",
  "network": "stellar:testnet",
  "amount": 50000000,
  "token": "C...",
  "facilitator": "https://.../api/x402"
}
```

The client is expected to sign a Stellar Soroban transaction that transfers the required PHASELQ amount from the user's wallet to the protocol.

### 3. Settlement

The user signs the transaction via Stellar Wallets Kit (Freighter, Albedo, xBull, or any SEP-7 compatible wallet). The signed XDR is submitted to the Soroban RPC. The resulting transaction hash is the settlement proof.

### 4. Oracle unlock

The second `POST /api/forge-agent` includes `settlementTxHash`. The server:

1. Calls `x402-stellar`'s `useFacilitator` to verify the on-chain payment against the challenge
2. Decodes the Soroban event log to confirm the payer address and amount
3. Calls Google Gemini to generate artifact lore based on the user prompt
4. Calls Nano Banana API (or falls back to Pollinations) to generate the artifact image
5. Pins the metadata JSON to IPFS via Pinata
6. Calls `initiate_phase` on the PHASE Soroban contract to mint the NFT with the IPFS URI

### 5. NFT on-chain

The minted token follows SEP-50 draft patterns:

- `owner_of(token_id: u32)` → owner address
- `token_uri(token_id: u32)` → IPFS metadata URI
- `token_metadata(token_id: u32)` → on-chain attribute map

Metadata JSON is SEP-41/50-compatible and readable by wallets and explorers.

---

## Architecture

```
app/
  api/
    forge-agent/     ← x402 AI Oracle (challenge + verify + mint)
    x402/            ← challenge endpoint, facilitator verify, settle
    phase-nft/       ← NFT verify and custodian-release
    wallet/          ← NFT index per wallet (Mercury or RPC fallback)
    faucet/          ← PHASELQ reward distribution (genesis, daily, quests)
    explore/         ← Paginated community NFT gallery
    classic-liq/     ← Classic Horizon asset trustline bootstrap
    soroban-rpc/     ← Proxied RPC with fallback URLs
  forge/             ← Collection creation + Oracle UI
  chamber/           ← Settlement viewer, NFT collect, reward terminal
  dashboard/         ← Collection market, listings, vault
  explore/           ← Community NFT gallery

lib/
  phase-protocol.ts  ← Soroban contract calls, constants, RPC helpers
  classic-liq.ts     ← Classic asset trustline utilities
  mercury-classic.ts ← Mercury indexer integration (optional)
  phase-copy.ts      ← i18n dictionary (EN/ES)
  stellar.ts         ← Horizon helpers, trustline checks

contracts/
  phase-protocol/    ← Soroban Rust NFT + settlement contract
```

### Indexing strategy

Wallet UIs frequently lag on Soroban NFT indexing. PHASE handles this with two modes:

**Mercury Classic (when `MERCURY_JWT` is set):** queries contract events and ledger entries via Mercury's REST API. Resolves ownership in milliseconds.

**RPC fallback:** concurrent `owner_of` scans across token IDs. Slower but fully decentralized — no external indexer dependency.

### Soroban RPC resilience

`/api/soroban-rpc` proxies all Soroban simulation calls through a primary RPC URL with fallback URLs (`STELLAR_RPC_FALLBACK_URLS`). Public testnet RPC has congestion windows; the proxy absorbs 503s transparently.

---

## Contracts

The PHASE protocol contract lives under `contracts/phase-protocol/`. It is a Rust/Soroban WASM contract that implements:

| Function | Description |
|---|---|
| `create_collection(creator, price, uri)` | Registers a collection. Multiple per wallet allowed. |
| `initiate_phase(collection_id, minter, uri)` | Mints an NFT after settlement verification. |
| `owner_of(token_id)` | Returns the current owner of a token. |
| `token_uri(token_id)` | Returns the IPFS metadata URI. |
| `token_metadata(token_id)` | Returns the on-chain attribute map. |
| `get_creator_collection_ids(creator)` | Returns all collection IDs for a given creator (`Vec<u64>`). |
| `get_creator_collection_id(creator)` | Returns the first collection ID (backward compatibility). |
| `get_user_phase(wallet, collection_id)` | Returns the phase token ID minted for a wallet in a collection. |

The fungible token (PHASELQ) is a Stellar Asset Contract (SAC) derived from a Classic asset, making it SEP-41 compatible and accessible via Horizon as well as Soroban.

---

## Tech Stack

| Area | Technology |
|---|---|
| App framework | Next.js (App Router), React 19, TypeScript |
| Styling | Tailwind CSS |
| Chain | Stellar testnet, Soroban WASM contracts (Rust) |
| Payments | x402-stellar, HTTP 402 challenge/verify |
| AI | Google Gemini (lore), Nano Banana API / Pollinations (image) |
| Wallet | @creit.tech/stellar-wallets-kit (Freighter, Albedo, xBull) |
| Indexing | Mercury Classic REST (optional), Soroban RPC fallback |
| Storage | Pinata IPFS, multi-gateway display |
| Stellar SDK | @stellar/stellar-sdk |

---

## Environment

The app reads all contract addresses from environment variables — nothing is hardcoded.

| Variable | Role |
|---|---|
| `NEXT_PUBLIC_PHASE_PROTOCOL_ID` | PHASE NFT/settlement Soroban contract (C…) |
| `NEXT_PUBLIC_PHASER_TOKEN_ID` | PHASELQ SAC contract (C…) |
| `PINATA_JWT` | Server-side IPFS uploads |
| `GOOGLE_AI_STUDIO_API_KEY` | Gemini lore + image generation |
| `MERCURY_JWT` | Optional — fast NFT indexing via Mercury Classic |
| `STELLAR_RPC_URL` | Primary Soroban RPC endpoint |
| `STELLAR_RPC_FALLBACK_URLS` | Comma-separated fallback RPC URLs |
| `ADMIN_SECRET_KEY` | Faucet issuer keypair (mint mode) |
| `FAUCET_DISTRIBUTOR_SECRET_KEY` | Faucet distributor keypair (transfer mode) |

See `.env.local.example` for the full annotated list.

---

## Running locally

```bash
npm install
cp .env.local.example .env.local
# Fill in contract IDs and API keys
npm run dev
```

Contracts are already deployed on Stellar testnet. You do not need to redeploy to run the app — only set the existing contract IDs in your `.env.local`.

**Network:** `Test SDF Network ; September 2015`
**Default RPC:** `https://soroban-testnet.stellar.org`

---

## Flags and flagged adapters

Flags are statically evaluated from `PHASE_FLAG_*` env vars. Each feature owns
one unique ID and one rollback alias in `FLAG_ENV_MAP`; see [`docs/FLAGS.md`](docs/FLAGS.md).
The SEP-50 adapter (`phase-217`), testnet-only EVM bridge (`phase-218`) and
read-only cross-chain verifier (`phase-219`) are documented in
[`docs/FLAGGED_ADAPTERS.md`](docs/FLAGGED_ADAPTERS.md), with root spikes
`SPIKE_645_SEP50_CONFORMANCE.md`, `SPIKE_646_EVM_BRIDGE.md` and
`SPIKE_647_CROSS_CHAIN_VERIFICATION.md`.

```bash
npm run flags:check         # reject duplicate flag IDs/env vars/aliases
npm run drill:kill-switch   # non-destructive kill-switch drill
npm run test                # adapter unit tests
```

---

*PHASE Protocol — pay to forge, prove on-chain.*
