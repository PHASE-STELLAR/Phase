# PHASE Project Architecture

This document defines the architecture baseline for PHASE and is the primary reference for implementation decisions, reviews, and refactors.

## 1) Scope and intent

PHASE is a testnet system composed of:

- **Client application** (Next.js) for forge, dashboard, and chamber UX.
- **API layer** (Next.js route handlers) for reward distribution, trustline relay, x402 support, and profile/listing persistence.
- **On-chain contracts** (Soroban) for protocol state and token interactions.
- **Wallet signing boundary** (Freighter) for user-authorized transactions.

The architecture is designed to keep signing on the client while keeping privileged operations on the server.

## 2) High-level component map

```mermaid
flowchart LR
  UI[Next.js App UI] --> Wallet[Freighter]
  UI --> BFF[Next.js API Routes]
  UI --> ChainRead[lib/phase-protocol.ts]
  ChainRead --> RPC[Soroban RPC]
  ChainRead --> HZ[Horizon]
  BFF --> RPC
  BFF --> HZ
  BFF --> Store[(JSON data store)]
  Contracts[phase-protocol WASM + token WASM] --> RPC
```

## 3) Runtime boundaries

### 3.1 Client boundary

Owns:

- Wallet connection and signature prompts.
- Interactive state, tactical UI, i18n rendering.
- Read-only on-chain queries (when safe via SDK simulation helpers).

Must not own:

- Admin secrets.
- Issuer secret for classic bootstrap.
- Persistent trusted state decisions.

### 3.2 Server boundary

Owns:

- Reward minting with admin credentials.
- Trustline submit relay endpoint (for signed XDR).
- Persistent JSON data (`faucet claims`, `artist profile`, `listings`) through `lib/server-data-paths.ts`.
- x402 endpoints and payment verification support.

Must not own:

- User private keys.

### 3.3 On-chain boundary

Owns:

- Canonical protocol state (`collection`, `phase`, utility-NFT ownership, settlement effects).
- Token balances and transfer semantics according to deployed contracts.

## 4) Principal user flows

### 4.1 Forge flow

1. User connects wallet.
2. Optional trustline bootstrap is established where applicable.
3. User submits collection metadata and price.
4. Client builds Soroban tx and asks Freighter signature.
5. Tx is sent and confirmed; collection ID is resolved.

### 4.2 Chamber settlement flow

1. Client fetches wallet state and collection price.
2. User executes settlement action.
3. Client signs and submits transaction.
4. On success, chamber refreshes artifact and ownership state.

### 4.3 Rewards flow

1. Client queries `/api/faucet` status.
2. If classic trustline is required, user signs `changeTrust`.
3. Client submits signed trustline to `/api/classic-liq/trustline`.
4. Client calls reward claim endpoint (`/api/faucet` or compatibility route).
5. Server mints reward when conditions are met.

## 5) API architecture principles

- **Typed contracts** for request/response payloads in route handlers.
- **Deterministic status codes** (validation, cooldown, authorization, pending).
- **No implicit success**: all state transitions explicit and auditable.
- **Compatibility routes** allowed if typed and documented.

## 6) Internationalization architecture

- UI strings belong to `lib/phase-copy.ts`.
- Components consume text via `pickCopy(lang)` and must avoid hardcoded user-facing literals.
- New features require EN/ES keys before merge.

## 7) Error-handling architecture

- Domain-level error normalization is required before UI messaging.
- Unauthorized on-chain gate errors (`#13`) map to narrative tactical message:
  - `[ ERROR: BIOMETRIC_TRUST_GATE_CLOSED ]`
- User-facing failures should remain actionable and non-ambiguous.

## 8) Performance architecture (UI)

- Tactical animation classes use GPU compositing hints where flicker/pulse is intentional.
- Keep animations isolated to key controls; avoid broad repaint cascades.
- Prefer CSS primitives and avoid JS-driven animation loops unless required for state logic.

## 9) Security architecture

- Secrets only in server runtime configuration.
- `.env.local` and sensitive keys are never committed.
- Testnet-only assumptions must be explicit in docs and code comments.
- Any privileged operation must validate input shape and origin intent.

## 10) Change-management rules

- Architectural changes require updates to:
  - `PROJECT_ARCHITECTURE.md` (this file)
  - `docs/TECHNICAL.md`
  - relevant API docs
- Contract/address changes require synchronized env and docs updates.

## 11) Feature-flag architecture

- Flags live in `lib/flags/registry.ts`. Every feature owns exactly one
  canonical ID and exactly one env var (`PHASE_FLAG_*`).
- IDs `phase-170`…`phase-173` were historically reused for two features each.
  The second feature now owns a unique ID (`phase-180`…`phase-183`); the old
  ambiguous tokens remain **aliases** in `FLAG_ENV_MAP` so a rollback can be
  performed without renaming call sites. See `docs/FLAGS.md`.
- Flags are evaluated **statically** from a frozen snapshot taken at module
  load. Runtime mutation of `process.env` never changes a flag.
- `scripts/check-flags.ts` (`npm run flags:check`) fails CI on duplicate IDs,
  env vars or aliases. `.github/workflows/flag-integrity.yml` runs it on every
  PR and push.
- Ops kill switch (`PHASE_OPS_KILL_SWITCH`) is likewise a static snapshot. The
  non-destructive drill (`npm run drill:kill-switch`) proves distributor
  auto-refill halt and `faucetPending` mid-poll idempotency without touching
  network, secrets or chain state.

## 12) Adapter boundaries

- `lib/adapters/sep50/` — SEP-50 attestation verification, SEP-10 session
  binding, hashed subjects only, fail-closed 503 + `Retry-After`, testnet mock
  fence. Behind `phase-217`.
- `lib/adapters/bridge/` — PHASELQ → EVM bridge. Client-side signing for the
  Stellar leg, server-side custody for the EVM leg, idempotent relay keyed by
  source tx hash, configurable finality, orphan recovery, drift/fee fences.
  Testnet only, behind `phase-218`. See `SPIKE_646_EVM_BRIDGE.md`.
- `lib/adapters/crosschain/` — read-only light-client-style proof verifier with
  trust-root, staleness and wrong-network fences. Behind `phase-219`.
- Every adapter returns a disabled/inert result when its flag is off; no
  adapter performs writes on the Stellar leg.

## 13) Compliance and integration registry

| Feature | Flag ID | Env var | Rollback |
| --- | --- | --- | --- |
| SEP-50 attestation adapter | `phase-217` | `PHASE_FLAG_SEP50_ADAPTER` | Unset flag — checks skipped, route 404 |
| PHASELQ EVM bridge | `phase-218` | `PHASE_FLAG_EVM_BRIDGE` | Unset flag — routes gone, locked funds recoverable |
| Cross-chain verifier | `phase-219` | `PHASE_FLAG_CROSSCHAIN_VERIFY` | Unset flag — verification skipped |

Root spikes: `SPIKE_645_SEP50_CONFORMANCE.md`, `SPIKE_646_EVM_BRIDGE.md`,
`SPIKE_647_CROSS_CHAIN_VERIFICATION.md`. Operational details and the complete
flag table (including the renamed legacy IDs) are in `docs/FLAGS.md` and
`docs/FLAGGED_ADAPTERS.md`.
